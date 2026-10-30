/* 题库与账号接口 · action 分发
   路径沿用 /functions/v1/app，所以 Qoder 站点那套前端调用方式不用换。
   与冻结的 functions/handler.mjs 相比，这里是自建部署的唯一实现，差异有三处：
   1. 身份来自会话 Cookie（或 curl 用的 HTTP Basic），不是网关注入的用户上下文；
   2. 权限看 app_users.role，不再是 site_settings 里的单一所有者；
   3. 多了 login / logout / register / session / progress / upload 六个动作；
   4. 注册要凭管理员发的一次性邀请码（invite_codes），并带来源 IP 的失败限流。 */

import {
  AppError, idOf, parseBody, questionRow, chapterRow, cardRow,
  usernameOf, passwordOf, displayNameOf, progressData, inviteNoteOf,
} from './validate.mjs';
import { MAX_READ_ROWS } from './db.mjs';
import {
  hashPassword, verifyPassword, newUserId, newInviteCode, normalizeInviteCode,
} from './auth.mjs';

const MAX_SYNC_RECORDS = 2000;
const CHUNK = 200;
// 后台新增且未显式给排序值时，排在内置内容之后。
const NEW_SORT_ORDER = 9000;
const MAX_INVITES = 500;

const METHODS = {
  bank: 'GET',
  session: 'GET',
  progress: ['GET', 'POST'],
  login: 'POST',
  logout: 'POST',
  register: 'POST',
  'upsert-question': 'POST', 'delete-question': 'POST',
  'upsert-chapter': 'POST', 'delete-chapter': 'POST',
  'upsert-card': 'POST', 'delete-card': 'POST',
  'sync-builtin': 'POST',
  'list-invites': 'GET', 'create-invite': 'POST', 'delete-invite': 'POST',
  upload: 'POST',
};

const TABLE_OF = {
  'delete-question': 'questions', 'upsert-question': 'questions',
  'delete-chapter': 'syllabus_chapters', 'upsert-chapter': 'syllabus_chapters',
  'delete-card': 'cards', 'upsert-card': 'cards',
};

const json = (body, status = 200, headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  body,
});

function fail(e) {
  if (e instanceof AppError) {
    return json({ error: e.code, ...(e.field ? { field: e.field } : {}) }, e.status);
  }
  // 不把驱动报错原文、连接串或 SQL 细节回给浏览器。
  return json({ error: 'database_request_failed' }, 503);
}

function requireUser(ctx) {
  if (!ctx.user) throw new AppError('login_required', 401);
  return ctx.user;
}

function requireAdmin(ctx) {
  const user = requireUser(ctx);
  if (user.role !== 'admin') throw new AppError('not_admin', 403);
  return user;
}

// 回给浏览器的用户信息：绝不带 pass_hash。
const publicUser = (u) => ({
  id: u.user_id,
  username: u.username,
  name: u.display_name || u.username,
  role: u.role,
});

// 用户不存在时也跑一次等量的 scrypt，否则响应耗时能直接量出用户名对不对。
let dummyHash = null;
async function rejectWithoutUser(password) {
  if (dummyHash === null) dummyHash = await hashPassword(newUserId());
  await verifyPassword(password, dummyHash);
  return false;
}

/* 注册按来源 IP 记失败次数。只记失败，成功一次就清零：
   一个宿舍/一间机房共用出口 NAT 时，老老实实拿码注册的人不该互相拖累，
   而猜码的人只会留下失败。进程内计数、重启清零，够用——
   它的目的只是让「猜码」在经济上不划算，不是挡分布式攻击。 */
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const REGISTER_MAX_FAILS = 20;
const registerFails = new Map();      // ip -> { n, resetAt }

function noteRegisterFail(ip) {
  if (!ip) return false;             // 拿不到来源就放行，别把整站锁死
  const now = Date.now();
  if (registerFails.size > 5000) {
    registerFails.forEach((v, k) => { if (v.resetAt <= now) registerFails.delete(k); });
  }
  const cur = registerFails.get(ip);
  if (!cur || cur.resetAt <= now) {
    registerFails.set(ip, { n: 1, resetAt: now + REGISTER_WINDOW_MS });
    return false;
  }
  cur.n += 1;
  return cur.n > REGISTER_MAX_FAILS;
}

function registerLimited(ip) {
  if (!ip) return false;
  const cur = registerFails.get(ip);
  return !!cur && cur.n > REGISTER_MAX_FAILS;
}

// 只插不改：重新灌入内置内容时不能覆盖后台后来做过的编辑。
async function syncTable(db, table, records, now) {
  if (!Array.isArray(records)) throw new AppError('invalid_field', 400, table);
  if (records.length > MAX_SYNC_RECORDS) throw new AppError('too_many_records', 400, table);
  const seen = new Map();
  records.forEach((row, index) => {
    seen.set(row.id, { ...row, sort_order: row.sort_order === null ? index : row.sort_order });
  });
  const rows = [...seen.values()];
  const present = await db.existingIds(table, rows.map((row) => row.id));
  const missing = rows.filter((row) => !present.has(row.id));
  let inserted = 0;
  let failed = 0;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const part = missing.slice(i, i + CHUNK)
      // 迁移种子会带上原库的 built_in 标记；前端「一键上传」不带，按内置处理。
      .map((row) => ({
        ...row,
        built_in: typeof row.built_in === 'boolean' ? row.built_in : true,
        created_at: now,
        updated_at: now,
      }));
    try {
      inserted += await db.insertMany(table, part);
    } catch {
      failed += part.length;
    }
  }
  return {
    table,
    inserted,
    skipped: rows.length - missing.length,
    failed,
    duplicateIds: records.length - rows.length,
  };
}

// 读一次再分支，避免后台编辑悄悄改掉 built_in，或漏传 sort_order 时把行挪到最前。
async function upsertRow(db, table, row, now) {
  const existing = await db.findMeta(table, row.id);
  const order = row.sort_order === null
    ? (existing ? existing.sort_order : NEW_SORT_ORDER)
    : row.sort_order;
  const fields = { ...row, sort_order: order };
  if (existing) {
    const updated = await db.updateOne(table, row.id, { ...fields, updated_at: now });
    if (!updated) throw new AppError('write_rejected', 503);
    return { id: row.id, built_in: existing.built_in, created: false };
  }
  const result = await db.insertOne(table, { ...fields, built_in: false, created_at: now, updated_at: now });
  if (!result.inserted) throw new AppError('duplicate_id', 409);
  return { id: row.id, built_in: false, created: true };
}

async function readBank(db) {
  const [questions, chapters, cards] = await Promise.all([
    db.list('questions'), db.list('syllabus_chapters'), db.list('cards'),
  ]);
  return {
    questions,
    chapters,
    cards,
    truncated: questions.length >= MAX_READ_ROWS
      || chapters.length >= MAX_READ_ROWS
      || cards.length >= MAX_READ_ROWS,
  };
}

async function handleLogin(ctx, db, auth) {
  const body = parseBody(ctx.bodyText);
  const username = usernameOf(body.username);
  const password = passwordOf(body.password);
  const row = await db.findUserByUsername(username);
  const ok = row ? await verifyPassword(password, row.pass_hash) : await rejectWithoutUser(password);
  // 口令错和用户不存在回同一个错误码，前端也就不必区分。
  if (!ok) return json({ error: 'bad_credentials' }, 401);
  return json({ loggedIn: true, user: publicUser(row) }, 200, {
    'set-cookie': auth.setCookieHeader(auth.signSession(row.user_id), ctx.secure),
  });
}

async function handleRegister(ctx, db, auth) {
  if (registerLimited(ctx.ip)) throw new AppError('too_many_trials', 429);
  const body = parseBody(ctx.bodyText);
  const username = usernameOf(body.username);
  const password = passwordOf(body.password);
  const displayName = displayNameOf(body.display_name);

  // 注册不再是开放的：必须带一个管理员发出去、还没被用过的码。
  const code = normalizeInviteCode(body.invite);
  if (!code) { noteRegisterFail(ctx.ip); return json({ error: 'invite_needed', field: 'invite' }, 400); }

  // 管理员用户名是 .env 指定的，不能被注册抢走，否则真正的管理员再也登不进来。
  if (auth.isReserved(username)) return json({ error: 'username_taken', field: 'username' }, 409);
  // 先查一次占用，否则用户名撞车会把一个好码白白烧掉（claim 是不可逆的）。
  if (await db.findUserByUsername(username)) return json({ error: 'username_taken', field: 'username' }, 409);

  const invite = await db.findInvite(code);
  if (!invite) { noteRegisterFail(ctx.ip); return json({ error: 'invite_invalid', field: 'invite' }, 400); }
  if (invite.used_at) { noteRegisterFail(ctx.ip); return json({ error: 'invite_used', field: 'invite' }, 409); }

  const userId = newUserId();
  const now = new Date().toISOString();
  const inserted = await db.insertUser({
    user_id: userId,
    username,
    pass_hash: await hashPassword(password),
    role: 'user',
    display_name: displayName,
    created_at: now,
    updated_at: now,
  });
  if (!inserted) return json({ error: 'username_taken', field: 'username' }, 409);

  // 码到现在还是活的：并发下可能被另一个请求先claim走。这时必须把刚建好的账号收回，
  // 不然会留下一个「没有对应邀请码」的用户。
  if (!await db.claimInvite(code, userId, now)) {
    await db.deleteUser(userId);
    noteRegisterFail(ctx.ip);
    return json({ error: 'invite_used', field: 'invite' }, 409);
  }
  registerFails.delete(ctx.ip);

  const row = { user_id: userId, username, role: 'user', display_name: displayName };
  return json({ loggedIn: true, user: publicUser(row) }, 200, {
    'set-cookie': auth.setCookieHeader(auth.signSession(userId), ctx.secure),
  });
}

async function handleProgress(ctx, db) {
  const user = requireUser(ctx);
  if (ctx.method === 'GET') {
    const row = await db.getProgress(user.user_id);
    return json({
      data: row ? row.data : null,
      updated_at: row ? new Date(row.updated_at).toISOString() : null,
    });
  }
  const data = progressData(parseBody(ctx.bodyText));
  const now = new Date().toISOString();
  if (!await db.putProgress(user.user_id, data, now)) throw new AppError('write_rejected', 503);
  return json({ updated_at: now });
}

export async function handleBank(ctx, db, auth, media = null) {
  let action = '';
  try { action = new URL(ctx.url, 'http://internal').searchParams.get('action') || ''; } catch { action = ''; }

  const allowed = METHODS[action];
  if (!allowed) return json({ error: 'not_found' }, 404);
  const allowedList = Array.isArray(allowed) ? allowed : [allowed];
  if (!allowedList.includes(ctx.method)) {
    return json({ error: 'method_not_allowed' }, 405, { allow: allowedList.join(', ') });
  }

  try {
    if (action === 'bank') return json(await readBank(db));
    if (action === 'session') {
      return json({ loggedIn: !!ctx.user, user: ctx.user ? publicUser(ctx.user) : null });
    }
    if (action === 'login') return await handleLogin(ctx, db, auth);
    if (action === 'register') return await handleRegister(ctx, db, auth);
    if (action === 'logout') {
      return json({ loggedIn: false, user: null }, 200, {
        'set-cookie': auth.clearCookieHeader(ctx.secure),
      });
    }
    if (action === 'progress') return await handleProgress(ctx, db);

    const now = new Date().toISOString();

    // 内容写入只有管理员能做；bank 的读取是公开的，浏览不需要登录。
    requireAdmin(ctx);

    if (action === 'list-invites') {
      const rows = await db.listInvites(MAX_INVITES);
      return json({
        invites: rows.map((r) => ({
          code: r.code,
          note: r.note || '',
          created_at: new Date(r.created_at).toISOString(),
          used_at: r.used_at ? new Date(r.used_at).toISOString() : null,
          // 用完之后账号又被删掉时，join 出来的用户名是空的，但 used_at 仍然说明这个码被消费过。
          used_by: r.used_by || '',
        })),
        truncated: rows.length === MAX_INVITES,
      });
    }

    if (action === 'create-invite') {
      const note = inviteNoteOf(parseBody(ctx.bodyText).note);
      // 2^40 的空间里撞键基本不可能，但它是主键，撞了不能让请求变成 500，重取一次即可。
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = newInviteCode();
        if (await db.insertInvite({ code, note, created_by: ctx.user.user_id, created_at: now })) {
          return json({ code, note });
        }
      }
      throw new AppError('invite_generate_failed', 503);
    }

    if (action === 'delete-invite') {
      // 作废就是删行：未用过的码消失，已用过的码也只是一条记录被清掉，
      // 不会反过来把那个已注册的账号删了（账号删除走 app_users 那边）。
      const code = normalizeInviteCode(parseBody(ctx.bodyText).code);
      if (!code) throw new AppError('invalid_field', 400, 'code');
      if (!await db.deleteInvite(code)) return json({ error: 'not_found' }, 404);
      return json({ code, revoked: true });
    }

    if (action === 'upload') {
      // MEDIA_DIR 没配就是没打算存图，明确说清是不可用而不是静默失败。
      if (!media) throw new AppError('upload_unavailable', 503);
      const body = parseBody(ctx.bodyText);
      try {
        return json({ url: await media.save(body.data) });
      } catch (e) {
        // 落盘失败（没权限、磁盘满）不是数据库问题，别回 database_request_failed 误导人。
        if (e instanceof AppError) throw e;
        console.error('图片写入失败:', e instanceof Error ? e.message : e);
        throw new AppError('upload_failed', 503);
      }
    }

    if (action.startsWith('delete-')) {
      const body = parseBody(ctx.bodyText);
      const id = idOf(body.id);
      const deleted = await db.deleteOne(TABLE_OF[action], id);
      if (!deleted) return json({ error: 'not_found' }, 404);
      return json({ id, deleted: true });
    }

    if (action.startsWith('upsert-')) {
      const body = parseBody(ctx.bodyText);
      const table = TABLE_OF[action];
      const row = action === 'upsert-question' ? questionRow(body)
        : action === 'upsert-chapter' ? chapterRow(body)
          : cardRow(body);
      return json(await upsertRow(db, table, row, now));
    }

    const body = parseBody(ctx.bodyText);
    const results = [];
    if (body.questions !== undefined) {
      results.push(await syncTable(db, 'questions', body.questions.map(questionRow), now));
    }
    if (body.chapters !== undefined) {
      results.push(await syncTable(db, 'syllabus_chapters', body.chapters.map(chapterRow), now));
    }
    if (body.cards !== undefined) {
      results.push(await syncTable(db, 'cards', body.cards.map(cardRow), now));
    }
    if (!results.length) throw new AppError('invalid_request', 400);
    return json({ results, incomplete: results.some((item) => item.failed > 0) });
  } catch (e) {
    return fail(e);
  }
}

export { syncTable };

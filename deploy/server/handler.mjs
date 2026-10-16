/* 题库接口 · action 分发
   路径、动作名与错误码沿用 Qoder 站点上 functions/handler.mjs 的契约，
   因此前端 web/api.js 一行都不用改。区别只有两处：
   1. 身份来自 HTTP Basic（见 auth.mjs），不再是网关注入的用户上下文；
   2. 数据访问走 db.mjs 的 PostgreSQL 实现，不再是 supabase-js。 */

import { AppError, idOf, parseBody, questionRow, chapterRow, cardRow } from './validate.mjs';
import { MAX_READ_ROWS } from './db.mjs';

const MAX_SYNC_RECORDS = 2000;
const CHUNK = 200;
// 后台新增且未显式给排序值时，排在内置内容之后。
const NEW_SORT_ORDER = 9000;

const GET_ACTIONS = new Set(['bank', 'owner']);
const POST_ACTIONS = new Set([
  'claim-owner',
  'upsert-question', 'delete-question',
  'upsert-chapter', 'delete-chapter',
  'upsert-card', 'delete-card',
  'sync-builtin',
]);

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

const dbFail = () => { throw new AppError('database_request_failed', 503); };

function requireUser(ctx) {
  if (!ctx.user) throw new AppError('login_required', 401);
  return ctx.user;
}

async function requireOwner(ctx, db) {
  const user = requireUser(ctx);
  const row = await db.getOwner();
  if (!row) throw new AppError('owner_not_claimed', 409);
  if (row.owner_id !== user.user_id) throw new AppError('not_owner', 403);
  return user;
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

export async function handleBank(ctx, db) {
  let action = '';
  try { action = new URL(ctx.url, 'http://internal').searchParams.get('action') || ''; } catch { action = ''; }

  const isGet = GET_ACTIONS.has(action);
  if (!isGet && !POST_ACTIONS.has(action)) return json({ error: 'not_found' }, 404);
  if (ctx.method !== (isGet ? 'GET' : 'POST')) {
    return json({ error: 'method_not_allowed' }, 405, { allow: isGet ? 'GET' : 'POST' });
  }

  try {
    if (action === 'bank') return json(await readBank(db));

    if (action === 'owner') {
      const row = await db.getOwner();
      const loggedIn = !!ctx.user;
      return json({
        loggedIn,
        hasOwner: row !== null,
        isOwner: !!(loggedIn && row && row.owner_id === ctx.user.user_id),
      });
    }

    const now = new Date().toISOString();

    if (action === 'claim-owner') {
      const user = requireUser(ctx);
      const before = await db.getOwner();
      if (before) {
        if (before.owner_id === user.user_id) return json({ claimed: true, isOwner: true });
        return json({ error: 'owner_exists' }, 409);
      }
      const ownerId = await db.claimOwner(user.user_id, now);
      if (ownerId === null) dbFail();
      if (ownerId !== user.user_id) return json({ error: 'owner_exists' }, 409);
      return json({ claimed: true, isOwner: true });
    }

    await requireOwner(ctx, db);

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

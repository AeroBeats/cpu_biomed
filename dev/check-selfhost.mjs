/* 自建后端本地验证：node dev/check-selfhost.mjs
   用内存数据库替身跑通账号会话、邀请码注册、静态托管、全部 action 与校验规则，
   并把 deploy/server/content.json 整份灌一遍，确认 353 条种子数据都能通过校验。
   再用同一份规则反过来体检导入模板和离线脚本本身。
   不需要 Docker、不需要 pg、不需要联网。 */

import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
process.env.SITE_ROOT = path.join(ROOT, 'web');

const { createServer } = await import('../deploy/server/index.mjs');
const { createAuth, hashPassword, verifyPassword, SESSION_COOKIE } = await import('../deploy/server/auth.mjs');
const { loadContent, seedIfEmpty } = await import('../deploy/server/seed.mjs');
const { createMediaStore, detectImage, MAX_IMAGE_BYTES } = await import('../deploy/server/media.mjs');
const { createMemoryDb } = await import('./memory-db.mjs');

const USER = 'owner';
const PASS = 'test-password-123';
const API = '/functions/v1/app';
const GOOD = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');
const BADPASS = 'Basic ' + Buffer.from(USER + ':wrong').toString('base64');
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed += 1; return true; }
  failures.push(name + (detail === undefined ? '' : ' → ' + JSON.stringify(detail)));
  return false;
}
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
const close = (server) => new Promise((r) => server.close(r));

function request(base, method, url, body, headers) {
  return fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

// 注册失败按来源 IP 计数，而那份计数是模块级的、跨服务实例共用。
// 所以每个阶段用不同的转发地址，免得上一阶段攒下的失败把这一阶段的桶点满。
let stageSeq = 0;

async function start(db, env = { ADMIN_USER: USER, ADMIN_PASSWORD: PASS }, media = null) {
  const auth = createAuth(env);
  const boot = await auth.ensureAdmin(db);
  const server = createServer({ db, auth, media });
  const port = await listen(server);
  const base = 'http://127.0.0.1:' + port;
  const ip = '203.0.113.' + (++stageSeq);
  const withIp = (extra) => ({ 'X-Forwarded-For': ip, ...extra });
  return {
    server, base, auth, boot, ip,
    // 匿名请求：不带任何凭据。
    anon: (method, url, body, headers) => request(base, method, url, body, withIp(headers)),
    // 管理员请求：默认走 Basic，模拟 curl -u 的自检路径；传 Cookie 可覆盖。
    call: (method, url, body, headers) => request(base, method, url, body, withIp({ Authorization: GOOD, ...headers })),
  };
}

const sampleQuestion = (id, over = {}) => ({
  id, subject: 'bio', chapter: '测试章节', qtype: 'single', level: 2,
  tags: ['测试'], stem: '下列哪一项是正确的？', opts: ['甲', '乙', '丙', '丁'],
  answer: 1, explain_text: '因为乙正确。', sort_order: null, ...over,
});

/* ============ 第一阶段：账号、会话与访问边界 ============ */
{
  const db = createMemoryDb();
  const { server, base, anon, call, auth, boot } = await start(db);

  check('auth 配置生效', auth.configured === true);
  eq('启动时创建管理员', boot, 'created');
  eq('管理员角色为 admin', (await db.findUserByUsername(USER)).role, 'admin');
  eq('口令以散列入库', (await db.findUserByUsername(USER)).pass_hash.startsWith('scrypt$'), true);
  eq('重复启动只同步口令', await createAuth({ ADMIN_USER: USER, ADMIN_PASSWORD: PASS }).ensureAdmin(db), 'synced');
  check('未配口令时拒绝发放身份', createAuth({ ADMIN_USER: 'a', ADMIN_PASSWORD: '' }).configured === false);

  // 口令散列
  const hashed = await hashPassword('s3cret-pass');
  check('散列不含明文', hashed.indexOf('s3cret-pass') === -1 && hashed.startsWith('scrypt$'), hashed);
  eq('散列可校验', await verifyPassword('s3cret-pass', hashed), true);
  eq('错口令校验失败', await verifyPassword('s3cret-pasS', hashed), false);
  eq('两次散列盐不同', await hashPassword('s3cret-pass') === hashed, false);
  eq('畸形散列串不抛异常', await verifyPassword('x', 'not-a-hash'), false);
  eq('被改过的 scrypt 参数不接受', await verifyPassword('s3cret-pass', hashed.replace('$16384$', '$1024$')), false);

  // 会话签名
  const token = auth.signSession('u_test');
  eq('会话可解析', auth.readSession(token).userId, 'u_test');
  eq('篡改签名 → null', auth.readSession(token.slice(0, -2) + 'aa'), null);
  eq('篡改载荷 → null', auth.readSession(
    's1.' + Buffer.from('{"u":"u_evil","e":9000000000000000}').toString('base64url') + token.slice(token.lastIndexOf('.')),
  ), null);
  eq('已过期 → null', auth.readSession(auth.signSession('u_test', Date.now() - auth.sessionTtlMs - 1000)), null);
  eq('非本站格式 → null', auth.readSession('garbage'), null);
  eq('空值 → null', auth.readSession(undefined), null);
  const setCookie = auth.setCookieHeader(token, false);
  check('会话 Cookie 为 HttpOnly', /HttpOnly/.test(setCookie), setCookie);
  check('会话 Cookie 为 SameSite=Lax', /SameSite=Lax/.test(setCookie), setCookie);
  check('明文 HTTP 下不加 Secure', !/Secure/.test(setCookie), setCookie);
  check('HTTPS 下追加 Secure', /; Secure/.test(auth.setCookieHeader(token, true)));
  eq('换 SESSION_SECRET 后旧会话失效',
    createAuth({ ADMIN_USER: USER, ADMIN_PASSWORD: PASS, SESSION_SECRET: 'other' }).readSession(token), null);

  // 健康检查与静态页面：都不需要登录
  const hz = await fetch(base + '/healthz');
  eq('healthz 免认证且 200', hz.status, 200);
  eq('healthz body', await hz.json(), { ok: true });

  const home = await anon('GET', '/');
  const homeText = await home.text();
  eq('未登录也能打开首页', home.status, 200);
  check('首页是复习台页面', homeText.includes('药大生医') && homeText.includes('id="app"'));
  check('首页 no-cache', /no-cache/.test(home.headers.get('cache-control') || ''));
  eq('首页带 nosniff', home.headers.get('x-content-type-options'), 'nosniff');

  const css = await anon('GET', '/styles.css');
  eq('样式文件 200', css.status, 200);
  check('样式 MIME 正确', /text\/css/.test(css.headers.get('content-type') || ''), css.headers.get('content-type'));

  const extra = await anon('GET', '/data/questions_extra.js');
  eq('扩充题库脚本 200', extra.status, 200);
  check('扩充题库脚本 MIME 正确', /javascript/.test(extra.headers.get('content-type') || ''));

  eq('接口层脚本 200', (await anon('GET', '/api.js')).status, 200);

  // 路径穿越与隐藏文件
  eq('编码穿越 → 404', (await anon('GET', '/%2e%2e/%2e%2e/deploy/server/package.json')).status, 404);
  eq('双重编码穿越 → 404', (await anon('GET', '/%252e%252e/deploy/schema.sql')).status, 404);
  eq('绝对路径穿越 → 404', (await anon('GET', '/../deploy/.env.example')).status, 404);
  eq('隐藏文件 → 404', (await anon('GET', '/.hidden')).status, 404);
  eq('不存在文件 → 404', (await anon('GET', '/nope.html')).status, 404);
  eq('目录 → 404', (await anon('GET', '/data/')).status, 404);
  eq('静态文件不允许 POST', (await anon('POST', '/styles.css')).status, 405);
  eq('HEAD 首页可用', (await anon('HEAD', '/')).status, 200);

  // 匿名身份下的接口契约：读公开，写拒绝
  eq('匿名 session', await (await anon('GET', API + '?action=session')).json(), { loggedIn: false, user: null });
  eq('匿名可读题库', (await anon('GET', API + '?action=bank')).status, 200);
  const anonProgress = await anon('GET', API + '?action=progress');
  eq('匿名读进度 → 401', anonProgress.status, 401);
  eq('401 错误码', (await anonProgress.json()).error, 'login_required');
  // 不能再发 WWW-Authenticate，否则浏览器会弹出原生口令框，把自建登录页顶掉。
  eq('401 不带认证挑战头', anonProgress.headers.get('www-authenticate'), null);
  eq('匿名不能写内容 → 401',
    (await anon('POST', API + '?action=upsert-question', sampleQuestion('q-blocked'))).status, 401);

  eq('未知 action → 404', (await anon('GET', API + '?action=nope')).status, 404);
  eq('已下线的 owner 动作 → 404', (await anon('GET', API + '?action=owner')).status, 404);
  eq('已下线的 claim-owner → 404', (await anon('POST', API + '?action=claim-owner', {})).status, 404);
  const wrongMethod = await anon('GET', API + '?action=login');
  eq('GET 打 POST 动作 → 405', wrongMethod.status, 405);
  eq('405 带 allow 头', wrongMethod.headers.get('allow'), 'POST');
  eq('POST 打 GET 动作 → 405', (await anon('POST', API + '?action=bank', {})).status, 405);
  eq('GET 打只允许 POST 的写入 → 405', (await anon('GET', API + '?action=upsert-card')).status, 405);

  eq('空库 bank 结构', await (await anon('GET', API + '?action=bank')).json(),
    { questions: [], chapters: [], cards: [], truncated: false });

  // ---------- 登录 ----------
  const badLogin = await anon('POST', API + '?action=login', { username: USER, password: 'wrong-password' });
  eq('错口令登录 → 401', badLogin.status, 401);
  eq('错口令错误码', (await badLogin.json()).error, 'bad_credentials');
  eq('不存在的用户 → 同样 401',
    (await anon('POST', API + '?action=login', { username: 'nobody', password: 'wrong-password' })).status, 401);
  eq('用户名大小写不敏感',
    (await anon('POST', API + '?action=login', { username: 'OWNER', password: PASS })).status, 200);
  eq('口令太短的登录请求 → 400',
    (await anon('POST', API + '?action=login', { username: USER, password: 'x' })).status, 400);
  eq('登录缺请求体 → 400', (await anon('POST', API + '?action=login', '')).status, 400);

  const login = await anon('POST', API + '?action=login', { username: USER, password: PASS });
  eq('管理员登录成功', login.status, 200);
  const adminCookie = cookieOf(login);
  check('登录下发会话 Cookie', adminCookie.startsWith(SESSION_COOKIE + '='), adminCookie);
  const loginBody = await login.json();
  eq('登录返回 loggedIn', loginBody.loggedIn, true);
  eq('登录返回管理员身份', { ...loginBody.user, id: typeof loginBody.user.id },
    { id: 'string', username: USER, name: USER, role: 'admin' });
  check('响应里不含口令散列', JSON.stringify(loginBody).indexOf('scrypt$') === -1);

  const asAdmin = { Cookie: adminCookie };
  eq('会话 Cookie 可换取身份',
    (await (await anon('GET', API + '?action=session', undefined, asAdmin)).json()).user.role, 'admin');
  eq('伪造的 Cookie 视为未登录',
    await (await anon('GET', API + '?action=session', undefined, { Cookie: SESSION_COOKIE + '=s1.bogus.bogus' })).json(),
    { loggedIn: false, user: null });
  eq('畸形 Cookie 头不炸服务', (await anon('GET', '/', undefined, { Cookie: ';;;===' })).status, 200);

  // Basic 仍然可用：curl 与安装脚本自检走这条路
  eq('Basic 管理员可读 session', (await (await call('GET', API + '?action=session')).json()).user.role, 'admin');
  eq('Basic 错口令视为未登录',
    await (await anon('GET', API + '?action=session', undefined, { Authorization: BADPASS })).json(),
    { loggedIn: false, user: null });
  eq('Basic 畸形凭据视为未登录',
    await (await anon('GET', API + '?action=session', undefined, { Authorization: 'Basic !!!' })).json(),
    { loggedIn: false, user: null });
  eq('Basic 无冒号凭据视为未登录',
    await (await anon('GET', API + '?action=session', undefined,
      { Authorization: 'Basic ' + Buffer.from('nocolon').toString('base64') })).json(),
    { loggedIn: false, user: null });

  // ---------- 注册与普通用户权限 ----------
  // 注册是邀请制的：管理员先发稿，对方拿码注册。create-invite 只有管理员能用。
  eq('匿名不能生成邀请码', (await anon('POST', API + '?action=create-invite', {})).status, 401);
  eq('匿名不能读邀请码列表', (await anon('GET', API + '?action=list-invites')).status, 401);
  const newInvite = async (note) =>
    (await (await call('POST', API + '?action=create-invite', { note: note || '' })).json()).code;

  const badInvite = async (body) =>
    (await (await anon('POST', API + '?action=register', body)).json()).error;
  eq('不带邀请码 → invite_needed',
    await badInvite({ username: 'noinv', password: 'study-hard-2027' }), 'invite_needed');
  eq('邀请码长度不对 → invite_needed',
    await badInvite({ username: 'shorti', password: 'study-hard-2027', invite: 'ABC' }), 'invite_needed');
  eq('字母表外的字符 → invite_needed',
    await badInvite({ username: 'badchar', password: 'study-hard-2027', invite: 'ABCD&FGH' }), 'invite_needed');
  eq('9 位超长 → invite_needed',
    await badInvite({ username: 'toolong', password: 'study-hard-2027', invite: 'ABCDEFGHJ' }), 'invite_needed');
  // I L O U 不是「非法字符」：按 Crockford 它们本来就是 1 1 0 0 的别名，形状合法、只是库里没这条。
  eq('易混字符归一后按查不到处理',
    await badInvite({ username: 'cfuse', password: 'study-hard-2027', invite: 'ILOUILOU' }), 'invite_invalid');
  eq('码形如真但库里没有 → invite_invalid',
    await badInvite({ username: 'ghost1', password: 'study-hard-2027', invite: 'ZZZZZZZZ' }), 'invite_invalid');
  // 字段校验在邀请码之前：口令太短这类问题不该因为没带码而被掩盖。
  eq('注册口令太短 → 400',
    (await anon('POST', API + '?action=register', { username: 'abcd', password: '1234567' })).status, 400);
  eq('用户名含空格 → 400',
    (await anon('POST', API + '?action=register', { username: 'a b c', password: 'study-hard-2027' })).status, 400);
  eq('用户名太短 → 400',
    (await anon('POST', API + '?action=register', { username: 'ab', password: 'study-hard-2027' })).status, 400);
  eq('口令含控制字符 → 400',
    (await anon('POST', API + '?action=register', { username: 'abcd', password: 'study\nhard2027' })).status, 400);

  const invite1 = await newInvite('发给研友');
  check('生成的码是 8 位且不含 I L O U', /^[0-9A-Z]{8}$/.test(invite1) && !/[ILUO]/.test(invite1), invite1);
  const reg = await anon('POST', API + '?action=register',
    { username: 'YanYou', password: 'study-hard-2027', display_name: '研友', invite: invite1 });
  eq('注册成功并自动登录', reg.status, 200);
  const regBody = await reg.json();
  eq('用户名统一转小写', regBody.user.username, 'yanyou');
  eq('新账号是普通用户', regBody.user.role, 'user');
  eq('显示名保留原样', regBody.user.name, '研友');
  const userCookie = cookieOf(reg);
  check('注册也下发会话 Cookie', userCookie.startsWith(SESSION_COOKIE + '='), userCookie);
  const asUser = { Cookie: userCookie };
  const userWrite = await anon('POST', API + '?action=upsert-question', sampleQuestion('q-nope'), asUser);

  eq('普通用户不能生成邀请码',
    (await anon('POST', API + '?action=create-invite', {}, asUser)).status, 403);
  eq('普通用户不能读邀请码列表', (await anon('GET', API + '?action=list-invites', undefined, asUser)).status, 403);
  eq('普通用户写内容 → 403', userWrite.status, 403);
  eq('403 错误码', (await userWrite.json()).error, 'not_admin');
  eq('普通用户同步内置 → 403', (await anon('POST', API + '?action=sync-builtin', { questions: [] }, asUser)).status, 403);
  eq('普通用户删题 → 403', (await anon('POST', API + '?action=delete-question', { id: 'q-one' }, asUser)).status, 403);
  eq('普通用户可读题库', (await anon('GET', API + '?action=bank', undefined, asUser)).status, 200);

  // 一个码只用一次
  eq('同一个码第二次注册 → invite_used',
    await badInvite({ username: 'second1', password: 'study-hard-2027', invite: invite1 }), 'invite_used');
  const afterUse = await (await call('GET', API + '?action=list-invites')).json();
  const listed = afterUse.invites.find((r) => r.code === invite1);
  eq('列表里备注带回来了', listed.note, '发给研友');
  check('列表里的码标成已用', !!listed.used_at, listed);
  eq('列表里能看到被谁用了', listed.used_by, 'yanyou');

  // 手抄容错：小写、加横线、把 0 看成 O、把 1 看成 I 都该认
  const invite2 = await newInvite();
  const mangled = invite2.replace(/0/g, 'O').replace(/1/g, 'I').toLowerCase().replace(/(.{4})(?=.)/g, '$1-');
  const reg2 = await anon('POST', API + '?action=register',
    { username: 'mangle', password: 'study-hard-2027', invite: mangled });
  eq('大小写/横线/O-I 混淆照样能用', reg2.status, 200);
  await reg2.json();

  eq('抢注管理员用户名 → 409',
    (await anon('POST', API + '?action=register',
      { username: USER.toUpperCase(), password: 'another-pass-1', invite: await newInvite() })).status, 409);
  eq('重复注册 → 409',
    (await anon('POST', API + '?action=register',
      { username: 'yanyou', password: 'another-pass-1', invite: await newInvite() })).status, 409);
  eq('409 错误码', (await (await anon('POST', API + '?action=register',
    { username: 'yanyou', password: 'another-pass-1', invite: await newInvite() })).json()).error, 'username_taken');
  eq('不传显示名也能注册',
    (await (await anon('POST', API + '?action=register',
      { username: 'second', password: 'study-hard-2027', invite: await newInvite() })).json()).user.name,
    'second');

  // ---------- 发码与作废 ----------
  eq('备注太长 → 400', (await call('POST', API + '?action=create-invite', { note: 'x'.repeat(61) })).status, 400);
  eq('备注不是字符串 → 400', (await call('POST', API + '?action=create-invite', { note: 42 })).status, 400);
  eq('超长备注的错误字段',
    (await (await call('POST', API + '?action=create-invite', { note: 'x'.repeat(61) })).json()).field, 'note');
  const invite3 = await newInvite('   发给李四   ');
  eq('备注两端空白去掉',
    (await (await call('GET', API + '?action=list-invites')).json()).invites.find((r) => r.code === invite3).note,
    '发给李四');

  // 同时拿同一个码注册：只能成一个，输的那个不能留下没码的账号。
  const raceCode = await newInvite();
  const race = await Promise.all([
    anon('POST', API + '?action=register', { username: 'racer1', password: 'study-hard-2027', invite: raceCode }),
    anon('POST', API + '?action=register', { username: 'racer2', password: 'study-hard-2027', invite: raceCode }),
  ]);
  eq('并发抢同一个码只成一个', race.filter((r) => r.status === 200).length, 1);
  eq('另一个拿到 invite_used', race.filter((r) => r.status === 409).length, 1);
  const raced = [await db.findUserByUsername('racer1'), await db.findUserByUsername('racer2')].filter(Boolean);
  eq('抢输的账号被回滚，只剩一个', raced.length, 1);
  eq('活下来的就是拿到 200 的那个', raced[0].username, race[0].status === 200 ? 'racer1' : 'racer2');
  eq('码记在赢的那个账号上',
    (await (await call('GET', API + '?action=list-invites')).json()).invites
      .find((r) => r.code === raceCode).used_by, raced[0].username);

  const dead = await newInvite('发错人了');
  eq('作废没用过的码', await (await call('POST', API + '?action=delete-invite', { code: dead })).json(),
    { code: dead, revoked: true });
  eq('作废之后再拿来注册 → invite_invalid',
    await badInvite({ username: 'revoked1', password: 'study-hard-2027', invite: dead }), 'invite_invalid');
  eq('重复作废 → 404', (await call('POST', API + '?action=delete-invite', { code: dead })).status, 404);
  eq('不传 code → 400', (await call('POST', API + '?action=delete-invite', {})).status, 400);
  eq('普通用户不能作废', (await anon('POST', API + '?action=delete-invite', { code: invite3 }, asUser)).status, 403);
  // 作废只是删码，不能顺手把已经注册好的账号带走。
  eq('作废用过的码', (await call('POST', API + '?action=delete-invite', { code: invite1 })).status, 200);
  eq('码没了，账号还能登录',
    (await anon('POST', API + '?action=login', { username: 'yanyou', password: 'study-hard-2027' })).status, 200);

  // 删掉账号是常规操作（对方忘了口令就重建一个），但码不能因此复活。
  await db.deleteUser((await db.findUserByUsername('mangle')).user_id);
  const residue = (await (await call('GET', API + '?action=list-invites')).json()).invites
    .find((r) => r.code === invite2);
  check('账号删了，码仍标着已用', !!residue.used_at, residue);
  eq('账号删了，used_by 变空', residue.used_by, '');
  eq('删过账号的码不能再用',
    await badInvite({ username: 'mangle2', password: 'study-hard-2027', invite: invite2 }), 'invite_used');

  // ---------- 进度同步 ----------
  const payload = { v: 1, savedAt: 1700000000000, stats: { 'q-1': { right: 2, wrong: 1 } }, days: ['2026-10-21'] };
  const put = await anon('POST', API + '?action=progress', { data: payload }, asUser);
  eq('写进度成功', put.status, 200);
  check('写进度返回服务端时间', typeof (await put.json()).updated_at === 'string');
  const got = await (await anon('GET', API + '?action=progress', undefined, asUser)).json();
  eq('进度原样读回', got.data, payload);
  check('读进度带 updated_at', typeof got.updated_at === 'string');

  eq('进度按账号隔离', await (await anon('GET', API + '?action=progress', undefined, asAdmin)).json(),
    { data: null, updated_at: null });

  const overwrite = { v: 1, savedAt: 1700000099999, stats: {} };
  await anon('POST', API + '?action=progress', { data: overwrite }, asUser);
  eq('再写覆盖旧进度', (await (await anon('GET', API + '?action=progress', undefined, asUser)).json()).data, overwrite);

  eq('进度不是对象 → 400', (await anon('POST', API + '?action=progress', { data: [1, 2] }, asUser)).status, 400);
  eq('缺 data → 400', (await anon('POST', API + '?action=progress', {}, asUser)).status, 400);
  const hugeProgress = await anon('POST', API + '?action=progress',
    { data: { blob: 'x'.repeat(1024 * 1024 + 16) } }, asUser);
  eq('超大进度 → 413', hugeProgress.status, 413);
  eq('413 错误码', (await hugeProgress.json()).error, 'progress_too_large');

  // ---------- 退出 ----------
  const out = await anon('POST', API + '?action=logout', {}, asUser);
  eq('退出成功', await out.json(), { loggedIn: false, user: null });
  check('退出清 Cookie', /Max-Age=0/.test(out.headers.get('set-cookie') || ''), out.headers.get('set-cookie'));
  eq('退出后可用口令重新登录',
    (await anon('POST', API + '?action=login', { username: 'yanyou', password: 'study-hard-2027' })).status, 200);

  await close(server);
}

/* ============ 第二阶段：管理员内容增删改 ============ */
{
  const db = createMemoryDb();
  const { server, call } = await start(db);

  eq('新增题目', await (await call('POST', API + '?action=upsert-question', sampleQuestion('q-one'))).json(),
    { id: 'q-one', built_in: false, created: true });
  eq('重复保存同一题 → created false',
    await (await call('POST', API + '?action=upsert-question', sampleQuestion('q-one', { stem: '改过的题干' }))).json(),
    { id: 'q-one', built_in: false, created: false });
  let bank = await (await call('GET', API + '?action=bank')).json();
  eq('编辑已生效', bank.questions[0].stem, '改过的题干');
  eq('未传 sort_order 时落到 9000', bank.questions[0].sort_order, 9000);

  eq('非法 qtype → 400', (await call('POST', API + '?action=upsert-question',
    sampleQuestion('q-bad', { qtype: 'essay' }))).status, 400);
  eq('400 带字段名', await (await call('POST', API + '?action=upsert-question',
    sampleQuestion('q-bad', { qtype: 'essay' }))).json(), { error: 'invalid_field', field: 'qtype' });
  eq('答案越界 → 400', (await call('POST', API + '?action=upsert-question',
    sampleQuestion('q-bad', { answer: 9 }))).status, 400);
  eq('非法 id → 400', (await call('POST', API + '?action=upsert-question',
    sampleQuestion('Bad-ID', {}))).status, 400);
  eq('非法科目 → 400', (await call('POST', API + '?action=upsert-question',
    sampleQuestion('q-bad', { subject: 'xxx' }))).status, 400);
  eq('多选题答案自动排序去重',
    (await (await call('POST', API + '?action=upsert-question',
      sampleQuestion('q-multi', { qtype: 'multi', opts: ['甲', '乙', '丙', '丁'], answer: [2, 0] }))).json()).id, 'q-multi');
  bank = await (await call('GET', API + '?action=bank')).json();
  eq('多选答案已排序', bank.questions.find((q) => q.id === 'q-multi').answer, [0, 2]);
  eq('多选重复选项 → 400', (await call('POST', API + '?action=upsert-question',
    sampleQuestion('q-multi2', { qtype: 'multi', answer: [1, 1] }))).status, 400);
  eq('简答题字符串答案', (await (await call('POST', API + '?action=upsert-question',
    sampleQuestion('q-short', { qtype: 'short', opts: [], answer: '参考答案要点若干。', explain_text: '答题思路' }))).json()).created, true);

  eq('新增卡片', (await (await call('POST', API + '?action=upsert-card',
    { id: 'c-one', subject: 'ana', chapter: '酸碱滴定法', front: '正面', back: '背面内容足够长', sort_order: null })).json()).created, true);
  eq('新增章节', (await (await call('POST', API + '?action=upsert-chapter',
    { id: 'ch-one', subject: 'ana', name: '新章节', weight: 20, points: ['考点一', '考点二'], sort_order: null })).json()).created, true);
  eq('章节权重越界 → 400', (await call('POST', API + '?action=upsert-chapter',
    { id: 'ch-bad', subject: 'ana', name: '新章节', weight: 200, points: [], sort_order: null })).status, 400);

  eq('删除不存在的题 → 404', (await call('POST', API + '?action=delete-question', { id: 'q-nope' })).status, 404);
  eq('删除已有题', await (await call('POST', API + '?action=delete-question', { id: 'q-one' })).json(),
    { id: 'q-one', deleted: true });
  eq('删除时 id 非法 → 400', (await call('POST', API + '?action=delete-question', { id: 'X' })).status, 400);
  eq('删除卡片', (await (await call('POST', API + '?action=delete-card', { id: 'c-one' })).json()).deleted, true);
  eq('删除章节', (await (await call('POST', API + '?action=delete-chapter', { id: 'ch-one' })).json()).deleted, true);

  eq('畸形 JSON → 400', (await call('POST', API + '?action=upsert-question', '{not json')).status, 400);
  eq('空请求体 → 400', (await call('POST', API + '?action=upsert-question', '')).status, 400);
  eq('数组请求体 → 400', (await call('POST', API + '?action=upsert-question', '[]')).status, 400);

  // 一键上传（只插不改）
  const syncPayload = {
    questions: [sampleQuestion('q-sync-1', { sort_order: 0 }), sampleQuestion('q-sync-2', { sort_order: 1 })],
    cards: [{ id: 'c-sync', subject: 'bio', chapter: 'x', front: 'f', back: 'b', sort_order: 0 }],
  };
  const sync1 = await (await call('POST', API + '?action=sync-builtin', syncPayload)).json();
  eq('首次同步插入', sync1.results.map((r) => [r.table, r.inserted, r.skipped]),
    [['questions', 2, 0], ['cards', 1, 0]]);
  eq('首次同步未标记 incomplete', sync1.incomplete, false);
  const sync2 = await (await call('POST', API + '?action=sync-builtin', syncPayload)).json();
  eq('重复同步只跳过不覆盖', sync2.results.map((r) => [r.table, r.inserted, r.skipped]),
    [['questions', 0, 2], ['cards', 0, 1]]);
  const dup = await (await call('POST', API + '?action=sync-builtin',
    { questions: [sampleQuestion('q-dup', { sort_order: 0 }), sampleQuestion('q-dup', { sort_order: 1 })] })).json();
  eq('同步内重复 id 被折叠', dup.results[0].duplicateIds, 1);
  eq('同步空对象 → 400', (await call('POST', API + '?action=sync-builtin', {})).status, 400);
  eq('同步超量 → 400', (await call('POST', API + '?action=sync-builtin',
    { questions: Array.from({ length: 2001 }, (_, i) => sampleQuestion('q-x' + i, { sort_order: i })) })).status, 400);
  eq('超量错误码', (await (await call('POST', API + '?action=sync-builtin',
    { questions: Array.from({ length: 2001 }, (_, i) => sampleQuestion('q-y' + i, { sort_order: i })) })).json()).error, 'too_many_records');

  bank = await (await call('GET', API + '?action=bank')).json();
  const orders = bank.questions.map((q) => q.sort_order);
  eq('bank 按 sort_order 升序', orders, orders.slice().sort((a, b) => a - b));

  const huge = await call('POST', API + '?action=sync-builtin',
    JSON.stringify({ questions: [{ id: 'q-huge', stem: 'a'.repeat(4 * 1024 * 1024 + 10) }] }));
  eq('超过 4MB → 413', huge.status, 413);
  eq('413 错误码', (await huge.json()).error, 'payload_too_large');

  await close(server);
}

/* ============ 第三阶段：真实种子数据灌入 ============ */
{
  const db = createMemoryDb();
  const { server, call } = await start(db);

  const content = await loadContent();
  eq('种子题目数', content.questions.length, 353);
  eq('种子章节数', content.chapters.length, 32);
  eq('种子卡片数', content.cards.length, 89);

  const logs = [];
  const first = await seedIfEmpty(db, content, (m) => logs.push(m));
  eq('首次灌入未跳过', first.skipped, false);
  eq('灌入失败数为 0', first.failed, 0);
  eq('灌入条数', first.inserted, 353 + 32 + 89);
  check('灌入日志已输出', logs.length > 0, logs);

  const again = await seedIfEmpty(db, content, () => {});
  eq('重复启动跳过灌入', again.skipped, true);
  eq('跳过后题目数不变', await db.count('questions'), 353);

  const bank = await (await call('GET', API + '?action=bank')).json();
  eq('HTTP 读到的题目数', bank.questions.length, 353);
  eq('HTTP 读到的卡片数', bank.cards.length, 89);
  eq('HTTP 读到的章节数', bank.chapters.length, 32);
  eq('未被截断', bank.truncated, false);
  eq('种子数据标记为内置', bank.questions.every((q) => q.built_in === true), true);

  const perSubject = {};
  bank.questions.forEach((q) => { perSubject[q.subject] = (perSubject[q.subject] || 0) + 1; });
  eq('各科题量', perSubject, { bio: 64, ana: 132, pol: 142, eng: 15 });
  eq('jsonb 字段已还原为对象/数组', Array.isArray(bank.questions[0].opts) && Array.isArray(bank.questions[0].tags), true);

  // 改一条内置题，确认编辑不会被下次启动覆盖
  const target = bank.questions[0];
  const editRes = await call('POST', API + '?action=upsert-question', {
    id: target.id, subject: target.subject, chapter: target.chapter, qtype: target.qtype,
    level: target.level, tags: target.tags, stem: '我在后台改过的题干',
    opts: target.opts, answer: target.answer, explain_text: target.explain_text,
  });
  eq('编辑内置题成功', (await editRes.json()).created, false);
  const afterEdit = await seedIfEmpty(db, content, () => {});
  eq('重启灌入跳过，不覆盖后台编辑', afterEdit.skipped, true);
  const reread = await (await call('GET', API + '?action=bank')).json();
  eq('后台编辑保留', reread.questions.find((q) => q.id === target.id).stem, '我在后台改过的题干');

  await close(server);
}

/* ============ 第四阶段：图片上传与 /media/ 托管 ============ */
{
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const GIF_1PX = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cpubiomed-media-'));
  const db = createMemoryDb();
  const media = createMediaStore(dir);
  const { server, anon, call } = await start(db, { ADMIN_USER: USER, ADMIN_PASSWORD: PASS }, media);

  eq('png 文件头识别', detectImage(Buffer.from(PNG_1PX, 'base64')), 'png');
  eq('gif 文件头识别', detectImage(Buffer.from(GIF_1PX, 'base64')), 'gif');
  eq('纯文本不是图片', detectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);

  eq('匿名上传被拦', (await anon('POST', API + '?action=upload', { data: PNG_1PX })).status, 401);

  await anon('POST', API + '?action=register', {
    username: 'student', password: 'study-hard-1', display_name: '同学',
    invite: (await (await call('POST', API + '?action=create-invite', { note: '给同学' })).json()).code,
  });
  const plainCookie = cookieOf(await anon('POST', API + '?action=login', { username: 'student', password: 'study-hard-1' }));
  const asPlain = (method, url, body) => anon(method, url, body, { Cookie: plainCookie });
  const plainRes = await asPlain('POST', API + '?action=upload', { data: PNG_1PX });
  eq('普通用户上传被拒', plainRes.status, 403);
  eq('普通用户上传的错误码', (await plainRes.json()).error, 'not_admin');

  eq('upload 只收 POST', (await call('GET', API + '?action=upload')).status, 405);

  const ok = await call('POST', API + '?action=upload', { data: PNG_1PX });
  eq('管理员上传成功', ok.status, 200);
  const { url } = await ok.json();
  check('返回的是 /media/ 相对路径', /^\/media\/\d{6}\/[0-9a-f]{24}\.png$/.test(url), url);

  const onDisk = await readFile(path.join(dir, url.slice('/media/'.length)));
  eq('落盘字节与原图一致', onDisk.equals(Buffer.from(PNG_1PX, 'base64')), true);

  const served = await anon('GET', url);
  eq('图片可公开读取', served.status, 200);
  eq('图片 content-type 正确', served.headers.get('content-type'), 'image/png');
  check('图片走长缓存', /immutable/.test(served.headers.get('cache-control') || ''), served.headers.get('cache-control'));

  const dataUrl = await call('POST', API + '?action=upload', { data: 'data:image/png;base64,' + GIF_1PX });
  const dataUrlBody = await dataUrl.json();
  eq('接受 data URL 前缀', dataUrl.status, 200);
  // 前缀声明的是 png，文件头是 gif：以文件头为准，否则扩展名和真实内容能被人随意对不上。
  check('扩展名按文件头判定，不信前缀声明', /\.gif$/.test(dataUrlBody.url), dataUrlBody.url);

  const svgRes = await call('POST', API + '?action=upload', {
    data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64'),
  });
  eq('SVG 一律拒收', svgRes.status, 415);
  eq('SVG 拒收的错误码', (await svgRes.json()).error, 'unsupported_image');

  const tooBig = Buffer.concat([Buffer.from(PNG_1PX, 'base64'), Buffer.alloc(MAX_IMAGE_BYTES)]);
  eq('超过 2 MB 被拒', (await call('POST', API + '?action=upload', { data: tooBig.toString('base64') })).status, 413);
  eq('非法 base64 被拒', (await call('POST', API + '?action=upload', { data: 'not base64 !!' })).status, 400);
  eq('缺 data 字段被拒', (await call('POST', API + '?action=upload', {})).status, 400);

  eq('穿越到目录外读不到', (await anon('GET', '/media/../../etc/passwd')).status, 404);
  eq('读不存在的图返回 404', (await anon('GET', '/media/202610/' + 'f'.repeat(24) + '.png')).status, 404);
  eq('非图片扩展名不发', media.resolve('/nope.txt'), null);

  await close(server);

  // 没配 MEDIA_DIR 时上传要明说不可用，而不是把文件写进代码目录
  const bare = await start(createMemoryDb());
  eq('未配置存储时回 503', (await bare.call('POST', API + '?action=upload', { data: PNG_1PX })).status, 503);
  eq('未配置存储时的错误码', (await (await bare.call('POST', API + '?action=upload', { data: PNG_1PX })).json()).error, 'upload_unavailable');
  await close(bare.server);

  await rm(dir, { recursive: true, force: true });
}

/* ============ 第五阶段：离线体检脚本与导入模板 ============ */
{
  const { checkBankFile } = await import('../deploy/tools/check-bank.mjs');

  // 模板是给用户照抄的起点，它自己必须过校验：validate.mjs 一改，
  // 模板没跟着改的话这里会立刻炸，而不是等用户导进去被接口拒了才发现。
  const tpl = await checkBankFile(path.join(ROOT, 'deploy', 'tools', 'bank-template.json'));
  eq('模板无致命错误', tpl.fatal, null);
  eq('模板零错误', tpl.errors, []);
  // 模板里的编号都叫 demo-*，体检脚本本来就该提醒改掉；除了这一类，别的一律不许有。
  eq('模板只报 demo 编号提醒', tpl.warnings.filter((w) => w.group !== 'demo-id'), []);
  check('每条示例都被提醒改编号', tpl.warnings.length === 6, tpl.warnings.length);
  eq('模板条目数', tpl.total, 8);
  check('模板含公式或图片示例', tpl.rowsWithMathOrImage >= 4, tpl.rowsWithMathOrImage);

  const builtin = await checkBankFile(path.join(ROOT, 'deploy', 'server', 'content.json'));
  eq('内置题库零错误', builtin.errors, []);
  eq('内置题库条数与种子一致', builtin.total, 353 + 32 + 89);

  // 体检脚本本身：坏的条目要能逐条报出编号和字段
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'cpubiomed-check-'));
  const badFile = path.join(tmp, 'bad.json');
  await writeFile(badFile, JSON.stringify({
    questions: [
      { id: 'Demo-Upper', subject: 'xxx', qtype: 'single', level: 9, stem: '', opts: ['甲'], answer: 3, explain: '写错字段名' },
      { id: 'ok-1', subject: 'bio', chapter: '第一章', qtype: 'multi', level: 2, stem: '$E=mc^2$ 和 ![图](/media/x.png)',
        opts: ['甲', '乙', '丙'], answer: [0, 0], explain_text: '单选下标' },
      { id: 'ok-1', subject: 'bio', chapter: '第一章', qtype: 'judge', level: 1, stem: '重复编号',
        opts: ['正确', '错误'], answer: 0 },
    ],
    cards: 'not-an-array',
  }), 'utf8');
  const bad = await checkBankFile(badFile);
  eq('坏文件无致命错误', bad.fatal, null);
  check('坏文件报出多处错误', bad.errors.length >= 8, bad.errors.length);
  check('指出编号大小写非法', bad.errors.some((e) => e.field === 'id'), bad.errors);
  check('指出科目非法', bad.errors.some((e) => e.field === 'subject'), bad.errors);
  check('指出难度越界', bad.errors.some((e) => e.field === 'level'), bad.errors);
  check('指出题干为空', bad.errors.some((e) => e.field === 'stem'), bad.errors);
  check('指出答案与选项不匹配', bad.errors.some((e) => e.field === 'answer'), bad.errors);
  check('指出数组类型错误', bad.errors.some((e) => e.field === 'cards'), bad.errors);
  check('重复编号被点名', bad.errors.some((e) => /重复/.test(e.text)), bad.errors);
  check('提示 explain 应写 explain_text', bad.warnings.some((w) => /explain_text/.test(w.text)), bad.warnings);
  check('统计到含公式或图片的条目', bad.rowsWithMathOrImage >= 1, bad.rowsWithMathOrImage);

  const missing = await checkBankFile(path.join(tmp, 'nope.json'));
  check('读不到的文件给 fatal', typeof missing.fatal === 'string' && missing.fatal.includes('读不了'), missing.fatal);
  await writeFile(badFile, '{ "questions": [ }', 'utf8');
  check('JSON 语法错误给 fatal', String((await checkBankFile(badFile)).fatal).includes('JSON 解析失败'));

  await rm(tmp, { recursive: true, force: true });
}

/* ============ 第六阶段：注册失败按来源限流 ============ */
{
  const db = createMemoryDb();
  const { server, anon, call } = await start(db);
  const invite = async () => (await (await call('POST', API + '?action=create-invite', {})).json()).code;
  // 猜码的人：用户名每次都新，码是形状合法但库里没有的，只留失败不留账号。
  const guess = async (n, from) => {
    const res = await anon('POST', API + '?action=register',
      { username: 'guesser' + n, password: 'study-hard-2027', invite: 'ZZZZZZZZ' },
      { 'X-Forwarded-For': from });
    await res.json();
    return res.status;
  };

  // 计数在阈值之上才锁，所以第 21 次失败仍然放行，第 22 次才吃 429。
  const SPOOF = '198.51.100.20';
  eq('前 21 次猜码都没被锁', await Promise.all([...Array(21).keys()].map((i) => guess(i, SPOOF)))
    .then((codes) => codes.filter((s) => s === 429).length), 0);
  eq('第 22 次猜码 → 429', await guess(900, SPOOF), 429);
  eq('429 错误码',
    (await (await anon('POST', API + '?action=register',
      { username: 'guesser901', password: 'study-hard-2027', invite: 'ZZZZZZZZ' },
      { 'X-Forwarded-For': SPOOF })).json()).error, 'too_many_trials');
  eq('锁住之后拿好码也进不来',
    (await anon('POST', API + '?action=register',
      { username: 'locked1', password: 'study-hard-2027', invite: await invite() },
      { 'X-Forwarded-For': SPOOF })).status, 429);

  // 限流只认这一条来源，邻居不受牵连
  eq('换个来源照常注册',
    (await anon('POST', API + '?action=register',
      { username: 'neighbor', password: 'study-hard-2027', invite: await invite() },
      { 'X-Forwarded-For': '198.51.100.21' })).status, 200);
  eq('多段来源只看第一段（被锁那段写在后面照样锁）', await guess(902, SPOOF + ', 203.0.113.9'), 429);
  eq('多段来源只看第一段（没被锁那段写在前面就放行）', await guess(903, '192.0.2.77, ' + SPOOF), 400);

  // 共用出口 NAT 的一整间机房：一个人猜了半天，另一个人拿码还是能注册，
  // 而且这次成功把整桶清零，后面那位再继续错也不该立刻连累大家。
  const NAT = '198.51.100.40';
  await Promise.all([...Array(20).keys()].map((i) => guess(i, NAT)));
  eq('同一出口里诚实的人还能注册',
    (await anon('POST', API + '?action=register',
      { username: 'classmate', password: 'study-hard-2027', invite: await invite() },
      { 'X-Forwarded-For': NAT })).status, 200);
  eq('注册成功把计数清零', await Promise.all([...Array(21).keys()].map((i) => guess(1000 + i, NAT)))
    .then((codes) => codes.filter((s) => s === 429).length), 0);

  // 字段填错（口令太短之类）不该算成猜码，否则新手连错几次口令就被锁在门外。
  const fresh = '198.51.100.60';
  const wrongField = async () => {
    const res = await anon('POST', API + '?action=register',
      { username: 'newbie', password: 'short', invite: 'ZZZZZZZZ' }, { 'X-Forwarded-For': fresh });
    await res.json();
    return res.status;
  };
  const wrongStatuses = await Promise.all([...Array(25).keys()].map(wrongField));
  eq('填错字段一个都不限流', wrongStatuses.filter((s) => s === 429).length, 0);
  check('填错字段回的是 400', wrongStatuses.every((s) => s === 400), wrongStatuses[0]);

  // 限流只管 register，登录失败仍然只回 bad_credentials，不因为试错被锁
  eq('限流不影响登录',
    (await anon('POST', API + '?action=login', { username: 'neighbor', password: 'nope-nope-nope' },
      { 'X-Forwarded-For': SPOOF })).status, 401);

  await close(server);
}

console.log(`自建后端验证：通过 ${passed}，失败 ${failures.length}`);
if (failures.length) {
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('SELFHOST-OK');

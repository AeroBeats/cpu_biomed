/* 自建后端本地验证：node dev/check-selfhost.mjs
   用内存数据库替身跑通认证、静态托管、全部 action 与校验规则，
   并把 deploy/server/content.json 整份灌一遍，确认 353 条种子数据都能通过校验。
   不需要 Docker、不需要 pg、不需要联网。 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
process.env.SITE_ROOT = path.join(ROOT, 'web');

const { createServer } = await import('../deploy/server/index.mjs');
const { createAuth } = await import('../deploy/server/auth.mjs');
const { loadContent, seedIfEmpty } = await import('../deploy/server/seed.mjs');
const { createMemoryDb } = await import('./memory-db.mjs');

const USER = 'owner';
const PASS = 'test-password-123';
const GOOD = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');
const BADPASS = 'Basic ' + Buffer.from(USER + ':wrong').toString('base64');

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

async function start(db) {
  const auth = createAuth({ ADMIN_USER: USER, ADMIN_PASSWORD: PASS });
  const server = createServer({ db, auth });
  const port = await listen(server);
  const base = 'http://127.0.0.1:' + port;
  const call = (method, url, body, headers = {}) =>
    fetch(base + url, {
      method,
      headers: { Authorization: GOOD, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
  return { server, base, call, auth };
}

const sampleQuestion = (id, over = {}) => ({
  id, subject: 'bio', chapter: '测试章节', qtype: 'single', level: 2,
  tags: ['测试'], stem: '下列哪一项是正确的？', opts: ['甲', '乙', '丙', '丁'],
  answer: 1, explain_text: '因为乙正确。', sort_order: null, ...over,
});

/* ============ 第一阶段：认证、静态托管、接口契约 ============ */
{
  const db = createMemoryDb();
  const { server, base, call, auth } = await start(db);

  check('auth 配置生效', auth.configured === true);
  eq('auth 合法口令 → admin 身份', auth.getUser(GOOD), { user_id: 'admin', name: USER });
  eq('auth 错误口令 → null', auth.getUser(BADPASS), null);
  eq('auth 无凭据 → null', auth.getUser(undefined), null);
  eq('auth 畸形凭据 → null', auth.getUser('Basic !!!not-base64!!!'), null);
  eq('auth 无冒号凭据 → null', auth.getUser('Basic ' + Buffer.from('nocolon').toString('base64')), null);
  check('未配口令时拒绝放行', createAuth({ ADMIN_USER: 'a', ADMIN_PASSWORD: '' }).getUser(GOOD) === null
    && createAuth({ ADMIN_USER: 'a', ADMIN_PASSWORD: '' }).configured === false);

  // 健康检查不鉴权（compose healthcheck 用）
  const hz = await fetch(base + '/healthz');
  check('healthz 免认证且 200', hz.status === 200, hz.status);
  eq('healthz body', await hz.json(), { ok: true });

  const anon = await fetch(base + '/');
  eq('未登录访问首页 → 401', anon.status, 401);
  check('401 带 WWW-Authenticate 触发浏览器弹窗', /Basic realm=/.test(anon.headers.get('www-authenticate') || ''),
    anon.headers.get('www-authenticate'));

  const home = await call('GET', '/');
  const homeText = await home.text();
  eq('登录后首页 200', home.status, 200);
  check('首页是复习台页面', homeText.includes('药大生医') && homeText.includes('id="app"'));
  check('首页 no-cache', /no-cache/.test(home.headers.get('cache-control') || ''));
  check('首页带 nosniff', home.headers.get('x-content-type-options') === 'nosniff');

  const css = await call('GET', '/styles.css');
  eq('样式文件 200', css.status, 200);
  check('样式 MIME 正确', /text\/css/.test(css.headers.get('content-type') || ''), css.headers.get('content-type'));

  const extra = await call('GET', '/data/questions_extra.js');
  eq('扩充题库脚本 200', extra.status, 200);
  check('扩充题库脚本 MIME 正确', /javascript/.test(extra.headers.get('content-type') || ''));

  const apiScript = await call('GET', '/api.js');
  eq('接口层脚本 200', apiScript.status, 200);

  // 路径穿越与隐藏文件
  eq('编码穿越 → 404', (await call('GET', '/%2e%2e/%2e%2e/deploy/server/package.json')).status, 404);
  eq('双重编码穿越 → 404', (await call('GET', '/%252e%252e/deploy/schema.sql')).status, 404);
  eq('绝对路径穿越 → 404', (await call('GET', '/../deploy/.env.example')).status, 404);
  eq('隐藏文件 → 404', (await call('GET', '/.hidden')).status, 404);
  eq('不存在文件 → 404', (await call('GET', '/nope.html')).status, 404);
  eq('目录 → 404', (await call('GET', '/data/')).status, 404);
  eq('静态文件不允许 POST', (await call('POST', '/styles.css')).status, 405);
  eq('HEAD 首页可用', (await call('HEAD', '/')).status, 200);

  // 接口鉴权与动作契约
  eq('接口未登录 → 401', (await fetch(base + '/functions/v1/app?action=bank')).status, 401);
  eq('未知 action → 404', (await call('GET', '/functions/v1/app?action=nope')).status, 404);
  const wrongMethod = await call('GET', '/functions/v1/app?action=claim-owner');
  eq('GET 打 POST 动作 → 405', wrongMethod.status, 405);
  eq('405 带 allow 头', wrongMethod.headers.get('allow'), 'POST');
  eq('POST 打 GET 动作 → 405', (await call('POST', '/functions/v1/app?action=bank', {})).status, 405);

  const emptyBank = await (await call('GET', '/functions/v1/app?action=bank')).json();
  eq('空库 bank 结构', emptyBank, { questions: [], chapters: [], cards: [], truncated: false });
  eq('未启用后台时 owner 状态', await (await call('GET', '/functions/v1/app?action=owner')).json(),
    { loggedIn: true, hasOwner: false, isOwner: false });

  const blocked = await call('POST', '/functions/v1/app?action=upsert-question', sampleQuestion('q-blocked'));
  eq('未启用后台不能写 → 409', blocked.status, 409);
  eq('未启用后台错误码', (await blocked.json()).error, 'owner_not_claimed');

  eq('claim-owner 成功', await (await call('POST', '/functions/v1/app?action=claim-owner', {})).json(),
    { claimed: true, isOwner: true });
  eq('claim-owner 幂等', await (await call('POST', '/functions/v1/app?action=claim-owner', {})).json(),
    { claimed: true, isOwner: true });
  eq('启用后 owner 状态', await (await call('GET', '/functions/v1/app?action=owner')).json(),
    { loggedIn: true, hasOwner: true, isOwner: true });

  // 增删改
  eq('新增题目', await (await call('POST', '/functions/v1/app?action=upsert-question', sampleQuestion('q-one'))).json(),
    { id: 'q-one', built_in: false, created: true });
  eq('重复保存同一题 → created false',
    await (await call('POST', '/functions/v1/app?action=upsert-question', sampleQuestion('q-one', { stem: '改过的题干' }))).json(),
    { id: 'q-one', built_in: false, created: false });
  let bank = await (await call('GET', '/functions/v1/app?action=bank')).json();
  eq('编辑已生效', bank.questions[0].stem, '改过的题干');
  eq('未传 sort_order 时落到 9000', bank.questions[0].sort_order, 9000);

  eq('非法 qtype → 400', (await call('POST', '/functions/v1/app?action=upsert-question',
    sampleQuestion('q-bad', { qtype: 'essay' }))).status, 400);
  const badField = await (await call('POST', '/functions/v1/app?action=upsert-question',
    sampleQuestion('q-bad', { qtype: 'essay' }))).json();
  eq('400 带字段名', badField, { error: 'invalid_field', field: 'qtype' });
  eq('答案越界 → 400', (await call('POST', '/functions/v1/app?action=upsert-question',
    sampleQuestion('q-bad', { answer: 9 }))).status, 400);
  eq('非法 id → 400', (await call('POST', '/functions/v1/app?action=upsert-question',
    sampleQuestion('Bad-ID', {}))).status, 400);
  eq('非法科目 → 400', (await call('POST', '/functions/v1/app?action=upsert-question',
    sampleQuestion('q-bad', { subject: 'xxx' }))).status, 400);
  eq('多选题答案自动排序去重',
    (await (await call('POST', '/functions/v1/app?action=upsert-question',
      sampleQuestion('q-multi', { qtype: 'multi', opts: ['甲', '乙', '丙', '丁'], answer: [2, 0] }))).json()).id, 'q-multi');
  bank = await (await call('GET', '/functions/v1/app?action=bank')).json();
  eq('多选答案已排序', bank.questions.find((q) => q.id === 'q-multi').answer, [0, 2]);
  eq('多选重复选项 → 400', (await call('POST', '/functions/v1/app?action=upsert-question',
    sampleQuestion('q-multi2', { qtype: 'multi', answer: [1, 1] }))).status, 400);
  eq('简答题字符串答案', (await (await call('POST', '/functions/v1/app?action=upsert-question',
    sampleQuestion('q-short', { qtype: 'short', opts: [], answer: '参考答案要点若干。', explain_text: '答题思路' }))).json()).created, true);

  eq('新增卡片', (await (await call('POST', '/functions/v1/app?action=upsert-card',
    { id: 'c-one', subject: 'ana', chapter: '酸碱滴定法', front: '正面', back: '背面内容足够长', sort_order: null })).json()).created, true);
  eq('新增章节', (await (await call('POST', '/functions/v1/app?action=upsert-chapter',
    { id: 'ch-one', subject: 'ana', name: '新章节', weight: 20, points: ['考点一', '考点二'], sort_order: null })).json()).created, true);
  eq('章节权重越界 → 400', (await call('POST', '/functions/v1/app?action=upsert-chapter',
    { id: 'ch-bad', subject: 'ana', name: '新章节', weight: 200, points: [], sort_order: null })).status, 400);

  eq('删除不存在的题 → 404', (await call('POST', '/functions/v1/app?action=delete-question', { id: 'q-nope' })).status, 404);
  eq('删除已有题', await (await call('POST', '/functions/v1/app?action=delete-question', { id: 'q-one' })).json(),
    { id: 'q-one', deleted: true });
  eq('删除时 id 非法 → 400', (await call('POST', '/functions/v1/app?action=delete-question', { id: 'X' })).status, 400);
  eq('删除卡片', (await (await call('POST', '/functions/v1/app?action=delete-card', { id: 'c-one' })).json()).deleted, true);
  eq('删除章节', (await (await call('POST', '/functions/v1/app?action=delete-chapter', { id: 'ch-one' })).json()).deleted, true);

  // 请求体解析
  eq('畸形 JSON → 400', (await call('POST', '/functions/v1/app?action=upsert-question', '{not json')).status, 400);
  eq('空请求体 → 400', (await call('POST', '/functions/v1/app?action=upsert-question', '')).status, 400);
  eq('数组请求体 → 400', (await call('POST', '/functions/v1/app?action=upsert-question', '[]')).status, 400);

  // 一键上传（只插不改）
  const syncPayload = {
    questions: [sampleQuestion('q-sync-1', { sort_order: 0 }), sampleQuestion('q-sync-2', { sort_order: 1 })],
    cards: [{ id: 'c-sync', subject: 'bio', chapter: 'x', front: 'f', back: 'b', sort_order: 0 }],
  };
  const sync1 = await (await call('POST', '/functions/v1/app?action=sync-builtin', syncPayload)).json();
  eq('首次同步插入', sync1.results.map((r) => [r.table, r.inserted, r.skipped]),
    [['questions', 2, 0], ['cards', 1, 0]]);
  eq('首次同步未标记 incomplete', sync1.incomplete, false);
  const sync2 = await (await call('POST', '/functions/v1/app?action=sync-builtin', syncPayload)).json();
  eq('重复同步只跳过不覆盖', sync2.results.map((r) => [r.table, r.inserted, r.skipped]),
    [['questions', 0, 2], ['cards', 0, 1]]);
  const dup = await (await call('POST', '/functions/v1/app?action=sync-builtin',
    { questions: [sampleQuestion('q-dup', { sort_order: 0 }), sampleQuestion('q-dup', { sort_order: 1 })] })).json();
  eq('同步内重复 id 被折叠', dup.results[0].duplicateIds, 1);
  eq('同步空对象 → 400', (await call('POST', '/functions/v1/app?action=sync-builtin', {})).status, 400);
  eq('同步超量 → 400', (await call('POST', '/functions/v1/app?action=sync-builtin',
    { questions: Array.from({ length: 2001 }, (_, i) => sampleQuestion('q-x' + i, { sort_order: i })) })).status, 400);
  eq('超量错误码', (await (await call('POST', '/functions/v1/app?action=sync-builtin',
    { questions: Array.from({ length: 2001 }, (_, i) => sampleQuestion('q-y' + i, { sort_order: i })) })).json()).error, 'too_many_records');

  // 排序稳定性
  bank = await (await call('GET', '/functions/v1/app?action=bank')).json();
  const orders = bank.questions.map((q) => q.sort_order);
  eq('bank 按 sort_order 升序', orders, orders.slice().sort((a, b) => a - b));

  // 超大请求体
  const huge = await call('POST', '/functions/v1/app?action=sync-builtin',
    JSON.stringify({ questions: [{ id: 'q-huge', stem: 'a'.repeat(4 * 1024 * 1024 + 10) }] }));
  eq('超过 4MB → 413', huge.status, 413);
  eq('413 错误码', (await huge.json()).error, 'payload_too_large');

  await close(server);
}

/* ============ 第二阶段：真实种子数据灌入 ============ */
{
  const db = createMemoryDb();
  const auth = createAuth({ ADMIN_USER: USER, ADMIN_PASSWORD: PASS });
  const server = createServer({ db, auth });
  const port = await listen(server);
  const base = 'http://127.0.0.1:' + port;

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

  const bankRes = await fetch(base + '/functions/v1/app?action=bank', { headers: { Authorization: GOOD } });
  const bank = await bankRes.json();
  eq('HTTP 读到的题目数', bank.questions.length, 353);
  eq('HTTP 读到的卡片数', bank.cards.length, 89);
  eq('HTTP 读到的章节数', bank.chapters.length, 32);
  eq('未被截断', bank.truncated, false);
  eq('种子数据标记为内置', bank.questions.every((q) => q.built_in === true), true);

  const perSubject = {};
  bank.questions.forEach((q) => { perSubject[q.subject] = (perSubject[q.subject] || 0) + 1; });
  eq('各科题量', perSubject, { bio: 64, ana: 132, pol: 142, eng: 15 });
  eq('jsonb 字段已还原为对象/数组', Array.isArray(bank.questions[0].opts) && Array.isArray(bank.questions[0].tags), true);

  // 灌入后启用后台，改一条内置题，确认编辑不会被下次启动覆盖
  await fetch(base + '/functions/v1/app?action=claim-owner', { method: 'POST', headers: { Authorization: GOOD, 'Content-Type': 'application/json' }, body: '{}' });
  const target = bank.questions[0];
  const editRes = await fetch(base + '/functions/v1/app?action=upsert-question', {
    method: 'POST',
    headers: { Authorization: GOOD, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: target.id, subject: target.subject, chapter: target.chapter, qtype: target.qtype,
      level: target.level, tags: target.tags, stem: '我在后台改过的题干',
      opts: target.opts, answer: target.answer, explain_text: target.explain_text,
    }),
  });
  eq('编辑内置题成功', (await editRes.json()).created, false);
  const afterEdit = await seedIfEmpty(db, content, () => {});
  eq('重启灌入跳过，不覆盖后台编辑', afterEdit.skipped, true);
  const reread = await (await fetch(base + '/functions/v1/app?action=bank', { headers: { Authorization: GOOD } })).json();
  eq('后台编辑保留', reread.questions.find((q) => q.id === target.id).stem, '我在后台改过的题干');

  await close(server);
}

console.log(`自建后端验证：通过 ${passed}，失败 ${failures.length}`);
if (failures.length) {
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('SELFHOST-OK');

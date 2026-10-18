// Local fixture check for the question-bank Function.
// Runs the real handler against an in-memory database with an injected identity,
// so no cloud credentials, tenant headers or provider access are involved.

import { readFile } from 'node:fs/promises';
import { createFakeSupabase } from './fake-db.mjs';
import { handleBank } from '../functions/handler.mjs';
import { UserContextError } from '../functions/auth.mjs';

const ROOT = new URL('..', import.meta.url);
const FAKE_HEADER = 'x-dev-fake-user';

async function loadWeb() {
  const sandbox = {};
  for (const path of ['web/data/syllabus.js', 'web/data/questions.js', 'web/data/flashcards.js', 'web/api.js']) {
    const src = await readFile(new URL(path, ROOT), 'utf8');
    new Function('window', src)(sandbox);
  }
  return sandbox;
}

const deps = {
  getUser(request) {
    const id = request.headers.get(FAKE_HEADER);
    if (!id) return null;
    return {
      user_id: id, name: id, picture: '', site_id: 'local', host_id: 'local',
      session_expires_at: Math.floor(Date.now() / 1000) + 3600,
    };
  },
  requireUser(request) {
    const user = deps.getUser(request);
    if (!user) throw new UserContextError('login_required', 401);
    return user;
  },
};

let supabase = createFakeSupabase();

async function call(action, { method = 'GET', body, user } = {}) {
  const headers = new Headers();
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (user) headers.set(FAKE_HEADER, user);
  const request = new Request(`https://local.test/functions/v1/app?action=${action}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handleBank({ request, supabase }, deps);
  let data = null;
  try { data = await response.json(); } catch { /* empty body */ }
  return { status: response.status, data, headers: response.headers };
}

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const web = await loadWeb();
const seed = web.Cloud.flattenBuiltin();
eq('flatten: question count', seed.questions.length, 69);
eq('flatten: chapter count', seed.chapters.length, 32);
eq('flatten: card count', seed.cards.length, 46);

// --- routing ---
let r = await call('nope');
eq('unknown action is 404', r.status, 404);
eq('unknown action code', r.data.error, 'not_found');

r = await call('bank', { method: 'POST', body: {} });
eq('GET-only action rejects POST', r.status, 405);
eq('405 carries allow header', r.headers.get('allow'), 'GET');

r = await call('upsert-question');
eq('POST-only action rejects GET', r.status, 405);
eq('405 on write carries allow', r.headers.get('allow'), 'POST');

// --- empty read ---
r = await call('bank');
eq('empty bank reads 200', r.status, 200);
eq('empty bank has no questions', r.data.questions.length, 0);
eq('empty bank not truncated', r.data.truncated, false);

// --- anonymous state and denial ---
r = await call('owner');
eq('owner: anonymous not logged in', r.data.loggedIn, false);
eq('owner: no owner yet', r.data.hasOwner, false);

r = await call('upsert-question', { method: 'POST', body: seed.questions[0] });
eq('anonymous write is 401', r.status, 401);
eq('anonymous write code', r.data.error, 'login_required');

r = await call('claim-owner', { method: 'POST', body: {}, user: 'owner-1' });
eq('claim-owner succeeds', r.status, 200);
eq('claim-owner reports owner', r.data.isOwner, true);
eq('owner row written', supabase.__store.site_settings.length, 1);

r = await call('claim-owner', { method: 'POST', body: {}, user: 'owner-1' });
eq('claim-owner is idempotent', r.status, 200);
eq('claim-owner did not duplicate', supabase.__store.site_settings.length, 1);

r = await call('claim-owner', { method: 'POST', body: {}, user: 'intruder' });
eq('second account cannot claim', r.status, 409);
eq('second account code', r.data.error, 'owner_exists');
eq('owner unchanged', supabase.__store.site_settings[0].owner_id, 'owner-1');

r = await call('owner', { user: 'intruder' });
eq('intruder logged in', r.data.loggedIn, true);
eq('intruder is not owner', r.data.isOwner, false);

r = await call('upsert-question', { method: 'POST', body: seed.questions[0], user: 'intruder' });
eq('non-owner write is 403', r.status, 403);
eq('non-owner write code', r.data.error, 'not_owner');
eq('non-owner wrote nothing', supabase.__store.questions.length, 0);

// --- owner-gated denial before claim ---
const fresh = createFakeSupabase();
const saved = supabase;
supabase = fresh;
r = await call('upsert-card', { method: 'POST', body: seed.cards[0], user: 'owner-1' });
eq('write before claim is 409', r.status, 409);
eq('write before claim code', r.data.error, 'owner_not_claimed');
supabase = saved;

// --- seeding ---
r = await call('sync-builtin', { method: 'POST', body: seed, user: 'owner-1' });
eq('sync succeeds', r.status, 200);
eq('sync inserted all questions', r.data.results[0].inserted, 69);
eq('sync inserted all chapters', r.data.results[1].inserted, 32);
eq('sync inserted all cards', r.data.results[2].inserted, 46);
eq('sync reports nothing failed', r.data.incomplete, false);
eq('questions stored', supabase.__store.questions.length, 69);
eq('seeded rows are built_in', supabase.__store.questions[0].built_in, true);

r = await call('sync-builtin', { method: 'POST', body: seed, user: 'owner-1' });
eq('re-sync inserts nothing', r.data.results[0].inserted, 0);
eq('re-sync skips everything', r.data.results[0].skipped, 69);
eq('re-sync leaves count', supabase.__store.questions.length, 69);

r = await call('sync-builtin', { method: 'POST', body: {}, user: 'owner-1' });
eq('empty sync is 400', r.status, 400);
eq('empty sync code', r.data.error, 'invalid_request');

// --- read back ---
r = await call('bank');
eq('bank returns questions', r.data.questions.length, 69);
eq('bank returns chapters', r.data.chapters.length, 32);
eq('bank returns cards', r.data.cards.length, 46);
const roundTrip = web.Cloud.toAppData(r.data);
eq('round-trip bio questions', roundTrip.QB.bio.length, web.Cloud.BUILTIN.QB.bio.length);
eq('round-trip eng questions', roundTrip.QB.eng.length, web.Cloud.BUILTIN.QB.eng.length);
eq('round-trip keeps desc', typeof roundTrip.SYLLABUS.bio.desc, 'string');
check('round-trip desc not empty', roundTrip.SYLLABUS.bio.desc.length > 0);
eq('round-trip chapter names', roundTrip.SYLLABUS.bio.chapters[0].name, web.Cloud.BUILTIN.SYLLABUS.bio.chapters[0].name);
eq('round-trip keeps card back', roundTrip.CARDS.bio[0].back, web.Cloud.BUILTIN.CARDS.bio[0].back);
eq('round-trip keeps multi answer', JSON.stringify(roundTrip.QB.ana.filter((q) => q.type === 'multi')[0].answer),
  JSON.stringify(web.Cloud.BUILTIN.QB.ana.filter((q) => q.type === 'multi')[0].answer));
eq('stable ordering', r.data.questions[0].id, 'bio-01');

// --- admin create / edit / delete ---
const custom = {
  id: 'my-own-q1', subject: 'bio', chapter: '自建章节', qtype: 'single', level: 1,
  tags: ['自建'], stem: '测试题干', opts: ['甲', '乙', '丙'], answer: 2,
  explain_text: '测试解析', source: '2024 年真题',
};
r = await call('upsert-question', { method: 'POST', body: custom, user: 'owner-1' });
eq('create custom question', r.status, 200);
eq('create reports created', r.data.created, true);
eq('create is not built_in', r.data.built_in, false);
eq('create assigned sort_order', supabase.__store.questions.find((q) => q.id === 'my-own-q1').sort_order, 9000);

r = await call('upsert-question', { method: 'POST', body: { ...custom, stem: '改过的题干' }, user: 'owner-1' });
eq('edit custom question', r.status, 200);
eq('edit reports not created', r.data.created, false);
eq('edit applied', supabase.__store.questions.find((q) => q.id === 'my-own-q1').stem, '改过的题干');
eq('edit kept sort_order', supabase.__store.questions.find((q) => q.id === 'my-own-q1').sort_order, 9000);

r = await call('upsert-question', { method: 'POST', body: { ...seed.questions[0], stem: '内置题改题干' }, user: 'owner-1' });
eq('edit built_in question', r.status, 200);
eq('edit preserved built_in', r.data.built_in, true);
eq('edit preserved sort_order', supabase.__store.questions.find((q) => q.id === seed.questions[0].id).sort_order, 0);

r = await call('upsert-question', { method: 'POST', body: { ...custom, id: 'bio-01' }, user: 'owner-1' });
eq('cannot flip built_in to custom', supabase.__store.questions.find((q) => q.id === 'bio-01').built_in, true);

// client-supplied built_in must be ignored
r = await call('upsert-question', {
  method: 'POST',
  body: { ...custom, id: 'my-own-q2', built_in: true, sort_order: 3 },
  user: 'owner-1',
});
eq('client built_in ignored', supabase.__store.questions.find((q) => q.id === 'my-own-q2').built_in, false);
eq('client sort_order honoured', supabase.__store.questions.find((q) => q.id === 'my-own-q2').sort_order, 3);

r = await call('delete-question', { method: 'POST', body: { id: 'my-own-q2' }, user: 'owner-1' });
eq('delete custom question', r.status, 200);
eq('delete removed row', supabase.__store.questions.some((q) => q.id === 'my-own-q2'), false);

r = await call('delete-question', { method: 'POST', body: { id: 'my-own-q2' }, user: 'owner-1' });
eq('delete twice is 404', r.status, 404);
eq('delete twice code', r.data.error, 'not_found');

r = await call('delete-card', { method: 'POST', body: { id: 'bc-01' }, user: 'owner-1' });
eq('delete built_in card allowed', r.status, 200);

// --- validation ---
const badCases = [
  ['subject', { ...custom, id: 'x-bad-1', subject: 'zzz' }, 'subject'],
  ['qtype', { ...custom, id: 'x-bad-2', qtype: 'essay' }, 'qtype'],
  ['answer out of range', { ...custom, id: 'x-bad-3', answer: 9 }, 'answer'],
  ['answer wrong type', { ...custom, id: 'x-bad-4', answer: '甲' }, 'answer'],
  ['empty stem', { ...custom, id: 'x-bad-5', stem: '' }, 'stem'],
  ['level out of range', { ...custom, id: 'x-bad-6', level: 7 }, 'level'],
  ['bad id charset', { ...custom, id: 'UPPER_BAD' }, 'id'],
  ['multi needs 2 picks', { ...custom, id: 'x-bad-7', qtype: 'multi', answer: [1] }, 'answer'],
  ['multi rejects dupes', { ...custom, id: 'x-bad-8', qtype: 'multi', answer: [1, 1] }, 'answer'],
  ['blank needs string', { ...custom, id: 'x-bad-9', qtype: 'blank', opts: [], answer: 0 }, 'answer'],
];
for (const [name, body, field] of badCases) {
  const res = await call('upsert-question', { method: 'POST', body, user: 'owner-1' });
  eq(`invalid ${name} is 400`, res.status, 400);
  eq(`invalid ${name} names the field`, res.data.field, field);
}
eq('no invalid row was stored', supabase.__store.questions.some((q) => String(q.id).startsWith('x-bad')), false);

r = await call('upsert-question', {
  method: 'POST',
  body: { ...custom, id: 'x-multi-ok', qtype: 'multi', opts: ['甲', '乙', '丙', '丁'], answer: [2, 0] },
  user: 'owner-1',
});
eq('multi answer normalised', JSON.stringify(supabase.__store.questions.find((q) => q.id === 'x-multi-ok').answer), '[0,2]');

r = await call('upsert-chapter', {
  method: 'POST',
  body: { id: 'ch-bio-99', subject: 'bio', name: '新章节', weight: 5, points: ['考点一', '考点二'] },
  user: 'owner-1',
});
eq('create chapter', r.status, 200);
r = await call('upsert-card', {
  method: 'POST',
  body: { id: 'my-card-1', subject: 'eng', chapter: '词汇', front: '正面', back: '背面' },
  user: 'owner-1',
});
eq('create card', r.status, 200);

r = await call('delete-chapter', { method: 'POST', body: { id: 'nonexistent' }, user: 'owner-1' });
eq('delete missing chapter is 404', r.status, 404);

// --- provider failure surfaces safely ---
const broken = {
  from() {
    return {
      select() { return this; }, eq() { return this; }, in() { return this; },
      order() { return this; }, limit() { return this; }, insert() { return this; },
      update() { return this; }, delete() { return this; },
      then(res) { res({ data: null, error: { code: 'XX', message: 'secret tenant detail' } }); },
    };
  },
};
const savedDb = supabase;
supabase = broken;
r = await call('bank');
eq('provider failure is 503', r.status, 503);
eq('provider failure code', r.data.error, 'database_request_failed');
const raw = JSON.stringify(r.data);
check('provider failure leaks nothing', raw.indexOf('secret tenant detail') === -1, raw);
supabase = savedDb;

eq('final question count', supabase.__store.questions.length, seed.questions.length + 2);

console.log(`\npassed ${passed}, failed ${failures.length}`);
if (failures.length) {
  failures.forEach((f) => console.log('  FAIL ' + f));
  process.exit(1);
}
console.log('FUNCTION FIXTURE CHECKS PASSED');

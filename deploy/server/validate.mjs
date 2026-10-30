/* 字段校验 · 与 functions/handler.mjs 的规则逐条对应
   自建部署之后这里是唯一一份校验实现；Qoder 站点冻结为回退备份，两边不再同步。 */

export class AppError extends Error {
  constructor(code, status, field = null) {
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

export const SUBJECTS = new Set(['bio', 'ana', 'pol', 'eng']);
const QTYPES = new Set(['single', 'multi', 'judge', 'blank', 'short']);
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const REQUIRED = Symbol('required');

const bad = (field) => { throw new AppError('invalid_field', 400, field); };

export function str(value, min, max, field, optional = false) {
  if (value === undefined || value === null) {
    if (optional) return null;
    bad(field);
  }
  if (typeof value !== 'string' || value.indexOf('\u0000') !== -1) bad(field);
  const size = Buffer.byteLength(value, 'utf8');
  if (size < min || size > max) bad(field);
  return value;
}

export function int(value, min, max, field, fallback = REQUIRED) {
  if (value === undefined || value === null) {
    if (fallback !== REQUIRED) return fallback;
    bad(field);
  }
  if (!Number.isSafeInteger(value) || value < min || value > max) bad(field);
  return value;
}

function subjectOf(value) {
  const subject = str(value, 3, 3, 'subject');
  if (!SUBJECTS.has(subject)) bad('subject');
  return subject;
}

function strArray(value, maxItems, maxItemBytes, field, optional = false) {
  if (value === undefined || value === null) return optional ? [] : bad(field);
  if (!Array.isArray(value) || value.length > maxItems) bad(field);
  return value.map((item) => str(item, 1, maxItemBytes, field));
}

export function idOf(value) {
  const id = str(value, 3, 64, 'id');
  if (!ID_RE.test(id)) bad('id');
  return id;
}

function answerFor(qtype, answer, opts) {
  if (qtype === 'single' || qtype === 'judge') {
    if (opts.length < 2) bad('opts');
    return int(answer, 0, opts.length - 1, 'answer');
  }
  if (qtype === 'multi') {
    if (opts.length < 3) bad('opts');
    if (!Array.isArray(answer) || answer.length < 2 || answer.length > opts.length) bad('answer');
    const picked = answer.map((item) => int(item, 0, opts.length - 1, 'answer'));
    if (new Set(picked).size !== picked.length) bad('answer');
    return picked.slice().sort((a, b) => a - b);
  }
  return str(answer, 1, qtype === 'blank' ? 600 : 8000, 'answer');
}

export function questionRow(body) {
  const qtype = body.qtype;
  if (typeof qtype !== 'string' || !QTYPES.has(qtype)) bad('qtype');
  const options = qtype === 'blank' || qtype === 'short' ? [] : strArray(body.opts, 8, 1200, 'opts');
  return {
    id: idOf(body.id),
    subject: subjectOf(body.subject),
    chapter: str(body.chapter, 1, 80, 'chapter'),
    qtype,
    level: int(body.level, 1, 3, 'level'),
    tags: strArray(body.tags, 8, 24, 'tags', true),
    stem: str(body.stem, 1, 4000, 'stem'),
    opts: options,
    answer: answerFor(qtype, body.answer, options),
    explain_text: str(body.explain_text, 0, 8000, 'explain_text', true) ?? '',
    source: str(body.source, 1, 120, 'source', true),
    sort_order: int(body.sort_order, 0, 999999, 'sort_order', null),
  };
}

export function chapterRow(body) {
  return {
    id: idOf(body.id),
    subject: subjectOf(body.subject),
    name: str(body.name, 1, 80, 'name'),
    weight: int(body.weight, 0, 100, 'weight'),
    points: strArray(body.points, 200, 800, 'points', true),
    sort_order: int(body.sort_order, 0, 999999, 'sort_order', null),
  };
}

export function cardRow(body) {
  return {
    id: idOf(body.id),
    subject: subjectOf(body.subject),
    chapter: str(body.chapter, 1, 80, 'chapter'),
    front: str(body.front, 1, 600, 'front'),
    back: str(body.back, 1, 8000, 'back'),
    sort_order: int(body.sort_order, 0, 999999, 'sort_order', null),
  };
}

export function parseBody(text) {
  if (typeof text !== 'string' || text.length === 0) throw new AppError('invalid_request', 400);
  let value;
  try { value = JSON.parse(text); } catch { throw new AppError('invalid_request', 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('invalid_request', 400);
  return value;
}

/* ---------------- 账号与进度 ---------------- */

const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
export const MAX_PROGRESS_BYTES = 1024 * 1024;

// 一律转小写存库，登录时同样转，避免 "Admin" 和 "admin" 变成两个账号。
export function usernameOf(value) {
  const name = str(value, 3, 32, 'username').toLowerCase();
  if (!USERNAME_RE.test(name)) bad('username');
  return name;
}

export function passwordOf(value) {
  const password = str(value, 8, 128, 'password');
  if (CONTROL_RE.test(password)) bad('password');
  return password;
}

export function displayNameOf(value) {
  const name = str(value, 1, 40, 'display_name', true);
  if (name === null) return '';
  if (CONTROL_RE.test(name)) bad('display_name');
  return name.trim();
}

// 邀请码的备注只是给管理员自己看的（「发给张三 3班」），可留空。
export function inviteNoteOf(value) {
  const note = str(value, 0, 60, 'note', true);
  if (note === null) return '';
  if (CONTROL_RE.test(note)) bad('note');
  return note.trim();
}

export function progressData(body) {
  const data = body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) bad('data');
  let text;
  try { text = JSON.stringify(data); } catch { bad('data'); }
  // 注册是开放的，所以每个账号能往库里塞多少进度必须有个上限。
  if (Buffer.byteLength(text, 'utf8') > MAX_PROGRESS_BYTES) {
    throw new AppError('progress_too_large', 413, 'data');
  }
  return data;
}

import { getUser as readUser, requireUser as needUser, UserContextError } from "./auth.mjs";

const SUBJECTS = new Set(["bio", "ana", "pol", "eng"]);
const QTYPES = new Set(["single", "multi", "judge", "blank", "short"]);
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const OWNER_ROW = "owner";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_READ_ROWS = 5000;
const MAX_SYNC_RECORDS = 2000;
const CHUNK = 200;
// Admin rows added without an explicit position sort after the bundled set.
const NEW_SORT_ORDER = 9000;

const GET_ACTIONS = new Set(["bank", "owner"]);
const POST_ACTIONS = new Set([
  "claim-owner",
  "upsert-question", "delete-question",
  "upsert-chapter", "delete-chapter",
  "upsert-card", "delete-card",
  "sync-builtin",
]);

class AppError extends Error {
  constructor(code, status, headers = {}, field = null) {
    super(code);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.headers = headers;
    this.field = field;
  }
}

const json = (body, status = 200, headers = {}) => Response.json(body, {
  status,
  headers: { "cache-control": "no-store", ...headers },
});

const fail = (e) => {
  if (e instanceof AppError) {
    return json({ error: e.code, ...(e.field ? { field: e.field } : {}) }, e.status, e.headers);
  }
  if (e instanceof UserContextError) return json({ error: e.code }, e.status);
  // Never echo provider messages, tenant identifiers or request URLs.
  return json({ error: "database_request_failed" }, 503);
};

const bad = (field) => { throw new AppError("invalid_field", 400, {}, field); };
const dbFail = () => { throw new AppError("database_request_failed", 503); };
const REQUIRED = Symbol("required");

function str(value, min, max, field, optional = false) {
  if (value === undefined || value === null) {
    if (optional) return null;
    bad(field);
  }
  if (typeof value !== "string" || value.indexOf("\u0000") !== -1) bad(field);
  const size = new TextEncoder().encode(value).length;
  if (size < min || size > max) bad(field);
  return value;
}

function int(value, min, max, field, fallback = REQUIRED) {
  if (value === undefined || value === null) {
    if (fallback !== REQUIRED) return fallback;
    bad(field);
  }
  if (!Number.isSafeInteger(value) || value < min || value > max) bad(field);
  return value;
}

function subjectOf(value) {
  const subject = str(value, 3, 3, "subject");
  if (!SUBJECTS.has(subject)) bad("subject");
  return subject;
}

function strArray(value, maxItems, maxItemBytes, field, optional = false) {
  if (value === undefined || value === null) return optional ? [] : bad(field);
  if (!Array.isArray(value) || value.length > maxItems) bad(field);
  return value.map((item) => str(item, 1, maxItemBytes, field));
}

function idOf(value) {
  const id = str(value, 3, 64, "id");
  if (!ID_RE.test(id)) bad("id");
  return id;
}

function answerFor(qtype, answer, opts) {
  if (qtype === "single" || qtype === "judge") {
    if (opts.length < 2) bad("opts");
    return int(answer, 0, opts.length - 1, "answer");
  }
  if (qtype === "multi") {
    if (opts.length < 3) bad("opts");
    if (!Array.isArray(answer) || answer.length < 2 || answer.length > opts.length) bad("answer");
    const picked = answer.map((item) => int(item, 0, opts.length - 1, "answer"));
    if (new Set(picked).size !== picked.length) bad("answer");
    return picked.slice().sort((a, b) => a - b);
  }
  return str(answer, 1, qtype === "blank" ? 600 : 8000, "answer");
}

function questionRow(body) {
  const qtype = body.qtype;
  if (typeof qtype !== "string" || !QTYPES.has(qtype)) bad("qtype");
  const options = qtype === "blank" || qtype === "short"
    ? []
    : strArray(body.opts, 8, 1200, "opts");
  return {
    id: idOf(body.id),
    subject: subjectOf(body.subject),
    chapter: str(body.chapter, 1, 80, "chapter"),
    qtype,
    level: int(body.level, 1, 3, "level"),
    tags: strArray(body.tags, 8, 24, "tags", true),
    stem: str(body.stem, 1, 4000, "stem"),
    opts: options,
    answer: answerFor(qtype, body.answer, options),
    explain_text: str(body.explain_text, 0, 8000, "explain_text", true) ?? "",
    source: str(body.source, 1, 120, "source", true),
    sort_order: int(body.sort_order, 0, 999999, "sort_order", null),
  };
}

function chapterRow(body) {
  return {
    id: idOf(body.id),
    subject: subjectOf(body.subject),
    name: str(body.name, 1, 80, "name"),
    weight: int(body.weight, 0, 100, "weight"),
    points: strArray(body.points, 200, 800, "points", true),
    sort_order: int(body.sort_order, 0, 999999, "sort_order", null),
  };
}

function cardRow(body) {
  return {
    id: idOf(body.id),
    subject: subjectOf(body.subject),
    chapter: str(body.chapter, 1, 80, "chapter"),
    front: str(body.front, 1, 600, "front"),
    back: str(body.back, 1, 8000, "back"),
    sort_order: int(body.sort_order, 0, 999999, "sort_order", null),
  };
}

async function readBody(request) {
  let raw;
  try { raw = await request.text(); } catch { throw new AppError("invalid_request", 400); }
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    throw new AppError("payload_too_large", 413);
  }
  let value;
  try { value = JSON.parse(raw); } catch { throw new AppError("invalid_request", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("invalid_request", 400);
  }
  return value;
}

async function readRows(supabase, table, columns) {
  const { data, error } = await supabase.from(table)
    .select(columns)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true })
    .limit(MAX_READ_ROWS);
  if (error || !Array.isArray(data)) dbFail();
  return data;
}

async function readOwnerRow(supabase) {
  const { data, error } = await supabase.from("site_settings")
    .select("id,owner_id")
    .eq("id", OWNER_ROW)
    .limit(1);
  if (error || !Array.isArray(data)) dbFail();
  return data.length ? data[0] : null;
}

async function requireOwner(request, supabase, needUserFn) {
  const user = needUserFn(request);
  const row = await readOwnerRow(supabase);
  if (!row) throw new AppError("owner_not_claimed", 409);
  if (row.owner_id !== user.user_id) throw new AppError("not_owner", 403);
  return user;
}

async function readExisting(supabase, table, id) {
  const { data, error } = await supabase.from(table)
    .select("built_in,sort_order")
    .eq("id", id)
    .limit(1);
  if (error || !Array.isArray(data)) dbFail();
  return data.length ? data[0] : null;
}

// Read-then-branch, so an admin edit cannot silently flip built_in or reorder a
// row that omitted sort_order. A concurrent insert of the same id surfaces as
// duplicate_id rather than overwriting the other writer.
async function upsertRow(supabase, table, row, now) {
  const existing = await readExisting(supabase, table, row.id);
  const order = row.sort_order === null
    ? (existing ? existing.sort_order : NEW_SORT_ORDER)
    : row.sort_order;
  const fields = { ...row, sort_order: order };
  if (existing) {
    const { data, error } = await supabase.from(table)
      .update({ ...fields, updated_at: now })
      .eq("id", row.id)
      .select("id");
    if (error) dbFail();
    if (!Array.isArray(data) || data.length === 0) throw new AppError("write_rejected", 503);
    return { id: row.id, built_in: existing.built_in, created: false };
  }
  const { data, error } = await supabase.from(table)
    .insert({ ...fields, built_in: false, created_at: now, updated_at: now })
    .select("id");
  if (error) {
    if (error.code === "23505") throw new AppError("duplicate_id", 409);
    dbFail();
  }
  if (!Array.isArray(data) || data.length === 0) throw new AppError("write_rejected", 503);
  return { id: row.id, built_in: false, created: true };
}

async function deleteRow(supabase, table, id) {
  idOf(id);
  const { data, error } = await supabase.from(table).delete().eq("id", id).select("id");
  if (error) dbFail();
  if (!Array.isArray(data) || data.length === 0) throw new AppError("not_found", 404);
  return { id, deleted: true };
}

async function existingIds(supabase, table, ids) {
  const found = new Set();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const { data, error } = await supabase.from(table).select("id").in("id", part).limit(CHUNK);
    if (error || !Array.isArray(data)) dbFail();
    for (const row of data) found.add(row.id);
  }
  return found;
}

// Insert-only: seeding must never clobber an admin edit made after a first sync.
async function syncTable(supabase, table, records, now) {
  if (!Array.isArray(records)) throw new AppError("invalid_field", 400, {}, table);
  if (records.length > MAX_SYNC_RECORDS) throw new AppError("too_many_records", 400, {}, table);
  const seen = new Map();
  records.forEach((row, index) => {
    seen.set(row.id, { ...row, sort_order: row.sort_order === null ? index : row.sort_order });
  });
  const rows = [...seen.values()];
  const present = await existingIds(supabase, table, rows.map((row) => row.id));
  const missing = rows.filter((row) => !present.has(row.id));
  let inserted = 0;
  let failed = 0;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const part = missing.slice(i, i + CHUNK)
      .map((row) => ({ ...row, built_in: true, created_at: now, updated_at: now }));
    const { error } = await supabase.from(table).insert(part);
    if (error) failed += part.length; else inserted += part.length;
  }
  return {
    table,
    inserted,
    skipped: rows.length - missing.length,
    failed,
    duplicateIds: records.length - rows.length,
  };
}

const QUESTION_COLUMNS = "id,subject,chapter,qtype,level,tags,stem,opts,answer,explain_text,source,built_in,sort_order";
const CHAPTER_COLUMNS = "id,subject,name,weight,points,sort_order,built_in";
const CARD_COLUMNS = "id,subject,chapter,front,back,sort_order,built_in";

async function readBank(supabase) {
  const [questions, chapters, cards] = await Promise.all([
    readRows(supabase, "questions", QUESTION_COLUMNS),
    readRows(supabase, "syllabus_chapters", CHAPTER_COLUMNS),
    readRows(supabase, "cards", CARD_COLUMNS),
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

async function readOwner(request, supabase, readUserFn) {
  const user = readUserFn(request);
  const row = await readOwnerRow(supabase);
  return {
    loggedIn: user !== null,
    hasOwner: row !== null,
    isOwner: !!(user && row && row.owner_id === user.user_id),
  };
}

async function claimOwner(request, supabase, needUserFn) {
  const user = needUserFn(request);
  const before = await readOwnerRow(supabase);
  if (before) {
    if (before.owner_id === user.user_id) return { claimed: true, isOwner: true };
    throw new AppError("owner_exists", 409);
  }
  const { error } = await supabase.from("site_settings")
    .insert({ id: OWNER_ROW, owner_id: user.user_id, updated_at: new Date().toISOString() });
  if (error && error.code !== "23505") dbFail();
  // Re-read to settle a concurrent claim: only the stored owner_id counts.
  const after = await readOwnerRow(supabase);
  if (!after) dbFail();
  if (after.owner_id !== user.user_id) throw new AppError("owner_exists", 409);
  return { claimed: true, isOwner: true };
}

export async function handleBank({ request, supabase }, deps = {}) {
  const readUserFn = deps.getUser || readUser;
  const needUserFn = deps.requireUser || needUser;
  let action = "";
  try { action = new URL(request.url).searchParams.get("action") || ""; } catch { action = ""; }

  const isGet = GET_ACTIONS.has(action);
  if (!isGet && !POST_ACTIONS.has(action)) return json({ error: "not_found" }, 404);
  if (isGet ? request.method !== "GET" : request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, { allow: isGet ? "GET" : "POST" });
  }

  try {
    if (action === "bank") return json(await readBank(supabase));
    if (action === "owner") return json(await readOwner(request, supabase, readUserFn));

    const now = new Date().toISOString();
    if (action === "claim-owner") return json(await claimOwner(request, supabase, needUserFn));

    await requireOwner(request, supabase, needUserFn);

    if (action.startsWith("delete-")) {
      const body = await readBody(request);
      const table = action === "delete-question" ? "questions"
        : action === "delete-chapter" ? "syllabus_chapters" : "cards";
      return json(await deleteRow(supabase, table, body.id));
    }

    if (action.startsWith("upsert-")) {
      const body = await readBody(request);
      const record = action === "upsert-question" ? await upsertRow(supabase, "questions", questionRow(body), now)
        : action === "upsert-chapter" ? await upsertRow(supabase, "syllabus_chapters", chapterRow(body), now)
        : await upsertRow(supabase, "cards", cardRow(body), now);
      return json(record);
    }

    const body = await readBody(request);
    const results = [];
    if (body.questions !== undefined) {
      results.push(await syncTable(supabase, "questions", body.questions.map(questionRow), now));
    }
    if (body.chapters !== undefined) {
      results.push(await syncTable(supabase, "syllabus_chapters", body.chapters.map(chapterRow), now));
    }
    if (body.cards !== undefined) {
      results.push(await syncTable(supabase, "cards", body.cards.map(cardRow), now));
    }
    if (!results.length) throw new AppError("invalid_request", 400);
    return json({
      results,
      incomplete: results.some((item) => item.failed > 0),
    });
  } catch (e) {
    return fail(e);
  }
}

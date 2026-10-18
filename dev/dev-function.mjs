// Dev-only bridge: runs the real functions/handler.mjs against a file-backed fake
// database so the browser can exercise the actual code path without cloud credentials.
// Identity comes from DEV_USER (or a ?devuser= override), never from a platform header.

import { readFile, writeFile } from 'node:fs/promises';
import { createFakeSupabase } from './fake-db.mjs';
import { handleBank } from '../functions/handler.mjs';
import { UserContextError } from '../functions/auth.mjs';

const STORE = new URL('./.devbank.json', import.meta.url);
const DEFAULT_USER = process.env.DEV_USER === undefined ? 'dev-owner' : process.env.DEV_USER;

const deps = {
  getUser(request) {
    const id = request.headers.get('x-dev-fake-user');
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
try {
  supabase = createFakeSupabase(JSON.parse(await readFile(STORE, 'utf8')));
} catch { /* first run: empty database */ }

async function persist() {
  await writeFile(STORE, JSON.stringify(supabase.__store), 'utf8');
}

async function toWebRequest(req, rawUrl) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value);
  }
  headers.set('x-dev-fake-user', DEFAULT_USER);
  const overridden = rawUrl.searchParams.get('devuser');
  if (overridden !== null) headers.set('x-dev-fake-user', overridden);

  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    init.body = Buffer.concat(chunks);
  }
  return new Request(`https://local.test${rawUrl.pathname}${rawUrl.search}`, init);
}

export async function serveFunction(req, res, rawUrl) {
  let response;
  try {
    response = await handleBank({ request: await toWebRequest(req, rawUrl), supabase }, deps);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'dev_bridge_failed', detail: String(error && error.message) }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') await persist();
  const headers = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

export async function resetDevDatabase() {
  supabase = createFakeSupabase();
  await persist();
}

/* 药大生医初试复习台 · 自建服务
   一个进程同时负责：静态页面、题库/账号接口、会话认证。
   接口路径沿用 /functions/v1/app，所以前端 web/api.js 不需要任何改动。

   页面与内置数据文件是公开可读的，登录只在需要时发生（同步进度、管理内容）；
   要口令保护内容，请在 nginx 那层加，不要指望这个进程。 */

import http from 'node:http';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from './db.mjs';
import { createAuth, verifyPassword, SESSION_COOKIE } from './auth.mjs';
import { handleBank } from './handler.mjs';
import { createMediaStore } from './media.mjs';
import { AppError } from './validate.mjs';
import { loadContent, seedIfEmpty } from './seed.mjs';

const PORT = Number(process.env.PORT || 8080);
// 原生部署时设成 127.0.0.1，让题库接口只能经 nginx 到达；容器部署不发布端口，保持默认即可。
const HOST = process.env.HOST || '0.0.0.0';
const SITE_ROOT = path.resolve(process.env.SITE_ROOT || '../../web');
// 留空表示不存图：上传接口会明确回 upload_unavailable，而不是把文件悄悄丢进代码目录。
const MEDIA_DIR = (process.env.MEDIA_DIR || '').trim();
const API_PATH = '/functions/v1/app';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DB_RETRY_MS = 2000;
const DB_RETRIES = 30;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function send(res, status, headers, body) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  // HEAD 请求的响应体由 Node 自行丢弃，这里只管写头和正文。
  res.writeHead(status, {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(payload);
}

const sendJson = (res, status, body, headers = {}) =>
  send(res, status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }, body);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (chunk) => {
      if (overflow) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // 停止缓冲并排空请求体，让 413 能正常写回，而不是直接掐断连接。
        overflow = true;
        chunks.length = 0;
        req.resume();
        reject(new AppError('payload_too_large', 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!overflow) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', (e) => { if (!overflow) reject(e); });
  });
}

// 路径穿越防线：解析后必须仍落在 SITE_ROOT 内，目录和隐藏文件一律 404。
function resolveStatic(urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch { return null; }
  if (rel.indexOf('\u0000') !== -1) return null;
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.resolve(SITE_ROOT, '.' + path.posix.normalize(rel));
  if (target !== SITE_ROOT && !target.startsWith(SITE_ROOT + path.sep)) return null;
  if (path.basename(target).startsWith('.')) return null;
  return target;
}

async function serveStatic(req, res, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }, '方法不允许');
  }
  const target = resolveStatic(urlPath);
  if (!target) return send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, '未找到');
  let info;
  try { info = await stat(target); } catch { return send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, '未找到'); }
  if (!info.isFile()) return send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, '未找到');
  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  const file = await readFile(target);
  // no-cache 而不是长缓存：迁移期间内容会反复调整，避免看到旧版本还以为没生效。
  send(res, 200, { 'content-type': type, 'cache-control': 'no-cache', 'content-length': file.length }, file);
}

// 生产环境这一段由 nginx 直接发（更快，也不占 Node 的连接）；
// 这里留着是为了本地预览和没配反代时图片照样能显示。
async function serveMedia(req, res, media, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }, '方法不允许');
  }
  const target = media.resolve(urlPath.slice('/media'.length));
  if (!target) return send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, '未找到');
  let info;
  try { info = await stat(target); } catch { return send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, '未找到'); }
  if (!info.isFile()) return send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, '未找到');
  const file = await readFile(target);
  // 文件名是随机十六进制，内容不会变，所以可以放心长缓存。
  send(res, 200, {
    'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'public, max-age=31536000, immutable',
    'content-length': file.length,
  }, file);
}

function parseCookies(header) {  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    const name = part.slice(0, idx).trim();
    if (name && !(name in out)) out[name] = part.slice(idx + 1).trim();
  }
  return out;
}

// nginx 会把 x-forwarded-proto 传进来；直连时看 socket 是否已经是 TLS。
function isSecure(req) {
  if (req.socket && req.socket.encrypted) return true;
  const proto = req.headers['x-forwarded-proto'];
  const first = Array.isArray(proto) ? proto[0] : proto;
  return typeof first === 'string' && first.split(',')[0].trim().toLowerCase() === 'https';
}

/* 注册限流按来源 IP 记，所以这里要分清「谁在跟我说话」。
   x-forwarded-for 是客户端可以随意伪造的头，只有当连接确实来自我们自己那层
   （回环或内网/容器网段的 nginx）时才认它；否则只信 socket，宁可比真实来源粗一点。 */
const INTERNAL_NET = /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const debase = (ip) => String(ip).replace(/^::ffff:/i, '');

function clientIp(req) {
  const peer = debase(req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '');
  if (!INTERNAL_NET.test(peer)) return peer;
  const xff = req.headers['x-forwarded-for'];
  const first = debase((Array.isArray(xff) ? xff[0] : xff || '').split(',')[0]).trim();
  return first || peer;
}

/** 会话 Cookie 优先，其次 HTTP Basic（留给 curl 与安装脚本自检）。
    角色每次都回库读，所以撤权立即生效。查不到就当匿名，绝不抛错挡住静态页面。 */
async function resolveUser(req, db, auth) {
  try {
    const session = auth.readSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (session) {
      const row = await db.findUser(session.userId);
      if (row) return row;
    }
    const basic = auth.basicCredentials(req.headers.authorization);
    if (basic) {
      const row = await db.findUserByUsername(basic.username.toLowerCase());
      if (row && await verifyPassword(basic.password, row.pass_hash)) return row;
    }
  } catch (e) {
    console.error('读取登录状态失败，本次请求按未登录处理:', e instanceof Error ? e.message : e);
  }
  return null;
}

export function createServer({ db, auth, media = null }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://internal');

    if (url.pathname === '/healthz') {
      try {
        await db.ping();
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 503, { ok: false });
      }
    }

    if (media && url.pathname.startsWith('/media/')) {
      return await serveMedia(req, res, media, url.pathname);
    }

    const user = await resolveUser(req, db, auth);

    try {
      if (url.pathname === API_PATH) {
        let bodyText = '';
        if (req.method === 'POST') bodyText = await readBody(req);
        const result = await handleBank(
          { method: req.method, url: req.url, user, bodyText, secure: isSecure(req), ip: clientIp(req) },
          db, auth, media);
        return sendJson(res, result.status, result.body, result.headers);
      }
      return await serveStatic(req, res, url.pathname);
    } catch (e) {
      if (e instanceof AppError) {
        return sendJson(res, e.status, { error: e.code, ...(e.field ? { field: e.field } : {}) });
      }
      console.error('请求处理失败:', e instanceof Error ? e.message : e);
      return sendJson(res, 500, { error: 'server_error' });
    }
  });
}

async function waitForDb(db) {
  for (let attempt = 1; attempt <= DB_RETRIES; attempt += 1) {
    try {
      await db.ping();
      return true;
    } catch (e) {
      if (attempt === DB_RETRIES) {
        console.error(`数据库连不上（已重试 ${attempt} 次）:`, e instanceof Error ? e.message : e);
        return false;
      }
      await new Promise((r) => setTimeout(r, DB_RETRY_MS));
    }
  }
  return false;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('缺少 DATABASE_URL，无法启动');
    process.exit(1);
  }
  const auth = createAuth();
  if (!auth.configured) {
    console.error('ADMIN_USER / ADMIN_PASSWORD 未配置或口令短于 8 位，为避免整站裸奔，拒绝启动');
    process.exit(1);
  }

  const db = await createDb(process.env.DATABASE_URL);
  const ready = await waitForDb(db);
  // 图片存储跟数据库无关，库连不上也照样能建目录。
  const media = MEDIA_DIR ? createMediaStore(MEDIA_DIR) : null;
  if (!media) console.warn('未设置 MEDIA_DIR，后台插图功能不可用（上传会回 upload_unavailable）');

  if (ready) {
    // 灌入失败不阻止启动：前端拿不到云端数据时会自动回落到内置 JS 数据。
    try {
      await seedIfEmpty(db, await loadContent(), (m) => console.log(m));
    } catch (e) {
      console.error('初始化灌入失败:', e instanceof Error ? e.message : e);
    }
    try {
      const result = await auth.ensureAdmin(db);
      console.log(`管理员账号 ${auth.adminUsername} 已${result === 'created' ? '创建' : '同步口令'}`);
    } catch (e) {
      // 管理员建不起来意味着谁都登不进去，这比题库灌入失败严重得多，要显眼地报出来。
      console.error('管理员账号初始化失败，登录与后台管理将不可用:', e instanceof Error ? e.message : e);
    }
  } else {
    console.error('数据库不可用，仍继续启动：页面可访问，题库接口会回落到前端内置数据，登录不可用');
  }

  const server = createServer({ db, auth, media });
  server.listen(PORT, HOST, () => console.log(`复习台服务已启动，监听 ${HOST}:${PORT}，静态目录 ${SITE_ROOT}`));

  const shutdown = () => {
    server.close(async () => {
      try { await db.close(); } catch { /* 进程正在退出 */ }
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// 被 dev/check-selfhost.mjs 之类的测试导入时不要真的起服务
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

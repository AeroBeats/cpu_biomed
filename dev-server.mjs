import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { serveFunction, resetDevDatabase } from './dev/dev-function.mjs';

const ROOT = resolve(join(import.meta.dirname, 'web'));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

const server = createServer(async (req, res) => {
  const rawUrl = new URL(req.url || '/', 'http://127.0.0.1');
  const path = decodeURIComponent(rawUrl.pathname);

  // Same-origin Function route, matching the deployed path.
  if (path === '/functions/v1/app') {
    await serveFunction(req, res, rawUrl);
    return;
  }
  if (path === '/__dev/reset') {
    await resetDevDatabase();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"reset":true}');
    return;
  }

  let file = normalize(join(ROOT, path === '/' ? 'index.html' : path));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  process.stdout.write(`READY http://127.0.0.1:${port}/ pid=${process.pid}\n`);
});

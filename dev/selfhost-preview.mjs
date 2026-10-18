/* 本地起一个自建服务的可访问实例，用于浏览器端联调：
   ELECTRON_RUN_AS_NODE=1 Qoder.exe dev/selfhost-preview.mjs
   打开 http://owner:test-password-123@127.0.0.1:8740/
   数据库用内存替身，进程退出即清空；不会连真实 PostgreSQL。 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
process.env.SITE_ROOT = path.join(ROOT, 'web');

const { createServer } = await import('../deploy/server/index.mjs');
const { createAuth } = await import('../deploy/server/auth.mjs');
const { loadContent, seedIfEmpty } = await import('../deploy/server/seed.mjs');
const { createMemoryDb } = await import('./memory-db.mjs');

const PORT = Number(process.env.PORT || 8740);
const db = createMemoryDb();
await seedIfEmpty(db, await loadContent(), (m) => console.log('[seed]', m));

const auth = createAuth({ ADMIN_USER: 'owner', ADMIN_PASSWORD: 'test-password-123' });
createServer({ db, auth }).listen(PORT, '127.0.0.1', () => {
  console.log(`自建服务预览已启动: http://owner:test-password-123@127.0.0.1:${PORT}/`);
});

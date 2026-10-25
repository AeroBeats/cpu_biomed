/* 本地起一个自建服务的可访问实例，用于浏览器端联调：
   ELECTRON_RUN_AS_NODE=1 Qoder.exe dev/selfhost-preview.mjs
   打开 http://127.0.0.1:8740/ ，用 owner / test-password-123 在页面里登录。
   数据库用内存替身，进程退出即清空；不会连真实 PostgreSQL。 */

import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
process.env.SITE_ROOT = path.join(ROOT, 'web');

const { createServer } = await import('../deploy/server/index.mjs');
const { createAuth } = await import('../deploy/server/auth.mjs');
const { createMediaStore } = await import('../deploy/server/media.mjs');
const { loadContent, seedIfEmpty } = await import('../deploy/server/seed.mjs');
const { createMemoryDb } = await import('./memory-db.mjs');

const PORT = Number(process.env.PORT || 8740);
const ADMIN_USER = 'owner';
const ADMIN_PASSWORD = 'test-password-123';

const db = createMemoryDb();
await seedIfEmpty(db, await loadContent(), (m) => console.log('[seed]', m));

const auth = createAuth({ ADMIN_USER, ADMIN_PASSWORD });
await auth.ensureAdmin(db);

// 配图落到临时目录，退出时清掉，免得预览用的测试图留在仓库里。
const mediaDir = await mkdtemp(path.join(os.tmpdir(), 'cpubiomed-preview-media-'));
const media = createMediaStore(mediaDir);

createServer({ db, auth, media }).listen(PORT, '127.0.0.1', () => {
  console.log(`自建服务预览已启动: http://127.0.0.1:${PORT}/`);
  console.log(`管理员账号 ${ADMIN_USER} / ${ADMIN_PASSWORD}（在页面的「登录」里输入）`);
  console.log(`配图临时目录 ${mediaDir}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await rm(mediaDir, { recursive: true, force: true });
    process.exit(0);
  });
}

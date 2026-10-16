/* 首次启动时把仓库内置内容灌进空库。
   只插不改：库里已经有题就整表跳过，绝不覆盖你在后台做过的编辑。 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { syncTable } from './handler.mjs';
import { questionRow, chapterRow, cardRow } from './validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function loadContent(file = path.join(HERE, 'content.json')) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function seedIfEmpty(db, content, log = () => {}) {
  const existing = await db.count('questions');
  if (existing > 0) {
    log(`题库已有 ${existing} 条记录，跳过初始化灌入`);
    return { skipped: true, existing };
  }
  const now = new Date().toISOString();
  const results = [];
  // 种子数据走和接口完全相同的校验，避免把不合规的行写进库里
  for (const [table, key, shape] of [
    ['syllabus_chapters', 'chapters', chapterRow],
    ['questions', 'questions', questionRow],
    ['cards', 'cards', cardRow],
  ]) {
    const records = content[key];
    if (Array.isArray(records) && records.length) {
      results.push(await syncTable(db, table, records.map(shape), now));
    }
  }
  const inserted = results.reduce((n, r) => n + r.inserted, 0);
  const failed = results.reduce((n, r) => n + r.failed, 0);
  log(`初始化灌入 ${inserted} 条记录` + (failed ? `，失败 ${failed} 条` : ''));
  return { skipped: false, results, inserted, failed };
}

// docker compose exec api npm run seed —— 手工重灌（同样只插不改）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createDb } = await import('./db.mjs');
  const db = await createDb(process.env.DATABASE_URL);
  try {
    const outcome = await seedIfEmpty(db, await loadContent(), console.log);
    process.exitCode = outcome.failed ? 1 : 0;
  } catch (e) {
    console.error('灌入失败:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

/* 把浏览器导出的 qoder-export-*.json 变成自建服务器的种子与进度恢复脚本
   用法：node deploy/tools/import-bundle.mjs deploy/migrate/qoder-export-2026-10-16.json

   产出：
     deploy/server/content.json          云端题库 → 首次启动自动灌入
     deploy/migrate/restore-progress.js  学习进度 → 在新站点控制台粘贴一次即可恢复
   顺带打印云端与仓库内置内容的差异，让你确认没有漏掉后台手动加的题。 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY = path.resolve(HERE, '..');
const CONTENT = path.join(DEPLOY, 'server', 'content.json');
const MIGRATE_DIR = path.join(DEPLOY, 'migrate');

const NS = 'cpuBioMed.';

const bundlePath = process.argv[2];
if (!bundlePath) {
  console.error('用法：node deploy/tools/import-bundle.mjs <qoder-export-*.json>');
  process.exit(1);
}

let bundle;
try {
  bundle = JSON.parse(readFileSync(path.resolve(bundlePath), 'utf8'));
} catch (e) {
  console.error('导出文件读不出来：', e.message);
  process.exit(1);
}

// 支持两种来源：
//   A. deploy/tools/export-from-qoder.js 导出的 { bank, progress }（含学习进度，推荐）
//   B. 网站「内容管理 → 导出全部内容 JSON」导出的 { format:'cpu-biomed-bank/1', ... }（只有内容）
const fromAdminButton = bundle.format === 'cpu-biomed-bank/1';
const bank = fromAdminButton ? bundle : bundle.bank;
if (!bank || !Array.isArray(bank.questions)) {
  console.error('文件里找不到题库数据。请确认是用 export-from-qoder.js 导出的，'
    + '或者是网站「内容管理 → 导出全部内容 JSON」下载的文件。');
  process.exit(1);
}
if (bank.truncated) {
  console.error('导出被截断（truncated=true），单表超过 5000 行，需要分批导出后再迁移。');
  process.exit(1);
}
console.log(fromAdminButton
  ? '来源：网站后台「导出全部内容 JSON」（不含学习进度，进度需另用 export-from-qoder.js 导出）'
  : '来源：export-from-qoder.js 导出包（含学习进度）');

const pick = (rows, fields) => rows.map((row) => {
  const out = {};
  for (const f of fields) if (row[f] !== undefined) out[f] = row[f];
  return out;
});

const questions = pick(bank.questions, ['id', 'subject', 'chapter', 'qtype', 'level', 'tags',
  'stem', 'opts', 'answer', 'explain_text', 'source', 'built_in', 'sort_order']);
const chapters = pick(bank.chapters || [], ['id', 'subject', 'name', 'weight', 'points', 'built_in', 'sort_order']);
const cards = pick(bank.cards || [], ['id', 'subject', 'chapter', 'front', 'back', 'built_in', 'sort_order']);

// ---- 与仓库内置内容比对，指出只有云端才有的记录 ----
if (existsSync(CONTENT)) {
  const local = JSON.parse(readFileSync(CONTENT, 'utf8'));
  const diff = (cloudRows, localRows, label) => {
    const localIds = new Set((localRows || []).map((r) => r.id));
    const cloudOnly = cloudRows.filter((r) => !localIds.has(r.id));
    const localIdsInCloud = new Set(cloudRows.map((r) => r.id));
    const localOnly = (localRows || []).filter((r) => !localIdsInCloud.has(r.id));
    console.log(`  ${label}: 云端 ${cloudRows.length} / 内置 ${localRows ? localRows.length : 0}`
      + `，仅云端有 ${cloudOnly.length}${cloudOnly.length ? ' → ' + cloudOnly.slice(0, 10).map((r) => r.id).join(', ') : ''}`
      + `，仅内置有 ${localOnly.length}${localOnly.length ? ' → ' + localOnly.slice(0, 10).map((r) => r.id).join(', ') : ''}`);
    return cloudOnly.length;
  };
  console.log('云端 vs 仓库内置：');
  diff(questions, local.questions, '题目');
  diff(chapters, local.chapters, '章节');
  diff(cards, local.cards, '卡片');
} else {
  console.log('提示：deploy/server/content.json 不存在，跳过差异比对（先跑 build-seed.mjs 可比对）。');
}

writeFileSync(CONTENT, JSON.stringify({
  generated_at: new Date().toISOString(),
  source: 'qoder-cloud-export',
  exported_at: bundle.exported_at || bundle.exportedAt || null,
  origin: bundle.origin || null,
  questions, chapters, cards,
}), 'utf8');
console.log('\n已写入', path.relative(path.resolve(DEPLOY, '..'), CONTENT),
  `：题目 ${questions.length}，章节 ${chapters.length}，卡片 ${cards.length}`);

// ---- 学习进度 ----
mkdirSync(MIGRATE_DIR, { recursive: true });
const progress = bundle.progress || {};
const keys = Object.keys(progress).filter((k) => k.indexOf(NS) === 0).sort();
const restorePath = path.join(MIGRATE_DIR, 'restore-progress.js');

if (!keys.length) {
  writeFileSync(restorePath, '// 导出文件里没有 cpuBioMed.* 进度数据，无需恢复。\n', 'utf8');
  console.log('导出文件里没有进度数据，已生成空的 restore-progress.js');
} else {
  const payload = {};
  for (const k of keys) payload[k] = progress[k];
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  writeFileSync(restorePath, `/* 在新站点的浏览器控制台里整段粘贴运行，然后刷新页面。
   来源：${bundle.origin || '未知'}，导出时间 ${bundle.exported_at || bundle.exportedAt || '未知'}。
   共 ${keys.length} 项：${keys.map((k) => k.slice(NS.length)).join(', ')} */
(function () {
  var DATA = ${JSON.stringify(payload)};
  var n = 0;
  Object.keys(DATA).forEach(function (k) { localStorage.setItem(k, DATA[k]); n++; });
  console.log('已写入 ' + n + ' 项进度，请刷新页面。');
})();
`, 'utf8');
  console.log('已写入', path.relative(path.resolve(DEPLOY, '..'), restorePath),
    `：${keys.length} 项进度（${(bytes / 1024).toFixed(1)} KB）`);
  console.log('  →', keys.map((k) => k.slice(NS.length)).join(', '));
}

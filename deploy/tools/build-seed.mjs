/* 从 web/data/*.js 生成 deploy/server/content.json
   逻辑与 web/api.js 里的 flattenBuiltin() 逐行对应，保证自建库和 Qoder 云端
   「一键上传」得到的是同一份内容。
   用法：node deploy/tools/build-seed.mjs */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const WEB = path.join(ROOT, 'web');
const OUT = path.join(HERE, '..', 'server', 'content.json');

const DATA_FILES = [
  'data/syllabus.js', 'data/questions.js', 'data/flashcards.js',
  'data/plan.js', 'data/questions_extra.js', 'data/cards_extra.js',
];

globalThis.window = {};
for (const file of DATA_FILES) {
  const full = path.join(WEB, file);
  // 内置数据是浏览器脚本，用间接 eval 在全局作用域执行
  (0, eval)(readFileSync(full, 'utf8'));
}

const { QB, SYLLABUS, CARDS } = globalThis.window;
if (!QB || !SYLLABUS || !CARDS) {
  console.error('未能从 web/data 读到 QB / SYLLABUS / CARDS，检查脚本加载顺序');
  process.exit(1);
}

const SUBJECTS = ['bio', 'ana', 'pol', 'eng'];
const chapterId = (subject, index) => 'ch-' + subject + '-' + (index + 1);

const questions = [];
const chapters = [];
const cards = [];
let qi = 0; let ci = 0; let ki = 0;

for (const s of SUBJECTS) {
  for (const q of QB[s] || []) {
    questions.push({
      id: q.id, subject: s, chapter: q.chapter, qtype: q.type, level: q.level,
      tags: q.tags || [], stem: q.stem, opts: q.options || [], answer: q.answer,
      explain_text: q.explain || '', sort_order: qi++,
    });
  }
  for (const [i, c] of ((SYLLABUS[s] || {}).chapters || []).entries()) {
    chapters.push({
      id: chapterId(s, i), subject: s, name: c.name, weight: c.weight,
      points: c.points || [], sort_order: ci++,
    });
  }
  for (const c of CARDS[s] || []) {
    cards.push({
      id: c.id, subject: s, chapter: c.chapter, front: c.front, back: c.back, sort_order: ki++,
    });
  }
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), questions, chapters, cards }), 'utf8');

const perSubject = {};
for (const q of questions) perSubject[q.subject] = (perSubject[q.subject] || 0) + 1;
console.log('content.json 已生成:', path.relative(ROOT, OUT));
console.log('  questions', questions.length, JSON.stringify(perSubject));
console.log('  chapters ', chapters.length);
console.log('  cards    ', cards.length);

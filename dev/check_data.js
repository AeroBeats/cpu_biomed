// 本地数据完整性校验：node dev/check_data.js（仅开发用，不打包）
const fs = require('fs');
const path = require('path');
global.window = {};
for (const f of ['data/syllabus.js', 'data/questions.js', 'data/flashcards.js', 'data/plan.js', 'data/questions_extra.js', 'data/cards_extra.js']) {
  eval(fs.readFileSync(path.join(__dirname, '..', 'web', f), 'utf8'));
}
const QB = window.QB, CARDS = window.CARDS;
const errs = [];
const ids = new Set();
let total = 0;
for (const s of Object.keys(QB)) {
  for (const q of QB[s]) {
    total++;
    if (ids.has(q.id)) errs.push('dup id ' + q.id);
    ids.add(q.id);
    if (!q.stem || q.stem.length < 4) errs.push(q.id + ' bad stem');
    if (q.type === 'single' || q.type === 'multi' || q.type === 'judge') {
      if (!Array.isArray(q.options) || (q.type === 'judge' ? q.options.length !== 2 : q.options.length < 4)) errs.push(q.id + ' bad options');
      if (q.options.some(o => !o || o.length < 1)) errs.push(q.id + ' empty option');
      if (q.type === 'multi') {
        if (!Array.isArray(q.answer) || q.answer.length < 2) errs.push(q.id + ' bad multi answer');
        else if (q.answer.some(i => i < 0 || i >= q.options.length)) errs.push(q.id + ' multi idx out of range');
      } else if (typeof q.answer !== 'number' || q.answer < 0 || q.answer >= q.options.length) {
        errs.push(q.id + ' bad answer ' + q.answer);
      }
    } else if (q.type === 'blank') {
      if (typeof q.answer !== 'string' || !q.answer) errs.push(q.id + ' bad blank answer');
    } else if (q.type === 'short') {
      if (typeof q.answer !== 'string' || q.answer.length < 20) errs.push(q.id + ' bad short answer');
    } else errs.push(q.id + ' unknown type ' + q.type);
    if (!q.explain || q.explain.length < 10) errs.push(q.id + ' missing explain');
    if (!q.chapter) errs.push(q.id + ' missing chapter');
  }
}
let ct = 0; const cids = new Set();
for (const s of Object.keys(CARDS)) for (const c of CARDS[s]) {
  ct++;
  if (cids.has(c.id)) errs.push('dup card ' + c.id);
  cids.add(c.id);
  if (!c.front || !c.back || c.back.length < 8) errs.push(c.id + ' bad card');
}
const per = {}; for (const s of Object.keys(QB)) per[s] = QB[s].length;
const cper = {}; for (const s of Object.keys(CARDS)) cper[s] = CARDS[s].length;
console.log('questions per subj', JSON.stringify(per), 'total', total);
console.log('cards per subj', JSON.stringify(cper), 'total', ct);
if (errs.length) { console.log('ERRORS', errs.length); errs.slice(0, 20).forEach(e => console.log(' -', e)); process.exit(1); }
console.log('DATA-OK');

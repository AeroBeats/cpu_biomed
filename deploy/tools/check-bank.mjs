/* 题库 JSON 离线体检 · 导入之前先在本地跑一遍
   用法:
     node deploy/tools/check-bank.mjs 我的题库.json
     node deploy/tools/check-bank.mjs 我的题库.json --strict   # 警告也算不通过
     node deploy/tools/check-bank.mjs 我的题库.json --json     # 机器可读输出

   为什么需要它：后台「导入 JSON」是一条一条往接口发的，某条被拒时只累计一个数字，
   三百条里错了哪几条、错在哪个字段，界面上看不出来。这个脚本用的是
   deploy/server/validate.mjs 里同一份规则（直接 import，不是抄一遍），
   所以「这里通过」就等于「接口会收下」，另外再补几类接口不管、但会让人白忙一场的写法问题。

   退出码：0 = 可以导入；1 = 有错误（或 --strict 下有警告）；2 = 文件本身读不了/不是 JSON。 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { questionRow, chapterRow, cardRow } from '../server/validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN = path.join(HERE, '..', 'server', 'content.json');

const KINDS = [
  { key: 'questions', label: '题目', shape: questionRow },
  { key: 'chapters', label: '章节', shape: chapterRow },
  { key: 'cards', label: '背诵卡', shape: cardRow },
];

// 与 validate.mjs 逐条对应；这里只是为了把「不合规」翻译成人能照着改的话。
const LIMITS = {
  questions: {
    id: '3–64 位小写字母、数字和短横线，且以字母或数字开头',
    subject: '只能是 bio（生物化学）/ ana（分析化学）/ pol（政治）/ eng（英语一）',
    chapter: '1–80 字节，要和考纲里的章节名一致，否则按章节筛题会筛不到',
    qtype: '只能是 single / multi / judge / blank / short',
    level: '只能是整数 1（了解）/ 2（掌握）/ 3（重点）',
    tags: '最多 8 个，每个 1–24 字节',
    stem: '1–4000 字节（一个汉字算 3 字节）',
    opts: 'single/judge 至少 2 个、multi 至少 3 个，最多 8 个，每个 1–1200 字节；blank/short 不要给这个字段',
    answer: 'single/judge 是选项下标（从 0 开始的整数）；multi 是至少 2 个不重复下标的数组；blank 是 1–600 字节的文本；short 是 1–8000 字节的文本',
    explain_text: '最多 8000 字节，可以留空',
    source: '最多 120 字节，可以留空',
    sort_order: '0–999999 的整数，可以省略',
  },
  chapters: {
    id: '3–64 位小写字母、数字和短横线，且以字母或数字开头',
    subject: '只能是 bio / ana / pol / eng',
    name: '1–80 字节',
    weight: '0–100 的整数（估分占比，方法论章节填 0）',
    points: '最多 200 条，每条 1–800 字节',
    sort_order: '0–999999 的整数，可以省略',
  },
  cards: {
    id: '3–64 位小写字母、数字和短横线，且以字母或数字开头',
    subject: '只能是 bio / ana / pol / eng',
    chapter: '1–80 字节',
    front: '1–600 字节',
    back: '1–8000 字节',
    sort_order: '0–999999 的整数，可以省略',
  },
};

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
// 图片地址的放行规则和 web/app.js 里的 IMG_SRC_OK 一致。
const IMG_SRC_OK = /^(https?:\/\/[^/\s]|\/media\/)/i;
const IMG_RE = /!\[[^\]\n]*\]\(([^)\s]+)\)/g;

const bytes = (v) => Buffer.byteLength(String(v), 'utf8');
// 校验工具自己不能因为用户写错类型就崩掉——数组字段给了字符串也要照常往下查。
const asList = (v) => (Array.isArray(v) ? v : []);

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '数组';
  return typeof v === 'string' ? '字符串' : typeof v;
}

/* 接口只会回一个 invalid_field + 字段名，这里根据实际值把原因说清楚。 */
function explain(kind, field, row) {
  const rule = (LIMITS[kind] && LIMITS[kind][field]) || '格式不合规';
  const value = row[field];
  const shown = value === undefined ? '（缺失）' : JSON.stringify(value).slice(0, 60);
  if (value === undefined || value === null) return `缺少必填字段。${field}：${rule}`;
  if (typeof value === 'string' && !value.trim()) return `${field} 不能是空字符串。规则：${rule}`;
  if (field === 'id') {
    if (typeof value !== 'string') return `编号必须是字符串，当前是 ${typeName(value)}`;
    if (!ID_RE.test(value)) {
      return `编号 "${value}" 不合规则：只能用小写字母、数字和短横线，且以字母或数字开头（大写、下划线、空格都不行）`;
    }
    if (value.length < 3) return `编号 "${value}" 太短了，至少要 3 个字符`;
    return `编号 "${value}" 不合规。规则：${rule}`;
  }
  if (field === 'answer') return explainAnswer(row);
  if (field === 'opts') {
    const n = Array.isArray(value) ? value.length : -1;
    if (n === 0) return '选项是空数组，至少要给 2 个（填空题和简答题不要写 opts 字段）';
    if (n > 0 && n < 2) return `只给了 ${n} 个选项，单选和判断至少要 2 个、多选至少要 3 个`;
    if (n > 8) return `给了 ${n} 个选项，最多 8 个`;
  }
  if (typeof value === 'string') {
    const max = /(\d+) 字节/.exec(rule);
    if (max && bytes(value) > Number(max[1])) {
      return `太长了：${bytes(value)} 字节 / ${value.length} 个字符，上限 ${max[1]} 字节（一个汉字算 3 字节）`;
    }
  }
  if (Array.isArray(value)) {
    const maxItems = /最多 (\d+) (?:个|条)/.exec(rule);
    if (maxItems && value.length > Number(maxItems[1])) return `给了 ${value.length} 项，上限 ${maxItems[1]} 项。${rule}`;
    const longest = value.reduce((n, v) => Math.max(n, bytes(v)), 0);
    const maxItem = /每个? ?1[–-](\d+) 字节/.exec(rule);
    if (maxItem && longest > Number(maxItem[1])) {
      return `有一项长达 ${longest} 字节，单项上限 ${maxItem[1]} 字节`;
    }
  }
  return `${field} 当前是 ${shown}。规则：${rule}`;
}

function explainAnswer(row) {
  const opts = Array.isArray(row.opts) ? row.opts : [];
  const shown = JSON.stringify(row.answer).slice(0, 60);
  switch (row.qtype) {
    case 'single':
    case 'judge':
      return `单选题的 answer 必须是选项下标（0 到 ${Math.max(opts.length - 1, 1)} 的整数，A=0、B=1），当前是 ${shown}`;
    case 'multi':
      return `多选题的 answer 必须是至少 2 个**不重复**的下标组成的数组，当前是 ${shown}`;
    case 'blank':
      return `填空题的 answer 必须是 1–600 字节的文本（不是下标），当前是 ${shown}`;
    case 'short':
      return `简答题的 answer 必须是 1–8000 字节的文本（不是下标），当前是 ${shown}`;
    default:
      return `answer 的形式由 qtype 决定，但 qtype 当前是 ${JSON.stringify(row.qtype)}，先把题型改对。${LIMITS.questions.answer}`;
  }
}

/* 接口是一次只报第一个错的字段，三百条里逐条改会很折磨人。
   这里把出错的字段换成一个合法桩值再校验一次，于是同一行的每个坏字段都能被列出来。
   桩值只是为了让校验能往后走，报出来的原因始终按用户原本写的值解释。 */
const STUBS = {
  id: 'stub-id', subject: 'bio', chapter: '章', qtype: 'single', level: 2, tags: [],
  stem: '题干', opts: ['甲', '乙'], answer: 0, explain_text: '', source: null, sort_order: null,
  name: '章节', weight: 0, points: [], front: '正面', back: '背面',
};

function probeRow(kind, row, where, rep) {
  const probe = { ...row };
  const reported = new Set();
  let ok = false;
  for (let i = 0; i < 14 && !ok; i++) {
    try {
      kind.shape(probe);
      ok = true;
    } catch (e) {
      const field = e.field;
      // 同一字段连着报错，或者错在没有桩值的字段上，就别再绕下去了。
      if (!field || reported.has(field) || !(field in STUBS)) {
        if (field && !reported.has(field)) rep.error(where, field, explain(kind.key, field, row));
        break;
      }
      reported.add(field);
      rep.error(where, field, explain(kind.key, field, row));
      probe[field] = STUBS[field];
      // answer 的合法范围取决于 qtype 和 opts，桩值必须三个一起换，否则桩本身又会触发新错。
      if (field === 'qtype' || field === 'opts' || field === 'answer') {
        probe.qtype = 'single';
        probe.opts = ['甲', '乙'];
        probe.answer = 0;
      }
    }
  }
  return ok;
}

function createReport() {
  const errors = [];
  const warnings = [];
  return {
    errors,
    warnings,
    error: (where, field, text) => errors.push({ where, field, text }),
    // group 用来折叠同类警告：整份导出再导回时，「编号会覆盖内置内容」能有几百条，
    // 全打出来只会把真正的错误淹掉。
    warn: (where, field, text, group = null) => warnings.push({ where, field, text, group }),
  };
}

/* 公式和图片标记的写法检查。接口不会管这些，写错了只会「原样显示成文字」，
   人在三百条里很难发现，所以在导入前就指出来。 */
function checkRichText(rep, where, field, text) {
  if (typeof text !== 'string' || !text) return;
  const display = (text.match(/\$\$/g) || []).length;
  const dollars = (text.match(/\$/g) || []).length;
  if (display % 2 !== 0) {
    rep.warn(where, field, `$$ 出现了 ${display} 次（奇数），独立公式没有闭合，会原样显示成文字`);
  } else if ((dollars - display * 2) % 2 !== 0) {
    rep.warn(where, field, `$ 出现了 ${dollars} 次，去掉 $$ 之后还剩奇数个，行内公式可能没有闭合；` +
      '写价格之类的美元符号要当心，它会被当成公式的起始');
  }
  if ((text.match(/\*\*/g) || []).length % 2 !== 0) {
    rep.warn(where, field, '** 出现了奇数次，加粗没有闭合');
  }
  IMG_RE.lastIndex = 0;
  let m;
  while ((m = IMG_RE.exec(text)) !== null) {
    if (!IMG_SRC_OK.test(m[1])) {
      rep.warn(where, field, `图片地址 "${m[1].slice(0, 60)}" 不会被渲染：只放行 http(s):// 和站内 /media/ 开头的地址`);
    }
  }
  if (/\\ce\s*\{/.test(text) && !/\$/.test(text)) {
    rep.warn(where, field, '写了 \\ce{…} 化学式却没有包在 $ 里，不会渲染');
  }
}

function plainFieldWarn(rep, where, field, text) {
  if (typeof text !== 'string') return;
  if (/[$*]|!\[/.test(text)) {
    rep.warn(where, field, `${field} 是纯文本字段，里面的 $ ** ![] 不会渲染成公式或图片，会原样显示`);
  }
}

function rowWhere(label, index, row) {
  const id = row && typeof row === 'object' && row.id ? ` id=${row.id}` : '';
  return `${label} 第 ${index + 1} 条${id}`;
}

/* 校验结果是一个纯数据对象，读文件失败/不是 JSON 时带 fatal。
   这样 dev/check-selfhost.mjs 可以直接 import 来断言模板本身没写坏，
   而不用去解析控制台输出。 */
export async function checkBankFile(file, { noBuiltin = false } = {}) {
  const resolved = path.resolve(file);
  let text;
  try {
    text = await readFile(resolved, 'utf8');
  } catch (e) {
    return { file: resolved, fatal: `读不了文件 ${resolved}: ${e.message}` };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return {
      file: resolved,
      fatal: `JSON 解析失败：${e.message}\n` +
        '常见原因：末尾多了逗号、用了单引号、或者从 Word/网页复制过来带进了全角引号。',
    };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      file: resolved,
      fatal: '顶层必须是一个对象，形如 { "questions": [...], "chapters": [...], "cards": [...] }',
    };
  }

  const rep = createReport();
  const seen = new Map();          // id -> 出现在哪
  const counts = {};
  let mediaRefs = 0;
  let mathRows = 0;

  if (data.format !== undefined && data.format !== 'cpu-biomed-bank/1') {
    rep.warn('文件', 'format', `format 是 "${data.format}"，导入时不看这个字段，但建议写成 cpu-biomed-bank/1`);
  }
  Object.keys(data).forEach((k) => {
    if (k.startsWith('_')) return;                      // _开头的键当注释用，模板里就有
    if (!['format', 'exportedAt', 'origin', 'generated_at', 'questions', 'chapters', 'cards'].includes(k)) {
      rep.warn('文件', k, `顶层多了 "${k}" 这个键，导入时会被忽略（是不是想写 questions / chapters / cards？）`);
    }
  });

  const builtin = await loadBuiltinIds(noBuiltin);

  for (const kind of KINDS) {
    const list = data[kind.key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      rep.error('文件', kind.key, `"${kind.key}" 必须是数组`);
      continue;
    }
    counts[kind.key] = list.length;
    list.forEach((row, i) => {
      const where = rowWhere(kind.label, i, row);
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        rep.error(where, null, `这一条不是对象，而是 ${typeName(row)}`);
        return;
      }
      // 字段名写错是最常见的静默失败：接口只挑认识的字段，写错的会被直接丢掉。
      Object.keys(row).forEach((k) => {
        if (k.startsWith('_')) return;
        if (!(k in LIMITS[kind.key])) {
          const guess = { explain: 'explain_text', type: 'qtype', options: 'opts', difficulty: 'level' }[k];
          rep.warn(where, k, `多了不认识的字段 "${k}"，导入时会被忽略${guess ? `（是不是想写 ${guess}？）` : ''}`);
        }
      });
      probeRow(kind, row, where, rep);

      // 编号本身不合法时上面已经报过了，这里只在它是个像样的字符串时再查重、查覆盖。
      const id = row.id;
      if (typeof id === 'string' && ID_RE.test(id)) {
        if (seen.has(id)) {
          rep.error(where, 'id', `编号 "${id}" 重复了，另一处是「${seen.get(id)}」；导入时后一条会覆盖前一条`);
        } else {
          seen.set(id, where);
        }
        const hit = builtin.get(id);
        if (hit) {
          rep.warn(where, 'id', `编号 "${id}" 已经是${hit}，导入会**整条覆盖**它（不是合并）`, 'builtin-id');
        }
        if (/^demo-/.test(id)) {
          rep.warn(where, 'id', `编号 "${id}" 还是模板里的示例，正式导入前请改成自己的编号`, 'demo-id');
        }
      }

      // 富文本字段：公式与图片
      let rich = false;
      const scan = (field, value) => {
        if (typeof value !== 'string') return;
        if (/\$|!\[/.test(value)) rich = true;
        checkRichText(rep, where, field, value);
        if (value.indexOf('/media/') !== -1) mediaRefs += 1;
      };
      if (kind.key === 'questions') {
        scan('stem', row.stem);
        scan('explain_text', row.explain_text);
        asList(row.opts).forEach((o, k) => scan(`opts[${k}]`, o));
        if (row.qtype === 'blank' || row.qtype === 'short') scan('answer', row.answer);
        plainFieldWarn(rep, where, 'chapter', row.chapter);
        asList(row.tags).forEach((t) => plainFieldWarn(rep, where, 'tags', t));
        plainFieldWarn(rep, where, 'source', row.source);
        if (row.qtype === 'blank' && typeof row.answer === 'string' && row.answer.indexOf('___') !== -1) {
          rep.warn(where, 'answer', '参考答案里出现了 ___，空位应该写在 stem 里，不是答案里');
        }
      } else if (kind.key === 'chapters') {
        asList(row.points).forEach((p, k) => scan(`points[${k}]`, p));
        plainFieldWarn(rep, where, 'name', row.name);
      } else {
        scan('front', row.front);
        scan('back', row.back);
        plainFieldWarn(rep, where, 'chapter', row.chapter);
      }
      if (rich) mathRows += 1;
    });
  }

  const total = KINDS.reduce((n, k) => n + (counts[k.key] || 0), 0);
  if (!total) {
    rep.error('文件', null, `questions / chapters / cards 一个都没有（实际看到的顶层键：${Object.keys(data).join(', ')}）`);
  }

  if (mediaRefs) {
    rep.warn('文件', null,
      `共 ${mediaRefs} 处引用了 /media/ 图片。图片是服务器上的文件、不在 JSON 里：` +
      '换服务器或恢复备份时，要把 media 目录（Docker 是 mediadata 卷）一起带过去，否则题目里的图会 404', 'media');  }

  return {
    file: resolved,
    fatal: null,
    counts,
    total,
    rowsWithMathOrImage: mathRows,
    errors: rep.errors,
    warnings: rep.warnings,
  };
}

async function loadBuiltinIds(skip) {
  const map = new Map();
  if (skip) return map;
  try {
    const content = JSON.parse(await readFile(BUILTIN, 'utf8'));
    for (const kind of KINDS) {
      asList(content[kind.key]).forEach((row) => map.set(row.id, `内置的${kind.label} ${row.id}`));
    }
  } catch {
    return map;   // 没有 content.json 也能跑，只是少一条覆盖提醒
  }
  return map;
}

// 打印结果并给出退出码；strict 下警告也算不通过。
export function printReport(result, { json = false, strict = false } = {}) {
  if (result.fatal) {
    console.error(result.fatal);
    return 2;
  }
  const { file, counts, total, rowsWithMathOrImage: mathRows, errors, warnings } = result;
  const summary = { file, counts, total, rowsWithMathOrImage: mathRows, errors: errors.length, warnings: warnings.length };
  if (json) {
    console.log(JSON.stringify({ ...summary, errors, warnings }, null, 2));
  } else {
    console.log(`\n题库文件  ${file}`);
    console.log(`  ${KINDS.map((k) => `${k.label} ${counts[k.key] || 0} 条`).join(' · ')}　合计 ${total} 条`);
    if (mathRows) console.log(`  含公式或图片的条目 ${mathRows} 条`);
    printList('错误', errors);
    printList('警告', warnings);
    if (!errors.length && !warnings.length) console.log('\n没有发现问题，可以直接在后台「导入 JSON」。');
    else if (!errors.length) console.log('\n没有错误，可以导入；上面的警告不会挡住导入，但建议看一眼。');
    else console.log(`\n有 ${errors.length} 处错误，这些条目导入时会被接口拒绝。改完再跑一次。`);
    console.log('');
  }
  return errors.length || (strict && warnings.length) ? 1 : 0;
}

function printList(title, items) {
  if (!items.length) return;
  console.log(`\n${title} ${items.length} 处`);
  // 同一 group 的警告最多列 6 条，其余折叠成一行；--json 里始终是完整的。
  const shown = new Map();
  let hidden = 0;
  items.forEach((it) => {
    const key = it.group || `${it.where}|${it.field}`;
    const n = shown.get(key) || 0;
    if (it.group && n >= 6) { hidden += 1; return; }
    shown.set(key, n + 1);
    console.log(`  [${it.where}]${it.field ? ` ${it.field}` : ''} · ${it.text}`);
  });
  if (hidden) console.log(`  …另有 ${hidden} 处同类警告，用 --json 可以看到全部`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const args = argv.filter((a) => !a.startsWith('--'));
  if (!args.length) {
    console.log(`用法: node deploy/tools/check-bank.mjs <题库.json> [--strict] [--json] [--no-builtin]
模板: deploy/tools/bank-template.json（可以直接拿它当起点改）`);
    process.exitCode = 2;
  } else {
    process.exitCode = printReport(await checkBankFile(args[0], { noBuiltin: flags.has('--no-builtin') }), {
      json: flags.has('--json'),
      strict: flags.has('--strict'),
    });
  }
}

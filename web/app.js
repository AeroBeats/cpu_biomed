/* ============================================================
   药大生医 · 初试复习台 — 应用主逻辑
   单页应用，hash 路由。浏览和做题都不需要登录；
   进度以 localStorage 为主，登录后再往服务器备一份快照。
   ============================================================ */

(function () {
  'use strict';

  var NS = 'cpuBioMed.';
  var SUBJ_ORDER = ['bio', 'ana', 'pol', 'eng'];
  var SUBJ = window.SUBJECTS;
  var TYPE_LABEL = window.TYPE_LABEL;

  /* ---------------- 存储 ---------------- */
  var Store = {
    get: function (k, def) {
      try {
        var v = localStorage.getItem(NS + k);
        return v === null ? def : JSON.parse(v);
      } catch (e) { return def; }
    },
    set: function (k, v) {
      Store.setQuiet(k, v);
      scheduleSync();
    },
    // 同步簿记（savedAt）与「刚把远端进度写回本地」这两种写入不能再排一次上传，
    // 否则会自己触发自己，形成回环。
    setQuiet: function (k, v) {
      try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) { /* 存储不可用时静默降级 */ }
    }
  };

  /* ---------------- 应用状态 ---------------- */
  var state = {
    examDate: Store.get('examDate', null),
    mistakes: Store.get('mistakes', {}),   // { qid: { n, last } }
    stats: Store.get('stats', {}),         // { qid: { right, wrong, last } }
    cards: Store.get('cards', {}),         // { cid: { stage, due } }
    kp: Store.get('kp', {}),               // { "subj|chapterId|pi": true }
    plan: Store.get('plan', {}),           // { taskId: true }
    days: Store.get('days', []),           // ["2026-10-14", ...]
    session: Store.get('session', null),
    feynman: Store.get('feynman', {}),     // { key: { stage, due, last, notes, stuck } }
    // 界面态（不持久化）
    setup: { subject: 'bio', chapters: [], types: [], onlyWrong: false, count: 10 },
    sylSubject: 'bio',
    deck: null,                            // { subject, queue:[cid], idx, flipped }
    talk: null,                            // 费曼讲解会话
    talkSetup: { subject: 'bio', source: 'mix', scope: 'all', count: 8 },
    source: 'builtin',                     // 'builtin' 内置数据 | 'cloud' 云端题库
    cloud: { status: 'loading' },          // loading | ready | empty | error
    // 自建服务器：mode 'accounts'，有登录页、角色和进度同步。
    account: { mode: 'accounts', status: 'loading', user: null, form: 'login', busy: false, msg: null },
    // Qoder 站点：mode 'gateway'，身份由平台网关给，只有「站点所有者」这一个概念。
    owner: { status: 'loading' },          // loading | anon | unclaimed | owner | other | error
    admin: { tab: 'questions', subject: 'bio', q: '', editing: null, busy: false, msg: null,
             preview: false, imgBusy: false, importErrors: null },
    route: 'dashboard'
  };

  var CARD_INTERVALS = [0, 1, 2, 4, 7, 15, 30];

  /* ---------------- 工具 ---------------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- 富文本：公式 / 图片 / 加粗 ----------------
     内容里认四种标记：$$…$$ 独立公式、$…$ 行内公式、![说明](地址) 图片、**加粗**。
     其余字符一律转义，所以题库里写 <script> 只会显示成文字。
     公式在这一步不渲染，只留一个带 data-tex 的占位元素，等进了 DOM 再交给 KaTeX——
     这样 KaTeX 万一没加载成功，用户看到的是原始 TeX 而不是空白。 */
  var RICH_TOKEN = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|!\[[^\]\n]*\]\([^)\s]+\)|\*\*[^*\n]+?\*\*)/g;
  // 图片地址只放行 http(s) 和站内 /media/ 路径，挡掉 javascript: 之类的协议。
  var IMG_SRC_OK = /^(https?:\/\/[^/\s]|\/media\/)/i;

  function rich(s) {
    var src = String(s === null || s === undefined ? '' : s);
    var out = '';
    var last = 0;
    var m;
    RICH_TOKEN.lastIndex = 0;
    while ((m = RICH_TOKEN.exec(src)) !== null) {
      out += esc(src.slice(last, m.index)) + richToken(m[0]);
      last = m.index + m[0].length;
    }
    return out + esc(src.slice(last));
  }

  function richToken(t) {
    if (t.charAt(0) === '$') {
      var display = t.charAt(1) === '$';
      var tex = display ? t.slice(2, -2) : t.slice(1, -1);
      if (!tex.trim()) return esc(t);
      return '<span class="math' + (display ? ' math-block' : '') + '" data-tex="' + esc(tex) + '">' + esc(tex) + '</span>';
    }
    if (t.charAt(0) === '*') return '<strong>' + esc(t.slice(2, -2)) + '</strong>';
    var im = /^!\[([^\]\n]*)\]\(([^)\s]+)\)$/.exec(t);
    if (!IMG_SRC_OK.test(im[2])) return esc(t);   // 地址不合规就原样显示，不做成链接
    return '<img class="shot" src="' + esc(im[2]) + '" alt="' + esc(im[1] || '题目配图') + '" loading="lazy">';
  }

  function paintMath(scope) {
    if (!window.katex) return;
    var nodes = (scope || document).querySelectorAll('.math[data-tex]:not([data-math-done])');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      el.setAttribute('data-math-done', '1');
      try {
        window.katex.render(el.getAttribute('data-tex') || '', el, {
          displayMode: el.className.indexOf('math-block') !== -1,
          // TeX 写错也照样出东西（红字显示原文），不至于整题空掉。
          throwOnError: false,
          errorColor: '#C0392B',
          strict: 'ignore',
          trust: false          // 不许 \href 这类能塞外链的命令
        });
      } catch (e) { /* 渲染炸了就留着占位里的 TeX 原文当兜底 */ }
    }
  }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function datePlus(days) {
    var d = new Date();
    d.setDate(d.getDate() + days);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  // 云端字段按 UTF-8 字节限长，截断要按字节算，不能按字符数。
  function clipBytes(s, max) {
    var str = String(s === null || s === undefined ? '' : s);
    var enc = new TextEncoder();
    if (enc.encode(str).length <= max) return str;
    var budget = Math.max(0, max - 3);
    var out = '';
    for (var i = 0; i < str.length; i++) {
      var next = out + str.charAt(i);
      if (enc.encode(next).length > budget) break;
      out = next;
    }
    return out + '…';
  }
  function daysTo(dateStr) {
    var t = new Date(dateStr + 'T00:00:00');
    var n = new Date(); n.setHours(0, 0, 0, 0);
    return Math.round((t - n) / 86400000);
  }
  function defaultExamDate() {
    // 默认取当年 12 月第三个周六之后的周日档期（考研初试惯例），用户可在总览修改
    var y = new Date().getFullYear();
    var d = new Date(y, 11, 19);
    if (d < new Date()) { d = new Date(y + 1, 11, 19); }
    return d.getFullYear() + '-12-19';
  }
  function examDate() {
    if (!state.examDate) { state.examDate = defaultExamDate(); Store.set('examDate', state.examDate); }
    return state.examDate;
  }
  function subjKey(s) { return SUBJ[s] ? s : 'bio'; }
  function kpKey(s, ch, pi) { return s + '|' + ch.id + '|' + pi; }

  /* ---------------- 内容数据装载 ----------------
     内置数据始终作为兜底；云端可用时整表替换。
     任何替换后都要重建索引并重跑一次归一化。 */
  var QINDEX = {};

  function rebuildIndex() {
    QINDEX = {};
    SUBJ_ORDER.forEach(function (s) {
      (window.QB[s] || []).forEach(function (q) { q.subject = s; QINDEX[q.id] = q; });
    });
  }

  // 归一化：补齐 subject / id / built_in，让内置与云端数据在界面上无法区分来源地一致渲染。
  function normalizeContent() {
    SUBJ_ORDER.forEach(function (s) {
      (window.QB[s] || []).forEach(function (q) {
        q.subject = s;
        if (q.built_in === undefined) q.built_in = true;
        if (!q.tags) q.tags = [];
      });
      (window.CARDS[s] || []).forEach(function (c) {
        if (c.built_in === undefined) c.built_in = true;
      });
      var syl = window.SYLLABUS[s];
      if (syl && syl.chapters) {
        syl.chapters.forEach(function (c, i) {
          if (!c.id) c.id = window.Cloud.chapterId(s, i);
          if (c.built_in === undefined) c.built_in = true;
          if (!c.points) c.points = [];
        });
      }
    });
    rebuildIndex();
  }

  // 考点勾选从「章节序号」改为「章节 id」，这样后台调整章节顺序不会错位已有进度。
  function migrateKp() {
    if (Store.get('kpV2', false)) return;
    var out = {};
    Object.keys(state.kp).forEach(function (k) {
      var p = k.split('|');
      if (p.length !== 3 || !/^\d+$/.test(p[1])) { out[k] = true; return; }
      var syl = window.SYLLABUS[p[0]];
      var ch = syl && syl.chapters ? syl.chapters[Number(p[1])] : null;
      if (ch && ch.id) out[p[0] + '|' + ch.id + '|' + p[2]] = true;
    });
    state.kp = out;
    Store.set('kp', out);
    Store.set('kpV2', true);
  }

  function contentCounts() {
    var n = { questions: 0, chapters: 0, cards: 0 };
    SUBJ_ORDER.forEach(function (s) {
      n.questions += (window.QB[s] || []).length;
      n.cards += (window.CARDS[s] || []).length;
      var syl = window.SYLLABUS[s];
      n.chapters += syl && syl.chapters ? syl.chapters.length : 0;
    });
    return n;
  }

  // 内容被删除后，对应的本地进度记录已无意义，一并清掉；
  // 但云端读取被截断时不裁剪，避免把「没读到」误当成「已删除」。
  function pruneProgress() {
    var changed = false;
    Object.keys(state.mistakes).forEach(function (id) {
      if (!QINDEX[id]) { delete state.mistakes[id]; changed = true; }
    });
    Object.keys(state.stats).forEach(function (id) {
      if (!QINDEX[id]) { delete state.stats[id]; changed = true; }
    });
    var knownCards = {};
    SUBJ_ORDER.forEach(function (s) {
      (window.CARDS[s] || []).forEach(function (c) { knownCards[c.id] = true; });
    });
    Object.keys(state.cards).forEach(function (id) {
      if (!knownCards[id]) { delete state.cards[id]; changed = true; }
    });
    Object.keys(state.feynman).forEach(function (key) {
      if (!feynmanTarget(key)) { delete state.feynman[key]; changed = true; }
    });
    if (!changed) return;
    Store.set('mistakes', state.mistakes);
    Store.set('stats', state.stats);
    Store.set('cards', state.cards);
    Store.set('feynman', state.feynman);
  }

  function applyCloudData(bank) {
    var app = window.Cloud.toAppData(bank);
    window.QB = app.QB;
    window.CARDS = app.CARDS;
    window.SYLLABUS = app.SYLLABUS;
  }

  function loadCloud() {
    state.cloud = { status: 'loading' };
    return window.Cloud.loadBank().then(function (bank) {
      var total = (bank.questions || []).length;
      if (total > 0) {
        applyCloudData(bank);
        state.source = 'cloud';
        state.cloud = { status: 'ready', truncated: !!bank.truncated };
      } else {
        state.source = 'builtin';
        state.cloud = { status: 'empty' };
      }
    }).catch(function (e) {
      state.source = 'builtin';
      state.cloud = { status: 'error', message: e && e.message ? e.message : '云端题库不可用' };
    }).then(function () {
      normalizeContent();
      migrateKp();
      // 只有确认拿到了完整内容清单才裁剪进度：读取失败或被截断时，
      // 「没读到」不等于「已删除」，这时候裁剪会误删还在的进度。
      var complete = state.cloud.status === 'empty'
        || (state.cloud.status === 'ready' && !state.cloud.truncated);
      if (complete) pruneProgress();
    });
  }

  function loadOwner() {
    state.owner = { status: 'loading' };
    return window.Cloud.ownerState().then(function (o) {
      state.owner = !o.loggedIn ? { status: 'anon' }
        : o.isOwner ? { status: 'owner' }
          : o.hasOwner ? { status: 'other' } : { status: 'unclaimed' };
    }).catch(function (e) {
      state.owner = { status: 'error', message: e && e.message ? e.message : '无法读取管理权限' };
    });
  }

  function isLoggedIn() { return !!(state.account.user); }
  function isAdmin() {
    if (state.account.status !== 'ready') return false;
    return state.account.mode === 'accounts'
      && !!(state.account.user && state.account.user.role === 'admin');
  }
  // gateway（Qoder 站点）没有角色概念，「启用后台管理」这一步就发生在内容管理页里，
  // 入口必须一直可见，否则所有者自己也启不起来。
  function canSeeAdmin() {
    return state.account.mode === 'gateway' ? true : isAdmin();
  }
  // 能不能往内容表里写：gateway 看是不是站点所有者，accounts 看角色。
  function canWriteContent() {
    if (state.account.status !== 'ready') return false;
    return state.account.mode === 'gateway' ? state.owner.status === 'owner' : isAdmin();
  }

  // 先探后端形态，再按形态取身份；两种后端共用 isAdmin() 这一个判断。
  function loadIdentity() {
    state.account.status = 'loading';
    return window.Cloud.detectMode().then(function (d) {
      state.account.mode = d.mode;
      if (d.mode === 'gateway') return loadOwner();
      state.account.user = d.user || null;
      // 探测失败时页面照样能用内置内容，只在账号页把原因说出来。
      state.account.msg = d.error ? { kind: 'err', text: d.error.message } : null;
      return undefined;
    }).catch(function () {
      state.account.mode = 'accounts';
      state.account.user = null;
    }).then(function () {
      state.account.status = 'ready';
      render();
      return isLoggedIn() && state.account.mode === 'accounts' ? pullProgress() : undefined;
    });
  }

  /* ---------------- 进度云端同步 ----------------
     localStorage 始终是主存储，服务器只是一份「换设备时用来找回进度」的快照。
     所有持久化写入都经过 Store.set，所以防抖挂在它上面，不必逐个改动画点。
     冲突策略是最简单的整份覆盖：谁的 savedAt 新，谁说了算。 */
  var PROGRESS_KEYS = ['examDate', 'mistakes', 'stats', 'cards', 'kp', 'plan', 'days', 'session', 'feynman'];
  var PROGRESS_DEFAULTS = {
    examDate: null, mistakes: {}, stats: {}, cards: {}, kp: {},
    plan: {}, days: [], session: null, feynman: {}
  };
  var sync = { status: 'idle', at: null, message: null, dirty: false, flying: false };

  function progressSnapshot() {
    var out = { v: 1, savedAt: Date.now() };
    PROGRESS_KEYS.forEach(function (k) { out[k] = state[k]; });
    return out;
  }

  function applyProgress(data) {
    if (!data || typeof data !== 'object') return;
    PROGRESS_KEYS.forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(data, k)) return;
      var v = data[k];
      if (v === undefined) v = null;
      state[k] = (v === null && PROGRESS_DEFAULTS[k] !== null)
        ? JSON.parse(JSON.stringify(PROGRESS_DEFAULTS[k])) : v;
      Store.setQuiet(k, state[k]);
    });
    // 恢复出来的可能是一组已做完的题，跟启动时一样让它直接显示成绩页。
    showingResult = !!(state.session && state.session.finished);
  }

  function paintSync() {
    ['accSync', 'footSync'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.textContent = syncText();
    });
  }

  function syncText() {
    if (!isLoggedIn() || state.account.mode !== 'accounts') return '进度只存在这台设备上';
    if (sync.status === 'saving') return '正在同步进度…';
    if (sync.status === 'error') return '进度同步失败：' + (sync.message || '');
    if (sync.at) return '进度已同步到服务器 · ' + sync.at.replace('T', ' ').slice(0, 16);
    return '进度已在这台设备保存，稍后同步到服务器';
  }

  function scheduleSync(delay) {
    if (!isLoggedIn() || state.account.mode !== 'accounts') return;
    sync.dirty = true;
    clearTimeout(sync.timer);
    sync.timer = setTimeout(flushSync, delay === undefined ? 3000 : delay);
  }

  function flushSync() {
    if (!isLoggedIn() || state.account.mode !== 'accounts') return;
    if (sync.flying) return;               // 落地后若又有改动会再排一次
    sync.flying = true;
    sync.dirty = false;
    sync.status = 'saving';
    paintSync();
    var payload = progressSnapshot();
    window.Cloud.saveProgress(payload).then(function (res) {
      sync.flying = false;
      sync.at = (res && res.updated_at) || new Date(payload.savedAt).toISOString();
      sync.status = 'saved';
      sync.message = null;
      Store.setQuiet('savedAt', payload.savedAt);
      paintSync();
      if (sync.dirty) scheduleSync(0);      // 上传期间又改过，补一次
    }, function (e) {
      sync.flying = false;
      sync.status = 'error';
      sync.message = e && e.message ? e.message : '无法连接服务器';
      paintSync();
      scheduleSync(30000);                 // 服务器不可用时退避，别一直敲
    });
  }

  // 登录后先取回服务器上的快照：远端更新就覆盖本地，本地更新就推上去。
  function pullProgress() {
    return window.Cloud.loadProgress().then(function (res) {
      var remote = res && res.data ? res.data : null;
      var localAt = Number(Store.get('savedAt', 0)) || 0;
      if (!remote) { scheduleSync(0); return; }
      var remoteAt = Number(remote.savedAt) || 0;
      if (remoteAt > localAt) {
        applyProgress(remote);
        Store.setQuiet('savedAt', remoteAt);
        sync.at = res.updated_at || null;
        sync.status = 'saved';
        render();
      } else {
        scheduleSync(0);
      }
    }, function () {
      // 取不回来就当纯本地用，不值得为这个打扰用户。
    });
  }

  function flushSyncNow() {
    if (!isLoggedIn() || state.account.mode !== 'accounts' || (!sync.dirty && !sync.flying)) return;
    window.Cloud.saveProgressNow(progressSnapshot());
  }

  function allQuestions() {
    var out = [];
    SUBJ_ORDER.forEach(function (s) {
      (window.QB[s] || []).forEach(function (q) { q.subject = s; out.push(q); });
    });
    return out;
  }
  // 自建题目的编号不一定以科目开头，必须查索引而不是解析 id。
  function findQuestion(id) { return QINDEX[id] || null; }
  function subjectOfQ(id) { var q = QINDEX[id]; return q ? q.subject : null; }
  // 题目被后台删除后，本地进度里的残留记录不再计入统计。
  function forgetQuestion(id) {
    delete state.mistakes[id];
    delete state.stats[id];
    Store.set('mistakes', state.mistakes);
    Store.set('stats', state.stats);
  }
  function chaptersOf(s) {
    var seen = [], list = window.QB[s] || [];
    list.forEach(function (q) { if (seen.indexOf(q.chapter) === -1) seen.push(q.chapter); });
    return seen;
  }
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function norm(s) {
    return String(s).trim().toLowerCase()
      .replace(/[\s，,。．、；;：:（）()【】\[\]""''"']/g, '')
      .replace(/[０-９]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 48);
      });
  }

  // 一个空可以有多个可接受答案，用 " / " 或 "|" 分隔。
  // 不带空格的斜杠（分数 1/2、比值 3:1）保持原样，不当分隔符。
  function blankAccepted(answer) {
    return String(answer).split(/\s*[|｜]\s*|\s+[\/／]\s+/)
      .map(norm).filter(function (x) { return x; });
  }
  function answerText(q) {
    if (q.type === 'single' || q.type === 'judge') return String.fromCharCode(65 + q.answer) + '. ' + q.options[q.answer];
    if (q.type === 'multi') return q.answer.slice().sort(function (a, b) { return a - b; })
      .map(function (i) { return String.fromCharCode(65 + i); }).join('、');
    if (q.type === 'blank') return q.answer;
    return '';
  }
  function letter(i) { return String.fromCharCode(65 + i); }

  function markActivity() {
    var t = today();
    if (state.days.indexOf(t) === -1) {
      state.days.push(t);
      if (state.days.length > 400) state.days = state.days.slice(-400);
      Store.set('days', state.days);
    }
  }
  function streak() {
    var set = {};
    state.days.forEach(function (d) { set[d] = 1; });
    var n = 0;
    var d = new Date(); d.setHours(0, 0, 0, 0);
    // 今天没打卡则从昨天开始数
    var key = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    if (!set[key]) d.setDate(d.getDate() - 1);
    for (var i = 0; i < 400; i++) {
      var k = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      if (!set[k]) break;
      n++; d.setDate(d.getDate() - 1);
    }
    return n;
  }

  /* ---------------- 图标 ---------------- */
  var ICO = {
    dashboard: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
    practice: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l2.5 2.5L16 9"/><path d="M20 12a8 8 0 1 1-2.34-5.66"/></svg>',
    mistakes: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H19v16H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M8 4v16"/><path d="M12 9.5l4 4M16 9.5l-4 4"/></svg>',
    cards: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="14" height="13" rx="2"/><path d="M7 3h12a2 2 0 0 1 2 2v11"/></svg>',
    syllabus: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 0-2 2z"/><path d="M9 7h6M9 11h6"/></svg>',
    plan: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/><path d="M9 15.5l1.8 1.8L15 13"/></svg>',
    check: '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.3l2.7 2.7L10 3.5"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4.5 13.5H11L10 22l8.5-11.5H12z"/></svg>',
    target: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.4"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5.4l3.4 2"/></svg>',
    book: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19v14H5.5A1.5 1.5 0 0 0 4 18.5z"/><path d="M4 18.5A1.5 1.5 0 0 1 5.5 17H19v4H5.5A1.5 1.5 0 0 1 4 19.5z"/></svg>',
    flask: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v6.5L5 18a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-4-8.5V3"/><path d="M8 3h8M7 15h10"/></svg>',
    feynman: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v8a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4H5.5A1.5 1.5 0 0 1 4 13.5z"/><path d="M12 7.2a2.3 2.3 0 0 0-1.3 4.2v.9h2.6v-.9A2.3 2.3 0 0 0 12 7.2z"/></svg>',
    admin: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.1"/><circle cx="7" cy="17" r="2.1"/></svg>',
    account: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.5" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/></svg>'
  };

  /* ---------------- 数据聚合 ---------------- */
  function subjStats(s) {
    var qs = window.QB[s] || [];
    var done = 0, right = 0, total = 0;
    qs.forEach(function (q) {
      var st = state.stats[q.id];
      if (st) { done++; right += st.right; total += st.right + st.wrong; }
    });
    var acc = total ? Math.round(right / total * 100) : null;
    var mistakes = Object.keys(state.mistakes).filter(function (id) { return subjectOfQ(id) === s; }).length;
    var cards = window.CARDS[s] || [];
    var due = dueCards(s).length;
    var kpPct = syllabusPct(s);
    return { total: qs.length, done: done, acc: acc, mistakes: mistakes, cards: cards.length, due: due, kpPct: kpPct, right: right, answered: total };
  }

  function dueCards(s) {
    var list = window.CARDS[s] || [];
    var t = today();
    return list.filter(function (c) {
      var st = state.cards[c.id];
      return !st || !st.due || st.due <= t;
    });
  }

  function syllabusPct(s) {
    var syl = window.SYLLABUS[s];
    if (!syl) return null;
    var total = 0, done = 0;
    syl.chapters.forEach(function (ch) {
      ch.points.forEach(function (_, pi) {
        total++;
        if (state.kp[kpKey(s, ch, pi)]) done++;
      });
    });
    return total ? { done: done, total: total, pct: Math.round(done / total * 100) } : null;
  }

  function planPct() {
    var total = 0, done = 0;
    window.PLAN_STAGES.forEach(function (st) {
      st.tasks.forEach(function (t) { total++; if (state.plan[t.id]) done++; });
    });
    return { done: done, total: total, pct: total ? Math.round(done / total * 100) : 0 };
  }

  /* ---------------- 渲染：导航与顶栏 ---------------- */
  var ROUTES = [
    { id: 'dashboard', name: '总览', ico: 'dashboard' },
    { id: 'practice', name: '刷题训练', ico: 'practice' },
    { id: 'mistakes', name: '错题本', ico: 'mistakes' },
    { id: 'cards', name: '背诵卡', ico: 'cards' },
    { id: 'feynman', name: '费曼讲解', ico: 'feynman' },
    { id: 'syllabus', name: '考纲考点', ico: 'syllabus' },
    { id: 'plan', name: '复习计划', ico: 'plan' },
    { id: 'admin', name: '内容管理', ico: 'admin', adminOnly: true },
    // 账号页不进导航，由侧栏底部的账号卡片和「需要登录」的提示进入。
    { id: 'account', name: '账号', ico: 'account', hidden: true }
  ];

  function visibleRoutes() {
    return ROUTES.filter(function (r) {
      if (r.hidden) return false;
      return !r.adminOnly || canSeeAdmin();
    });
  }

  function renderNav() {
    var badge = {};
    var mk = Object.keys(state.mistakes).length;
    if (mk) badge.mistakes = mk;
    var due = 0;
    SUBJ_ORDER.forEach(function (s) { due += dueCards(s).length; });
    if (due) badge.cards = due;

    var routes = visibleRoutes();
    var html = routes.map(function (r) {
      var cur = state.route === r.id;
      return '<li><a href="#/' + r.id + '"' + (cur ? ' aria-current="page"' : '') + '>' +
        ICO[r.ico] + '<span>' + r.name + '</span>' +
        (badge[r.id] ? '<span class="nav-badge">' + badge[r.id] + '</span>' : '') +
        '</a></li>';
    }).join('');
    document.getElementById('navList').innerHTML = html;
    var t = ROUTES.filter(function (r) { return r.id === state.route; })[0];
    document.getElementById('topbarTitle').textContent = t ? t.name : '';
    document.getElementById('streakNum').textContent = streak();
    renderAccountWidget();
  }

  // 侧栏底部这一块是登录入口的主位：没登录时只说清「进度只在本机」，
  // 不做拦路的弹窗；登录后换成账号、角色和同步状态。
  function renderAccountWidget() {
    var box = document.getElementById('footAccount');
    if (!box) return;
    if (state.account.status !== 'ready') {
      box.innerHTML = '<p class="foot-note">学习进度保存在本机浏览器。</p>';
      return;
    }
    // Qoder 站点没有本站账号，身份由平台网关给，这里不摆登录入口。
    if (state.account.mode === 'gateway') {
      box.innerHTML = '<p class="foot-note">学习进度保存在本机浏览器；管理身份随你登录的 Qoder 账号。</p>';
      return;
    }
    if (!isLoggedIn()) {
      box.innerHTML = '<p class="foot-note" id="footSync">进度只存在这台设备上</p>' +
        // 侧栏在 #view 外面，收不到委托的点击事件，所以这里用普通链接而不是 data-act 按钮。
        '<a class="btn btn-sm btn-block" href="#/account">登录 / 注册</a>' +
        '<p class="foot-note">登录后可跨设备同步进度。</p>';
      return;
    }
    var u = state.account.user;
    var role = isAdmin() ? '管理员' : '学习者';
    box.innerHTML = '<a class="acc-chip" href="#/account">' +
      '<span class="acc-avatar" aria-hidden="true">' + esc(String(u.name || u.username || '?').slice(0, 1)) + '</span>' +
      '<span class="acc-meta"><b>' + esc(u.name || u.username) + '</b>' +
      '<span class="acc-role">' + role + '</span></span>' +
      '<span class="acc-go" aria-hidden="true">›</span></a>' +
      '<p class="foot-note" id="footSync">' + esc(syncText()) + '</p>';
  }

  function renderCountdown() {
    var n = daysTo(examDate());
    var box = document.getElementById('countdown');
    var num = document.getElementById('cdNum');
    box.classList.toggle('is-urgent', n >= 0 && n <= 30);
    if (n > 0) { num.textContent = n; box.title = '初试日期 ' + examDate() + '，点击修改'; }
    else if (n === 0) { num.textContent = '今天'; box.title = '今天就是初试日'; }
    else { num.textContent = '已过'; box.title = '考试日期 ' + examDate() + ' 已过，点击修改'; }
  }

  /* ---------------- 视图：总览 ---------------- */
  function viewDashboard() {
    var left = daysTo(examDate());
    var stats = {};
    SUBJ_ORDER.forEach(function (s) { stats[s] = subjStats(s); });

    var totalQ = 0, doneQ = 0, rightAll = 0, ansAll = 0;
    SUBJ_ORDER.forEach(function (s) {
      totalQ += stats[s].total; doneQ += stats[s].done;
      rightAll += stats[s].right; ansAll += stats[s].answered;
    });
    var acc = ansAll ? Math.round(rightAll / ansAll * 100) : null;
    var mistakeN = Object.keys(state.mistakes).length;
    var dueN = 0; SUBJ_ORDER.forEach(function (s) { dueN += stats[s].due; });
    var pp = planPct();

    var hero = '' +
      '<section class="hero"><div class="hero-inner">' +
      '<div class="hero-kicker">China Pharmaceutical University · 0860 生物与医药</div>' +
      '<h1>' + (left > 0 ? '距初试还有 ' + left + ' 天' : (left === 0 ? '今天就是初试日' : '初试日期已过')) + '</h1>' +
      '<p class="hero-sub">338 生物化学 · 811 分析化学 · 101 思想政治理论 · 201 英语一。' +
      '专业课合计 300 分，是拉开差距的关键；公共课求稳。今天先把最薄弱的那一科推进一格。</p>' +
      '<div class="hero-stats">' +
      '<div class="hero-stat"><div class="hs-num">' + (acc === null ? '—' : acc + '<span style="font-size:13px">%</span>') + '</div><div class="hs-label">总正确率 · 已答 ' + ansAll + ' 题次</div></div>' +
      '<div class="hero-stat"><div class="hs-num' + (mistakeN > 0 ? ' is-danger' : '') + '">' + mistakeN + '</div><div class="hs-label">待消灭错题</div></div>' +
      '<div class="hero-stat"><div class="hs-num">' + dueN + '</div><div class="hs-label">今日待复习卡片</div></div>' +
      '<div class="hero-stat"><div class="hs-num">' + pp.pct + '<span style="font-size:13px">%</span></div><div class="hs-label">复习计划完成 ' + pp.done + '/' + pp.total + '</div></div>' +
      '</div></div></section>';

    var cards = SUBJ_ORDER.map(function (s) {
      var st = stats[s], m = SUBJ[s];
      return '<article class="subj-card" data-s="' + s + '">' +
        '<div class="subj-card-top">' +
        '<div><div class="row" style="gap:8px;margin-bottom:6px"><span class="subj-code">' + m.code + '</span></div>' +
        '<div class="subj-name">' + m.name + '</div>' +
        '<div class="subj-meta">' + m.full + ' · ' + m.time + '</div></div>' +
        '<div class="subj-score">' + m.score + '<small>满分</small></div>' +
        '</div>' +
        '<div class="subj-stats">' +
        '<div class="ss"><span class="ss-n">' + (st.acc === null ? '—' : st.acc + '%') + '</span><span class="ss-l">正确率</span></div>' +
        '<div class="ss"><span class="ss-n">' + st.done + '/' + st.total + '</span><span class="ss-l">题目覆盖</span></div>' +
        '<div class="ss"><span class="ss-n">' + st.mistakes + '</span><span class="ss-l">错题</span></div>' +
        '<div class="ss"><span class="ss-n">' + st.due + '</span><span class="ss-l">待复习卡</span></div>' +
        '<div class="ss"><span class="ss-n">' + (st.kpPct ? st.kpPct.pct + '%' : '—') + '</span><span class="ss-l">考点掌握</span></div>' +
        '</div>' +
        '<div class="row" style="gap:8px">' +
        '<button class="btn btn-sm" data-act="quick-practice" data-s="' + s + '">随机刷 10 题</button>' +
        '<button class="btn btn-sm btn-ghost" data-act="quick-cards" data-s="' + s + '">背卡片</button>' +
        '<button class="btn btn-sm btn-ghost" data-act="quick-syllabus" data-s="' + s + '">看考纲</button>' +
        '</div></article>';
    }).join('');

    var tips = buildTodayTips(stats, mistakeN, dueN, left);

    return '<div class="stack">' +
      hero +
      '<div class="grid grid-2" style="align-items:start">' +
      '<section><div class="card-head"><h2>四科进度</h2><span class="hint">点击卡片直接开始</span></div>' +
      '<div class="subj-grid">' + cards + '</div></section>' +
      '<section class="stack">' +
      '<div class="card"><div class="card-head"><h2>今日建议</h2></div><div class="today">' + tips + '</div></div>' +
      '<div class="card"><div class="card-head"><h2>初试安排</h2></div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
      SUBJ_ORDER.map(function (s) {
        var m = SUBJ[s];
        return '<tr style="border-bottom:1px solid var(--line)">' +
          '<td style="padding:9px 0;width:52px"><span class="subj-pill subj-' + s + '">' + m.code + '</span></td>' +
          '<td style="padding:9px 6px;font-weight:560">' + m.name + '</td>' +
          '<td style="padding:9px 0;text-align:right;font-family:var(--mono);color:var(--ink-2)">' + m.score + ' 分</td>' +
          '</tr>';
      }).join('') +
      '<tr><td colspan="3" style="padding:9px 0;font-family:var(--mono);color:var(--ink-2);text-align:right">合计 500 分</td></tr>' +
      '</table>' +
      '<button class="btn btn-sm btn-ghost" data-act="edit-exam" style="margin-top:10px">修改考试日期</button>' +
      '</div></section>' +
      '</div></div>';
  }

  function buildTodayTips(stats, mistakeN, dueN, left) {
    var tips = [];
    var order = SUBJ_ORDER.slice().sort(function (a, b) {
      var x = stats[a], y = stats[b];
      var sx = x.kpPct ? x.kpPct.pct : 0, sy = y.kpPct ? y.kpPct.pct : 0;
      return sx - sy;
    });
    var weak = order[0];
    tips.push({
      s: weak, ico: 'target',
      title: '优先推进 ' + SUBJ[weak].full,
      desc: stats[weak].kpPct
        ? '考点掌握度 ' + stats[weak].kpPct.pct + '%（' + stats[weak].kpPct.done + '/' + stats[weak].kpPct.total + '），是四科中最低的一项。'
        : '先通读考纲考点树，建立框架。'
    });

    if (dueN > 0) {
      tips.push({ s: 'mix', ico: 'cards', title: '有 ' + dueN + ' 张背诵卡到期', desc: '间隔复习的关键是「到期就复习」。拖延会让记忆曲线重新归零，建议今天先清掉。' });
    }
    if (mistakeN > 0) {
      tips.push({ s: 'mix', ico: 'mistakes', title: mistakeN + ' 道错题待消灭', desc: '错题重做到连对两次再移除。反复错的题就是考场上最可能丢分的地方。' });
    }
    if (left >= 0 && left <= 45) {
      tips.push({ s: 'mix', ico: 'clock', title: '进入冲刺窗口（剩 ' + left + ' 天）', desc: '把时间向 338 与 811 倾斜：这两科合计 300 分。政治靠分析题背诵提分最快，英语保持每天阅读手感。' });
    } else {
      tips.push({ s: 'mix', ico: 'book', title: '保持每天四科都碰一下', desc: '专业课（338 + 811）占每日复习时间 55% 以上，政治与英语各 1~1.5 小时即可，避免长时间中断任何一科。' });
    }
    return tips.map(function (t) {
      return '<div class="today-item" data-s="' + t.s + '">' +
        '<div class="ti-ico">' + (ICO[t.ico] || ICO.bolt) + '</div>' +
        '<div class="ti-body"><div class="ti-title">' + esc(t.title) + '</div><div class="ti-desc">' + esc(t.desc) + '</div></div></div>';
    }).join('');
  }

  /* ---------------- 视图：刷题 ---------------- */
  function viewPractice() {
    if (state.session) return renderQuiz();
    return renderSetup();
  }

  function renderSetup() {
    var s = state.setup.subject;
    var subjChips = SUBJ_ORDER.map(function (k) {
      var on = k === s;
      return '<button class="chip" data-act="setup-subject" data-s="' + k + '" aria-pressed="' + on + '">' +
        SUBJ[k].code + ' ' + SUBJ[k].name +
        '<span class="chip-n">' + (window.QB[k] || []).length + '</span></button>';
    }).join('');

    var chs = chaptersOf(s);
    var chapHtml = chs.map(function (c) {
      var on = state.setup.chapters.indexOf(c) > -1;
      var n = (window.QB[s] || []).filter(function (q) { return q.chapter === c; }).length;
      return '<button class="chapter-item" data-act="setup-chapter" data-c="' + esc(c) + '" aria-pressed="' + on + '">' +
        ICO.check.replace('<svg', '<svg style="visibility:' + (on ? 'visible' : 'hidden') + ';color:var(--brand)"') +
        '<span>' + esc(c) + '</span><span class="ci-n">' + n + '</span></button>';
    }).join('');

    var typeChips = Object.keys(TYPE_LABEL).map(function (t) {
      var n = (window.QB[s] || []).filter(function (q) { return q.type === t; }).length;
      if (!n) return '';
      var on = state.setup.types.indexOf(t) > -1;
      return '<button class="chip" data-act="setup-type" data-t="' + t + '" aria-pressed="' + on + '">' +
        TYPE_LABEL[t] + '<span class="chip-n">' + n + '</span></button>';
    }).join('');

    var pool = buildPool();

    return '<div class="page-head"><h1>刷题训练</h1>' +
      '<p class="sub">按科目、章节、题型筛选题目。答题后立即给出对错与详细解析，做错的题会自动进入错题本。</p></div>' +
      '<div class="setup-panel">' +
      '<div class="card">' +
      '<div class="field"><span class="field-label">选择科目</span><div class="chip-row">' + subjChips + '</div></div>' +
      '<div class="field"><span class="field-label">章节（不选则全部）</span><div class="chapter-list">' + chapHtml + '</div></div>' +
      '<div class="field"><span class="field-label">题型（不选则全部）</span><div class="chip-row">' + typeChips + '</div></div>' +
      '</div>' +
      '<div class="stack">' +
      '<div class="card">' +
      '<div class="card-head"><h2>本次训练</h2></div>' +
      '<div class="field"><label for="countSel">题目数量</label>' +
      '<select id="countSel" data-bind="count">' +
      [5, 10, 15, 20, 30].map(function (n) {
        return '<option value="' + n + '"' + (state.setup.count === n ? ' selected' : '') + '>' + n + ' 题</option>';
      }).join('') +
      (pool.length > 30 || pool.length === 0 ? '<option value="0"' + (state.setup.count === 0 ? ' selected' : '') + '>全部（' + pool.length + ' 题）</option>' : '') +
      '</select></div>' +
      '<div class="field"><button class="chip" data-act="setup-wrong" aria-pressed="' + state.setup.onlyWrong + '">' +
      '只做错题<span class="chip-n">' + (window.QB[s] || []).filter(function (q) { return state.mistakes[q.id]; }).length + '</span></button></div>' +
      '<p style="font-size:12.5px;color:var(--ink-3);margin-bottom:14px">当前题库共 <b style="font-family:var(--mono);color:var(--ink-2)">' + pool.length + '</b> 题符合筛选条件。</p>' +
      '<button class="btn btn-primary" data-act="start-quiz" style="width:100%"' + (pool.length ? '' : ' disabled') + '>开始训练</button>' +
      '</div>' +
      '<div class="card"><div class="card-head"><h2>题库说明</h2></div>' +
      '<p style="font-size:13px;color:var(--ink-2);line-height:1.8">本题库按考纲高频考点整理，覆盖单选、多选、判断、填空与主观题五种题型，每题附详细解析。<br><br>' +
      '主观题（简答/论述/写作）请先在文本框中写出自己的答案要点，再展开参考答案对照，最后自评「掌握」或「未掌握」——未掌握会进入错题本。<br><br>' +
      '<span class="note info" style="display:block">题库已收录 2022 / 2024 / 2025 年药大生医真题、配套习题册精选与考研政治历年真题；带「自拟答案」标签者为官方未公布答案、依据教材整理的参考解析。科目代码、分值与报考安排以中国药科大学 2027 年招生简章为准，章节级考点权重仍为复习框架。</span></p>' +
      '</div></div></div>';
  }

  function buildPool() {
    var s = state.setup.subject;
    var list = (window.QB[s] || []).slice();
    if (state.setup.chapters.length) {
      list = list.filter(function (q) { return state.setup.chapters.indexOf(q.chapter) > -1; });
    }
    if (state.setup.types.length) {
      list = list.filter(function (q) { return state.setup.types.indexOf(q.type) > -1; });
    }
    if (state.setup.onlyWrong) {
      list = list.filter(function (q) { return !!state.mistakes[q.id]; });
    }
    return list;
  }

  function startSession(ids, meta) {
    var q = ids.map(findQuestion).filter(Boolean);
    state.session = {
      ids: q.map(function (x) { return x.id; }),
      idx: 0,
      results: q.map(function () { return null; }),
      picks: q.map(function () { return null; }),
      startedAt: Date.now(),
      meta: meta || {}
    };
    Store.set('session', state.session);
  }

  function renderQuiz() {
    var ss = state.session;
    var q = findQuestion(ss.ids[ss.idx]);
    if (!q) { state.session = null; Store.set('session', null); return renderSetup(); }

    var s = q.subject;
    var res = ss.results[ss.idx];
    var pick = ss.picks[ss.idx];
    var pending = res === 'pending';
    var done = res !== null && !pending;

    var dots = ss.ids.map(function (id, i) {
      var cls = 'q-dot';
      if (i === ss.idx) cls += ' cur';
      var r = ss.results[i];
      if (r === true) cls += ' right';
      else if (r === false) cls += ' wrong';
      else if (r !== null) cls += ' done';
      return '<span class="' + cls + '" title="第 ' + (i + 1) + ' 题"></span>';
    }).join('');

    var body = '';
    body += '<div class="q-head">' +
      '<span class="subj-pill subj-' + s + '">' + SUBJ[s].code + ' ' + SUBJ[s].name + '</span>' +
      '<span class="q-type">' + TYPE_LABEL[q.type] + '</span>' +
      '<span class="tag">' + esc(q.chapter) + '</span>' +
      (q.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') +
      '<span class="q-dots">' + dots + '</span>' +
      '</div>';

    body += '<div class="q-body"><div class="q-stem">' + rich(q.stem) + '</div>';

    if (q.type === 'single' || q.type === 'multi' || q.type === 'judge') {
      body += '<div class="opts" role="group" aria-label="选项">';
      q.options.forEach(function (o, i) {
        var cls = 'opt';
        var mark = '';
        var isAns = q.type === 'multi' ? q.answer.indexOf(i) > -1 : q.answer === i;
        var picked = q.type === 'multi' ? (pick || []).indexOf(i) > -1 : pick === i;
        if (done) {
          if (isAns) { cls += ' is-right'; mark = '<span class="opt-mark">正确答案</span>'; }
          else if (picked) { cls += ' is-wrong'; mark = '<span class="opt-mark">你的选择</span>'; }
          else cls += ' is-dim';
        } else if (picked) cls += ' is-picked';
        body += '<button class="' + cls + '" data-act="pick" data-i="' + i + '"' + (done ? ' disabled' : '') + '>' +
          '<span class="opt-key">' + letter(i) + '</span><span>' + rich(o) + '</span>' + mark + '</button>';
      });
      body += '</div>';
    } else if (q.type === 'blank') {
      body += '<div class="answer-box"><input type="text" data-bind="blank" placeholder="输入答案后点击「提交」" ' +
        'value="' + esc(pick || '') + '"' + (done ? ' disabled' : '') + ' aria-label="填空答案" autocomplete="off"></div>';
    } else if (q.type === 'short') {
      body += '<div class="answer-box"><textarea data-bind="short" placeholder="先在纸上或这里写出你的答案要点，再展开参考答案对照自评…" ' +
        (done || pending ? 'disabled' : '') + ' aria-label="主观题作答">' + esc(pick || '') + '</textarea></div>';
    }

    if ((done || pending) && q.type === 'short') {
      body += '<div class="explain' + (pending ? '' : (res === true ? ' is-right' : ' is-wrong')) + '">' +
        '<div class="explain-verdict">' +
        (pending ? '对照下面的参考答案要点，给自己打个分' : (res === true ? '✓ 你自评为「已掌握」' : '✗ 你自评为「未掌握」，已加入错题本')) +
        '</div>' +
        '<div class="ref-answer"><div class="ra-label">参考答案要点</div>' +
        '<div class="explain-text">' + rich(q.answer) + '</div></div>' +
        (q.explain ? '<div class="ref-answer"><div class="ra-label">解题提示</div><div class="explain-text">' + rich(q.explain) + '</div></div>' : '') +
        (pending ? '<div class="rate-row is-2">' +
          '<button class="rate-btn" data-act="self-rate" data-r="unknown"><b>✗ 未掌握</b><span>记入错题本</span></button>' +
          '<button class="rate-btn" data-act="self-rate" data-r="know"><b>✓ 已掌握</b><span>继续下一题</span></button>' +
          '</div>' : '') +
        '</div>';
    } else if (done) {
      body += '<div class="explain' + (res === true ? ' is-right' : ' is-wrong') + '">' +
        '<div class="explain-verdict">' +
        (res === true ? '✓ 回答正确' : '✗ 回答错误') +
        '<span class="ans">正确答案 ' + rich(answerText(q)) + '</span>' +
        '</div>' +
        '<div class="explain-text">' + rich(q.explain) + '</div></div>';
    } else if (q.type !== 'short') {
      body += '<div class="explain" style="border-left-color:var(--line-2)"><div class="explain-text" style="color:var(--ink-3)">' +
        (q.type === 'multi' ? '多选题：选出所有正确选项后点击「提交」。多选、少选、错选均判错。' :
          q.type === 'blank' ? '填空题：填入答案后点击「提交」。按文本比对判分，忽略空格、大小写和标点；数值题请按有效数字规则作答。' : '选出你认为正确的选项。') +
        '</div></div>';
    }

    body += '</div>'; // q-body

    body += '<div class="q-foot">';
    if (pending) {
      body += '<span style="font-size:12.5px;color:var(--ink-3)">快捷键 <kbd>1</kbd> 未掌握 · <kbd>2</kbd> 已掌握</span>';
    } else if (!done) {
      if (q.type === 'short') {
        body += '<button class="btn btn-primary" data-act="short-check">查看参考答案并自评</button>';
      } else {
        var canSubmit = q.type === 'blank' ? String(pick || '').trim() : (pick !== null && (q.type !== 'multi' || pick.length));
        body += '<button class="btn btn-primary" data-act="submit"' + (canSubmit ? '' : ' disabled') + '>提交答案</button>';
      }
      body += '<span style="font-size:12.5px;color:var(--ink-3)">快捷键 <kbd>1</kbd>~<kbd>5</kbd> 选项 · <kbd>Enter</kbd> 提交/下一题</span>';
    } else {
      body += '<button class="btn" data-act="prev"' + (ss.idx === 0 ? ' disabled' : '') + '>上一题</button>';
      body += '<div class="spacer"></div>';
      if (ss.idx < ss.ids.length - 1) body += '<button class="btn btn-primary" data-act="next">下一题</button>';
      else body += '<button class="btn btn-primary" data-act="finish">查看训练结果</button>';
    }
    body += '<div class="spacer"></div><button class="btn btn-ghost btn-sm" data-act="quit">结束训练</button>';
    body += '</div>';

    return '<div class="quiz">' +
      '<div class="quiz-top">' +
      '<span class="quiz-progress">第 ' + (ss.idx + 1) + ' / ' + ss.ids.length + ' 题</span>' +
      '<span class="bar"><i style="width:' + Math.round((ss.idx + (done ? 1 : 0)) / ss.ids.length * 100) + '%"></i></span>' +
      '</div>' +
      '<div class="q-card">' + body + '</div></div>';
  }

  function viewResult() {
    var ss = state.session;
    var right = ss.results.filter(function (r) { return r === true; }).length;
    var wrong = ss.results.filter(function (r) { return r === false; }).length;
    var total = ss.ids.length;
    var pct = total ? Math.round(right / total * 100) : 0;
    var secs = Math.round((Date.now() - ss.startedAt) / 1000);
    var mm = Math.floor(secs / 60), ssc = secs % 60;
    var verdict = pct >= 90 ? '非常扎实，保持这个节奏。' :
      pct >= 75 ? '掌握得不错，把错题过一遍就能再上一档。' :
        pct >= 60 ? '基础在，但有明显漏洞，建议回考纲页对照考点逐条排查。' :
          '这一部分需要重学，先回考纲页把章节考点过一遍再刷题。';

    var C = 2 * Math.PI * 62;
    var color = pct >= 75 ? 'var(--ok)' : pct >= 60 ? 'var(--warn)' : 'var(--bad)';

    return '<div class="result card" style="padding:32px 24px">' +
      '<div class="result-ring"><svg width="156" height="156" viewBox="0 0 156 156">' +
      '<circle cx="78" cy="78" r="62" fill="none" stroke="var(--paper-2)" stroke-width="12"/>' +
      '<circle cx="78" cy="78" r="62" fill="none" stroke="' + color + '" stroke-width="12" stroke-linecap="round" ' +
      'stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + (C * (1 - pct / 100)).toFixed(1) + '"/></svg>' +
      '<div class="rr-num"><b style="color:' + color + '">' + pct + '%</b><span>正确率</span></div></div>' +
      '<h2>' + (pct >= 75 ? '训练完成，状态不错' : '训练完成') + '</h2>' +
      '<p class="verdict">' + esc(verdict) + '</p>' +
      '<div class="result-stats">' +
      '<div class="result-stat"><div class="rs-n" style="color:var(--ok)">' + right + '</div><div class="rs-l">答对</div></div>' +
      '<div class="result-stat"><div class="rs-n" style="color:var(--bad)">' + wrong + '</div><div class="rs-l">答错（已收入错题本）</div></div>' +
      '<div class="result-stat"><div class="rs-n">' + mm + '′' + pad(ssc) + '″</div><div class="rs-l">用时</div></div>' +
      '</div>' +
      '<div class="result-actions">' +
      '<button class="btn btn-primary" data-act="again">再来一组</button>' +
      (wrong ? '<button class="btn" data-act="review-wrong">重做本次错题（' + wrong + '）</button>' : '') +
      '<button class="btn btn-ghost" data-act="go-mistakes">打开错题本</button>' +
      '<button class="btn btn-ghost" data-act="go-home">返回总览</button>' +
      '</div>' + loginHint() + '</div>';
  }

  // 一组题刚做完，是「进度只在本机」最有体感的时刻；提示放这里，不在进站时拦人。
  function loginHint() {
    if (state.account.mode !== 'accounts' || isLoggedIn()) return '';
    return '<p class="sync-hint">' + ICO.account +
      '<span>这组成绩目前只存在这台设备的浏览器里。' +
      '<a href="#/account">登录或注册</a>之后会自动同步到服务器，换设备也能接着做。</span></p>';
  }

  /* ---------------- 视图：错题本 ---------------- */
  function viewMistakes() {
    var ids = Object.keys(state.mistakes).sort(function (a, b) {
      return (state.mistakes[b].n - state.mistakes[a].n) || (state.mistakes[b].last - state.mistakes[a].last);
    });

    var head = '<div class="page-head"><h1>错题本</h1>' +
      '<p class="sub">做错的题目会自动收录到这里，按出错次数排序。重做答对一次即自动移除；也可以手动标记为已掌握。</p></div>';

    if (!ids.length) {
      return head + '<div class="card"><div class="empty">' +
        '<svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l2.5 2.5L16 9"/><path d="M20 12a8 8 0 1 1-2.34-5.66"/></svg>' +
        '<p class="empty-title">错题本是空的</p><p>还没有做错的题目。去刷题训练做一组题，错题会自动出现在这里。</p>' +
        '<button class="btn btn-primary" data-act="nav" data-to="practice" style="margin-top:16px">去刷题</button></div></div>';
    }

    var bySubject = {};
    SUBJ_ORDER.forEach(function (s) { bySubject[s] = []; });
    ids.forEach(function (id) {
      var s = subjectOfQ(id);
      if (s && bySubject[s]) bySubject[s].push(id);
    });

    var chips = SUBJ_ORDER.filter(function (s) { return bySubject[s].length; }).map(function (s) {
      return '<button class="chip" data-act="mistake-drill" data-s="' + s + '">' +
        SUBJ[s].code + ' ' + SUBJ[s].name + '<span class="chip-n">' + bySubject[s].length + '</span></button>';
    }).join('');

    var items = ids.map(function (id) {
      var q = findQuestion(id);
      if (!q) return '';
      var m = state.mistakes[id];
      var s = q.subject;
      return '<article class="q-item">' +
        '<div class="q-item-top">' +
        '<span class="subj-pill subj-' + s + '">' + SUBJ[s].code + ' ' + SUBJ[s].name + '</span>' +
        '<span class="q-type">' + TYPE_LABEL[q.type] + '</span>' +
        '<span class="tag">' + esc(q.chapter) + '</span>' +
        '<span class="miss-badge">错 ' + m.n + ' 次</span>' +
        '<div class="q-item-actions">' +
        '<button class="btn btn-sm" data-act="drill-one" data-q="' + id + '">重做</button>' +
        '<button class="btn btn-sm btn-ghost btn-danger" data-act="mistake-remove" data-q="' + id + '">已掌握</button>' +
        '</div></div>' +
        '<div class="q-item-stem">' + rich(q.stem) + '</div>' +
        '<details class="reveal"><summary>查看正确答案与解析</summary><div class="rev-body">' +
        (q.type === 'short' ? '' : '<div style="margin-bottom:9px"><span class="rev-ans">' + rich(answerText(q)) + '</span></div>' +
          (q.options ? '<div style="color:var(--ink-3);font-size:13px;margin-bottom:9px">' +
            q.options.map(function (o, i) { return letter(i) + '. ' + rich(o); }).join('<br>') + '</div>' : '')) +
        (q.type === 'short' && q.answer ? '<div class="ra-label" style="font-size:11.5px;font-weight:700;color:var(--ink-3);letter-spacing:.06em;margin-bottom:6px">参考答案要点</div><div style="margin-bottom:10px">' + rich(q.answer) + '</div>' : '') +
        (q.explain ? '<div style="border-top:1px dashed var(--line-2);padding-top:10px">' + rich(q.explain) + '</div>' : '') +
        '</div></details></article>';
    }).join('');

    return head +
      '<div class="card" style="margin-bottom:16px"><div class="card-head"><h2>' + ids.length + ' 道待消灭</h2>' +
      '<span class="hint">按出错次数排序</span></div>' +
      '<div class="row wrap" style="gap:8px;margin-bottom:14px">' +
      '<button class="btn btn-primary btn-sm" data-act="mistake-drill-all">全部重做（' + ids.length + '）</button>' +
      chips +
      '<div style="flex:1"></div>' +
      '<button class="btn btn-sm btn-ghost btn-danger" data-act="mistake-clear">清空错题本</button>' +
      '</div>' +
      '<div class="q-list">' + items + '</div></div>';
  }

  /* ---------------- 视图：背诵卡 ---------------- */
  function viewCards() {
    if (state.deck) return renderDeck();
    var head = '<div class="page-head"><h1>背诵卡</h1>' +
      '<p class="sub">按科目组织的高频考点速记卡，采用间隔重复：每次自评「认识 / 模糊 / 不认识」，系统据此安排下次复习时间。</p></div>';

    var decks = SUBJ_ORDER.map(function (s) {
      var all = window.CARDS[s] || [];
      var due = dueCards(s);
      var mastered = all.filter(function (c) { var st = state.cards[c.id]; return st && st.stage >= 4; }).length;
      return '<div class="deck-card" data-s="' + s + '">' +
        '<div class="row" style="gap:8px"><span class="subj-code" style="color:var(--sc);background:var(--sc-soft);border-color:var(--sc-line)">' + SUBJ[s].code + '</span>' +
        '<strong style="font-size:15px">' + SUBJ[s].name + '</strong></div>' +
        '<div class="deck-num">' +
        '<div class="dn"><b class="due">' + due.length + '</b><span>今日待复习</span></div>' +
        '<div class="dn"><b>' + all.length + '</b><span>卡片总数</span></div>' +
        '<div class="dn"><b>' + mastered + '</b><span>已熟练</span></div>' +
        '</div>' +
        '<div class="row" style="gap:8px">' +
        '<button class="btn btn-sm btn-primary" data-act="deck-due" data-s="' + s + '"' + (due.length ? '' : ' disabled') + '>复习到期卡</button>' +
        '<button class="btn btn-sm" data-act="deck-all" data-s="' + s + '">全部过一遍</button>' +
        '</div></div>';
    }).join('');

    return head + '<div class="deck-grid">' + decks + '</div>';
  }

  function renderDeck() {
    var d = state.deck;
    var list = window.CARDS[d.subject] || [];
    var cid = d.queue[d.idx];
    var card = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === cid) card = list[i];
    if (!card) { state.deck = null; return viewCards(); }
    var st = state.cards[card.id];

    return '<div class="card-stage flip-stage" data-s="' + d.subject + '">' +
      '<div class="quiz-top" style="margin-bottom:16px">' +
      '<span class="subj-pill subj-' + d.subject + '">' + SUBJ[d.subject].code + ' ' + SUBJ[d.subject].name + '</span>' +
      '<span class="quiz-progress">' + (d.idx + 1) + ' / ' + d.queue.length + '</span>' +
      '<span class="bar bar-' + d.subject + '"><i style="width:' + Math.round((d.idx / d.queue.length) * 100) + '%"></i></span>' +
      '<button class="btn btn-ghost btn-sm quiz-quit" data-act="deck-exit">退出</button>' +
      '</div>' +
      '<div class="flip' + (d.flipped ? ' is-flipped' : '') + '" data-act="flip" role="button" tabindex="0" aria-label="点击翻面">' +
      '<div class="flip-face flip-front">' +
      '<div class="flip-meta"><span class="tag">' + esc(card.chapter) + '</span>' +
      (st ? '<span class="tag" style="font-family:var(--mono)">已复习 ' + st.stage + ' 轮</span>' : '<span class="tag">新卡片</span>') + '</div>' +
      '<div class="flip-label">问题 · 先自己回忆</div>' +
      '<div class="flip-q">' + rich(card.front) + '</div>' +
      '<div class="flip-hint">点击卡片查看答案 · 快捷键 <kbd>空格</kbd></div>' +
      '</div>' +
      '<div class="flip-face flip-back">' +
      '<div class="flip-label">答案要点</div>' +
      '<div class="flip-a">' + rich(card.back) + '</div>' +
      '<div class="flip-hint">按记忆程度自评，决定下次复习时间</div>' +
      '</div></div>' +
      (d.flipped ? '<div class="rate-row">' +
        '<button class="rate-btn" data-act="rate" data-r="again"><b>不认识</b><span>稍后重看</span></button>' +
        '<button class="rate-btn" data-act="rate" data-r="hard"><b>模糊</b><span>' + nextLabel(card, 'hard') + '</span></button>' +
        '<button class="rate-btn" data-act="rate" data-r="easy"><b>认识</b><span>' + nextLabel(card, 'easy') + '</span></button>' +
        '</div>' : '') +
      '</div>';
  }

  function nextLabel(card, r) {
    var st = state.cards[card.id];
    var stage = st ? st.stage : 0;
    var ns = Math.min(stage + 1, CARD_INTERVALS.length - 1);
    if (r === 'again') return '本次内重看';
    if (r === 'hard') return Math.max(1, Math.floor(CARD_INTERVALS[ns] / 2)) + ' 天后';
    return (CARD_INTERVALS[ns] || 1) + ' 天后';
  }

  /* ---------------- 视图：考纲考点 ---------------- */
  function viewSyllabus() {
    var s = state.sylSubject;
    var syl = window.SYLLABUS[s];
    var tabs = SUBJ_ORDER.map(function (k) {
      return '<button class="syl-tab" data-s="' + k + '" data-act="syl-subject" role="tab" aria-selected="' + (k === s) + '">' +
        '<span class="dot"></span>' + SUBJ[k].code + ' ' + SUBJ[k].name +
        '<span class="pct">' + (function () { var p = syllabusPct(k); return p ? p.pct + '%' : ''; })() + '</span></button>';
    }).join('');

    var p = syllabusPct(s);
    var head = '<div class="page-head"><h1>考纲考点</h1>' +
      '<p class="sub">四科的知识框架与高频考点清单，勾选记录掌握进度。建议先按框架通读，再用刷题训练检验漏洞。</p></div>';

    var chapters = syl.chapters.map(function (ch, ci) {
      var done = ch.points.filter(function (_, pi) { return state.kp[kpKey(s, ch, pi)]; }).length;
      var pct = ch.points.length ? Math.round(done / ch.points.length * 100) : 0;
      return '<details class="chapter" data-s="' + s + '"' + (ci === 0 ? ' open' : '') + '>' +
        '<summary><span class="caret">▶</span>' +
        '<span>' + esc(ch.name) + '</span>' +
        (ch.weight ? '<span class="ch-w">约 ' + ch.weight + '%</span>' : '<span class="ch-w">方法</span>') +
        '<span class="bar ch-bar bar-' + s + '"><i style="width:' + pct + '%"></i></span>' +
        '<span class="ch-pct">' + done + '/' + ch.points.length + '</span>' +
        '</summary>' +
        '<div class="kps">' + ch.points.map(function (pt, pi) {
          var key = kpKey(s, ch, pi);
          var on = !!state.kp[key];
          return '<div class="kp' + (on ? ' is-done' : '') + '" data-act="kp" data-k="' + esc(key) + '" role="checkbox" tabindex="0" aria-checked="' + on + '">' +
            '<span class="kp-box">' + ICO.check + '</span><span class="kp-text">' + rich(pt) + '</span></div>';
        }).join('') + '</div></details>';
    }).join('');

    return head +
      '<div class="syl-tabs" role="tablist">' + tabs + '</div>' +
      '<div class="card" style="margin-bottom:16px"><div class="syl-head">' +
      '<div style="flex:1;min-width:240px"><h2>' + SUBJ[s].full + '</h2><p class="sh-desc">' + esc(syl.desc) + '</p></div>' +
      '<div class="syl-progress">' +
      '<div class="metric" style="margin-bottom:6px"><span class="m-num">' + (p ? p.pct : 0) + '<span class="m-unit">%</span></span>' +
      '<span class="m-label">考点掌握 ' + (p ? p.done + ' / ' + p.total : '0 / 0') + '</span></div>' +
      '<span class="bar bar-' + s + '"><i style="width:' + (p ? p.pct : 0) + '%"></i></span></div>' +
      '</div></div>' +
      chapters +
      '<div style="margin-top:16px" class="row wrap">' +
      '<button class="btn btn-sm" data-act="kp-practice" data-s="' + s + '">刷这一科的题</button>' +
      '<button class="btn btn-sm" data-act="kp-cards" data-s="' + s + '">背这一科的卡片</button>' +
      '<div style="flex:1"></div>' +
      '<button class="btn btn-sm btn-ghost btn-danger" data-act="kp-reset" data-s="' + s + '">清空本科勾选</button>' +
      '</div>' +
      '<p class="note" style="margin-top:16px">科目代码（338/811/101/201）、满分与初试安排依据中国药科大学 2027 年招生简章与招生专业目录；学校未公布章节级考试大纲，下列考点清单与分值权重为复习框架，用于自查覆盖度，当年大纲公布后请以研究生院官网为准。</p>';
  }

  /* ---------------- 视图：复习计划 ---------------- */
  function viewPlan() {
    var overall = planPct();
    var left = daysTo(examDate());

    function stageNow() {
      var m = new Date().getMonth() + 1;
      if (m >= 3 && m <= 6) return 'base';
      if (m >= 7 && m <= 9) return 'strengthen';
      if (m >= 10 && m <= 11) return 'sprint';
      return 'final';
    }
    var cur = stageNow();

    var stages = window.PLAN_STAGES.map(function (st) {
      var done = st.tasks.filter(function (t) { return state.plan[t.id]; }).length;
      var pct = Math.round(done / st.tasks.length * 100);
      var isCur = st.id === cur;
      return '<section class="plan-stage">' +
        '<div class="stage-head">' +
        '<h3>' + esc(st.name) + (isCur ? ' <span class="tag" style="background:var(--brand-soft);color:var(--brand-deep);border-color:var(--brand-line)">当前阶段</span>' : '') + '</h3>' +
        '<span class="stage-when">' + esc(st.when) + '</span>' +
        '<span class="stage-pct">' + done + '/' + st.tasks.length + ' · ' + pct + '%</span>' +
        '</div>' +
        '<span class="bar" style="display:block;margin-bottom:12px"><i style="width:' + pct + '%"></i></span>' +
        '<p style="font-size:13px;color:var(--ink-2);margin-bottom:12px;line-height:1.75">' + esc(st.goal) + '</p>' +
        st.tasks.map(function (t) {
          var on = !!state.plan[t.id];
          var s = t.subject === 'mix' ? null : t.subject;
          return '<div class="task' + (on ? ' is-done' : '') + '" data-act="task" data-t="' + t.id + '" role="checkbox" tabindex="0" aria-checked="' + on + '">' +
            '<span class="task-box">' + ICO.check + '</span>' +
            '<span class="task-body">' +
            '<span class="task-title">' + (s ? '<span class="subj-pill subj-' + s + '" style="margin-right:7px">' + SUBJ[s].code + '</span>' : '<span class="subj-pill" style="margin-right:7px;color:var(--brand);background:var(--brand-soft);border-color:var(--brand-line)">综合</span>') + esc(t.title) + '</span>' +
            (t.note ? '<span class="task-note">' + esc(t.note) + '</span>' : '') +
            '</span></div>';
        }).join('') +
        '</section>';
    }).join('');

    return '<div class="page-head"><h1>复习计划</h1>' +
      '<p class="sub">按基础、强化、冲刺、考前四个阶段拆解的任务清单，勾选即计入进度。任务内容是通用备考框架，请结合自己的基础与药大历年真题调整。</p></div>' +
      '<div class="grid grid-3" style="margin-bottom:20px">' +
      '<div class="card"><div class="metric"><span class="m-num">' + overall.pct + '<span class="m-unit">%</span></span><span class="m-label">总体完成度 · ' + overall.done + '/' + overall.total + ' 项</span></div>' +
      '<span class="bar" style="display:block;margin-top:10px"><i style="width:' + overall.pct + '%"></i></span></div>' +
      '<div class="card"><div class="metric"><span class="m-num">' + (left > 0 ? left : 0) + '<span class="m-unit">天</span></span><span class="m-label">距初试剩余时间</span></div>' +
      '<span style="display:block;margin-top:10px;font-size:12.5px;color:var(--ink-3);font-family:var(--mono)">' + esc(examDate()) + '</span></div>' +
      '<div class="card"><div class="metric"><span class="m-num">' + streak() + '<span class="m-unit">天</span></span><span class="m-label">连续打卡</span></div>' +
      '<span style="display:block;margin-top:10px;font-size:12.5px;color:var(--ink-3)">答对题目或复习卡片即算打卡</span></div>' +
      '</div>' + stages +
      '<div class="row wrap" style="margin-top:8px"><div style="flex:1"></div>' +
      '<button class="btn btn-sm btn-ghost btn-danger" data-act="plan-reset">清空全部计划进度</button></div>';
  }

  /* ---------------- 视图：费曼讲解 ----------------
     用「讲给外行听」检验真懂还是假懂：先自己讲一遍，再对照参考要点，
     写下卡壳的地方，按自评安排下一次重讲。素材取自带参考答案的内容
     （背诵卡背面、主观题参考答案），这样每一步都有可对照的标准。 */

  var FEY_STEPS = [
    { t: '选一个概念', d: '从背诵卡或主观题里挑一个考点。' },
    { t: '讲给外行听', d: '不看资料，用自己的话讲清楚，别用术语堆砌。' },
    { t: '找出卡壳处', d: '对照参考要点，记下讲不下去、讲错、只能背原话的地方。' },
    { t: '重讲卡壳处', d: '回到教材补齐，隔一段时间只重讲卡壳的部分。' }
  ];

  var FEY_SOURCE = [
    { id: 'mix', name: '卡片 + 主观题' },
    { id: 'card', name: '只用背诵卡' },
    { id: 'short', name: '只用主观题' }
  ];
  var FEY_SCOPE = [
    { id: 'all', name: '全部内容' },
    { id: 'new', name: '还没讲过' },
    { id: 'due', name: '到期待讲' },
    { id: 'stuck', name: '上次卡壳的' }
  ];
  var FEY_RATINGS = ['stuck', 'shaky', 'clear'];

  function feynmanTarget(key) {
    var i = String(key).indexOf(':');
    if (i <= 0) return null;
    var kind = key.slice(0, i), id = key.slice(i + 1);
    if (kind === 'card') {
      for (var a = 0; a < SUBJ_ORDER.length; a++) {
        var s = SUBJ_ORDER[a], list = window.CARDS[s] || [];
        for (var b = 0; b < list.length; b++) {
          if (list[b].id !== id) continue;
          return {
            key: key, kind: 'card', subject: s, chapter: list[b].chapter,
            prompt: list[b].front, reference: list[b].back, explain: null, label: '背诵卡'
          };
        }
      }
      return null;
    }
    if (kind !== 'q') return null;
    var q = findQuestion(id);
    if (!q || q.type !== 'short' || !q.answer) return null;
    return {
      key: key, kind: 'q', subject: q.subject, chapter: q.chapter,
      prompt: q.stem, reference: q.answer, explain: q.explain || null, label: '主观题'
    };
  }

  function feynmanKeys(s, source) {
    var keys = [];
    if (source !== 'short') {
      (window.CARDS[s] || []).forEach(function (c) { keys.push('card:' + c.id); });
    }
    if (source !== 'card') {
      (window.QB[s] || []).forEach(function (q) {
        if (q.type === 'short' && q.answer) keys.push('q:' + q.id);
      });
    }
    return keys;
  }

  function feynmanDue(key) {
    var f = state.feynman[key];
    return !f || !f.due || f.due <= today();
  }

  function feynmanPool(s, source, scope) {
    var keys = feynmanKeys(s, source);
    if (scope === 'new') return keys.filter(function (k) { return !state.feynman[k]; });
    if (scope === 'due') return keys.filter(function (k) { return feynmanDue(k); });
    if (scope === 'stuck') {
      return keys.filter(function (k) { var f = state.feynman[k]; return !!(f && f.stuck); });
    }
    return keys;
  }

  function feynmanStats() {
    var total = 0, done = 0, stuck = 0, due = 0;
    SUBJ_ORDER.forEach(function (s) {
      feynmanKeys(s, 'mix').forEach(function (k) {
        total++;
        var f = state.feynman[k];
        if (f) { done++; if (f.stuck) stuck++; }
        if (feynmanDue(k)) due++;
      });
    });
    return { total: total, done: done, stuck: stuck, due: due };
  }

  function feynmanNextLabel(key, r) {
    var f = state.feynman[key];
    var stage = f ? f.stage : 0;
    if (r === 'stuck') return '今天再讲一次';
    if (r === 'shaky') return '1 天后重讲';
    var ns = Math.min(stage + 1, CARD_INTERVALS.length - 1);
    return (CARD_INTERVALS[ns] || 1) + ' 天后重讲';
  }

  function viewFeynman() {
    if (state.talk) return state.talk.done ? renderTalkResult() : renderTalk();
    var ts = state.talkSetup;
    var s = subjKey(ts.subject);
    var st = feynmanStats();

    var head = '<div class="page-head"><h1>费曼讲解</h1>' +
      '<p class="sub">「讲不清楚，就是还没懂。」挑一个考点，合上资料用自己的话讲一遍，再对照参考要点找出卡壳的地方——卡壳点才是真正要补的漏洞。</p></div>';

    var steps = '<div class="card" style="margin-bottom:16px"><div class="card-head"><h2>四步循环</h2>' +
      '<span class="hint">每一轮只针对卡壳的部分</span></div>' +
      '<div class="fey-steps">' + FEY_STEPS.map(function (x, i) {
        return '<div class="fey-step"><span class="fs-n">' + (i + 1) + '</span>' +
          '<div><b>' + esc(x.t) + '</b><p>' + esc(x.d) + '</p></div></div>';
      }).join('') + '</div></div>';

    var subjChips = SUBJ_ORDER.map(function (k) {
      return '<button class="chip" data-act="fey-subject" data-s="' + k + '" aria-pressed="' + (k === s) + '">' +
        SUBJ[k].code + ' ' + SUBJ[k].name +
        '<span class="chip-n">' + feynmanKeys(k, ts.source).length + '</span></button>';
    }).join('');

    var srcChips = FEY_SOURCE.map(function (o) {
      return '<button class="chip" data-act="fey-source" data-v="' + o.id + '" aria-pressed="' + (ts.source === o.id) + '">' +
        esc(o.name) + '</button>';
    }).join('');

    var scopeChips = FEY_SCOPE.map(function (o) {
      var n = feynmanPool(s, ts.source, o.id).length;
      return '<button class="chip" data-act="fey-scope" data-v="' + o.id + '" aria-pressed="' + (ts.scope === o.id) + '">' +
        esc(o.name) + '<span class="chip-n">' + n + '</span></button>';
    }).join('');

    var pool = feynmanPool(s, ts.source, ts.scope);
    var maxN = Math.max(5, Math.min(30, pool.length));
    var counts = [5, 8, 10, 15, 20].filter(function (n) { return n <= maxN; });
    if (!counts.length) counts = [5];
    if (pool.length && counts[counts.length - 1] < pool.length) counts.push(0);

    return head + steps +
      '<div class="setup-panel">' +
      '<div class="card">' +
      '<div class="field"><span class="field-label">选择科目</span><div class="chip-row">' + subjChips + '</div></div>' +
      '<div class="field"><span class="field-label">讲解素材</span><div class="chip-row">' + srcChips + '</div></div>' +
      '<div class="field"><span class="field-label">范围</span><div class="chip-row">' + scopeChips + '</div></div>' +
      (ts.scope === 'stuck'
        ? '<p class="fey-note">卡壳点来自你上一轮自评「有点卡 / 讲不出」的内容。讲清一次后会自动移出这个清单。</p>'
        : '') +
      '</div>' +
      '<div class="stack">' +
      '<div class="card">' +
      '<div class="card-head"><h2>本轮讲解</h2></div>' +
      '<div class="field"><label for="feyCount">讲解数量</label>' +
      '<select id="feyCount" data-bind="feycount">' + counts.map(function (n) {
        var v = ts.count === n ? ' selected' : '';
        return '<option value="' + n + '"' + v + '>' + (n === 0 ? '全部（' + pool.length + ' 个）' : n + ' 个') + '</option>';
      }).join('') + '</select></div>' +
      '<p style="font-size:12.5px;color:var(--ink-3);margin-bottom:14px">当前筛选出 <b style="font-family:var(--mono);color:var(--ink-2)">' +
      pool.length + '</b> 个可讲的内容。</p>' +
      '<button class="btn btn-primary" data-act="fey-start" style="width:100%"' + (pool.length ? '' : ' disabled') + '>开始讲解</button>' +
      '</div>' +
      '<div class="card"><div class="card-head"><h2>讲解进度</h2></div>' +
      '<div class="fey-nums">' +
      '<div class="dn"><b>' + st.done + '</b><span>讲过</span></div>' +
      '<div class="dn"><b class="due">' + st.due + '</b><span>待讲</span></div>' +
      '<div class="dn"><b class="bad">' + st.stuck + '</b><span>卡壳</span></div>' +
      '</div>' +
      '<span class="bar" style="display:block;margin-top:12px"><i style="width:' +
      (st.total ? Math.round(st.done / st.total * 100) : 0) + '%"></i></span>' +
      '<p style="font-size:12px;color:var(--ink-3);margin-top:10px">共 ' + st.total + ' 个可讲内容，进度保存在本机浏览器。</p>' +
      '</div>' +
      '</div></div>';
  }

  function renderTalk() {
    var t = state.talk;
    var key = t.keys[t.idx];
    var item = feynmanTarget(key);
    if (!item) { state.talk = null; return viewFeynman(); }
    var s = item.subject;
    var prev = state.feynman[key];

    var top = '<div class="quiz-top" style="margin-bottom:16px">' +
      '<span class="subj-pill subj-' + s + '">' + SUBJ[s].code + ' ' + SUBJ[s].name + '</span>' +
      '<span class="quiz-progress">' + (t.idx + 1) + ' / ' + t.keys.length + '</span>' +
      '<span class="bar bar-' + s + '"><i style="width:' + Math.round(t.idx / t.keys.length * 100) + '%"></i></span>' +
      '<button class="btn btn-ghost btn-sm quiz-quit" data-act="fey-exit">退出</button>' +
      '</div>';

    var prompt = '<div class="card talk-card">' +
      '<div class="talk-meta"><span class="tag">' + esc(item.label) + '</span>' +
      '<span class="tag">' + esc(item.chapter) + '</span>' +
      (prev ? '<span class="tag" style="font-family:var(--mono)">讲过 ' + prev.stage + ' 轮</span>'
        : '<span class="tag">第一次讲</span>') +
      (prev && prev.stuck ? '<span class="tag tag-bad">上次卡壳</span>' : '') +
      '</div>' +
      '<div class="talk-label">假装对面坐着一个完全不懂的同学，把这个讲清楚</div>' +
      '<div class="talk-prompt">' + rich(item.prompt) + '</div>' +
      '<div class="answer-box talk-box"><textarea data-bind="talk" placeholder="不用写得很漂亮，按自己的话把来龙去脉讲出来：&#10;① 它是什么 / 要解决什么问题&#10;② 具体怎么运作，关键步骤和数字&#10;③ 为什么是这样，不这样会怎样&#10;④ 举一个自己的例子或类比&#10;&#10;讲不下去的地方，直接写「这里我卡住了」。"' +
      (t.revealed ? ' disabled' : '') + ' aria-label="我的讲解">' + esc(t.text || '') + '</textarea></div>' +
      (prev && prev.notes ? '<div class="talk-lastnote"><b>上次记下的卡壳点</b><p>' + rich(prev.notes) + '</p></div>' : '') +
      '</div>';

    var body = '';
    if (!t.revealed) {
      body = '<div class="q-foot">' +
        '<button class="btn btn-primary" data-act="fey-reveal"' + (String(t.text || '').trim() ? '' : ' disabled') + '>我讲完了，对照参考要点</button>' +
        '<span style="font-size:12.5px;color:var(--ink-3)">先讲完再对照，否则只是在重读答案</span>' +
        '</div>';
    } else {
      body = '<div class="explain talk-ref">' +
        '<div class="explain-verdict">对照下面的参考要点，看看自己漏了什么、讲错了什么</div>' +
        '<div class="ref-answer"><div class="ra-label">参考要点</div>' +
        '<div class="explain-text">' + rich(item.reference) + '</div></div>' +
        (item.explain ? '<div class="ref-answer"><div class="ra-label">补充说明</div>' +
          '<div class="explain-text">' + rich(item.explain) + '</div></div>' : '') +
        '<div class="field" style="margin-top:14px"><span class="field-label">把卡壳的地方写下来（下一步只补这些）</span>' +
        '<div class="answer-box talk-box is-short"><textarea data-bind="talknote" placeholder="例如：能背出糖酵解的三个关键酶，但说不清 PFK-1 为什么是最重要的调节点…">' +
        esc(t.note || '') + '</textarea></div></div>' +
        '<div class="rate-row">' +
        '<button class="rate-btn" data-act="fey-rate" data-r="stuck"><b>讲不出</b><span>' + feynmanNextLabel(key, 'stuck') + '</span></button>' +
        '<button class="rate-btn" data-act="fey-rate" data-r="shaky"><b>有点卡</b><span>' + feynmanNextLabel(key, 'shaky') + '</span></button>' +
        '<button class="rate-btn" data-act="fey-rate" data-r="clear"><b>讲清了</b><span>' + feynmanNextLabel(key, 'clear') + '</span></button>' +
        '</div>' +
        '<p class="fey-note" style="text-align:center">快捷键 <kbd>1</kbd> 讲不出 · <kbd>2</kbd> 有点卡 · <kbd>3</kbd> 讲清了</p>' +
        '</div>';
    }

    return '<div class="card-stage talk-stage" data-s="' + s + '">' + top + prompt + body + '</div>';
  }

  function renderTalkResult() {
    var t = state.talk;
    var tally = { clear: 0, shaky: 0, stuck: 0 };
    t.results.forEach(function (r) { tally[r.r] = (tally[r.r] || 0) + 1; });

    var stuck = t.results.filter(function (r) { return r.r !== 'clear'; });
    var items = stuck.map(function (r) {
      var item = feynmanTarget(r.key);
      if (!item) return '';
      return '<article class="q-item">' +
        '<div class="q-item-top">' +
        '<span class="subj-pill subj-' + item.subject + '">' + SUBJ[item.subject].code + ' ' + SUBJ[item.subject].name + '</span>' +
        '<span class="q-type">' + esc(item.label) + '</span>' +
        '<span class="tag">' + esc(item.chapter) + '</span>' +
        '<span class="miss-badge">' + (r.r === 'stuck' ? '讲不出' : '有点卡') + '</span>' +
        '<div class="q-item-actions">' +
        '<button class="btn btn-sm" data-act="fey-redo" data-k="' + esc(r.key) + '">现在重讲</button>' +
        (canWriteContent()
          ? '<button class="btn btn-sm" data-act="fey-tocard" data-k="' + esc(r.key) + '">存为背诵卡</button>' : '') +
        '</div></div>' +
        '<div class="q-item-stem">' + rich(item.prompt) + '</div>' +
        (r.note ? '<div class="talk-lastnote"><b>你记下的卡壳点</b><p>' + rich(r.note) + '</p></div>' : '') +
        '</article>';
    }).join('');

    return '<div class="card-stage talk-stage">' +
      '<div class="card talk-result">' +
      '<div class="tr-ico">' + ICO.feynman + '</div>' +
      '<h2>本轮讲完了</h2>' +
      '<p class="sub">讲清 ' + tally.clear + ' 个 · 有点卡 ' + tally.shaky + ' 个 · 讲不出 ' + tally.stuck + ' 个</p>' +
      '<div class="fey-nums" style="margin:18px 0">' +
      '<div class="dn"><b>' + tally.clear + '</b><span>讲清了</span></div>' +
      '<div class="dn"><b class="warn">' + tally.shaky + '</b><span>有点卡</span></div>' +
      '<div class="dn"><b class="bad">' + tally.stuck + '</b><span>讲不出</span></div>' +
      '</div>' +
      (stuck.length
        ? '<p style="font-size:13px;color:var(--ink-2);margin-bottom:12px">下面这些就是这一轮真正要补的地方。回教材补齐后，用「只讲卡壳的」范围再练一轮。</p>'
        : '<p style="font-size:13px;color:var(--ink-2);margin-bottom:12px">这一轮没有卡壳点，说明这些内容你已经能自己讲清楚了。</p>') +
      '<div class="row wrap" style="gap:8px">' +
      '<button class="btn btn-primary btn-sm" data-act="fey-again-stuck"' + (stuck.length ? '' : ' disabled') + '>只重讲卡壳的（' + stuck.length + '）</button>' +
      '<button class="btn btn-sm" data-act="fey-back">返回设置</button>' +
      '<div style="flex:1"></div>' +
      '<button class="btn btn-sm btn-ghost" data-act="nav" data-to="cards">去背诵卡</button>' +
      '</div></div>' +
      (items ? '<div class="card" style="margin-top:16px"><div class="card-head"><h2>卡壳清单</h2>' +
        '<span class="hint">' + stuck.length + ' 项</span></div><div class="q-list">' + items + '</div></div>' : '') +
      // 「还能怎么拿到权限」这类信息只该给 Qoder 站点的所有者看；
      // 自建部署下没有管理权限的人，连这个按钮的存在都不必知道。
      (state.account.mode === 'gateway' && !canWriteContent()
        ? '<p class="fey-note" style="margin-top:14px">在「内容管理」里启用后台管理后，卡壳点可以一键存成你自己的背诵卡，下次直接复习。</p>' : '') +
      '</div>';
  }

  function startTalk(keys) {
    var ts = state.talkSetup;
    var s = subjKey(ts.subject);
    var pool = keys || feynmanPool(s, ts.source, ts.scope);
    pool = pool.filter(function (k) { return !!feynmanTarget(k); });
    if (!pool.length) { toast('没有符合条件、可讲解的内容'); return; }
    var picked = keys ? pool.slice() : (ts.count === 0 ? pool.slice() : shuffle(pool).slice(0, ts.count));
    state.talk = {
      subject: s, keys: picked, idx: 0, revealed: false,
      text: '', note: '', results: [], done: false
    };
    render();
    window.scrollTo(0, 0);
  }

  function reloadCloud() {
    return loadCloud().then(function () { render(); });
  }

  // 卡壳点存成自己的背诵卡，下次在「背诵卡」里按间隔重复复习。
  function saveStuckCard(key, btn) {
    var item = feynmanTarget(key);
    var f = state.feynman[key];
    if (!item) return;
    if (!f || !f.notes) { toast('先写下卡壳点，才能存成背诵卡'); return; }
    if (btn) btn.disabled = true;
    window.Cloud.upsertCard({
      id: 'fey-' + Date.now().toString(36),
      subject: item.subject,
      chapter: clipBytes(item.chapter, 80),
      front: clipBytes(item.prompt, 600),
      back: '【我的卡壳点】\n' + clipBytes(f.notes, 2600) +
        '\n\n【参考要点】\n' + clipBytes(item.reference, 4600)
    }).then(reloadCloud).then(function () {
      toast('已存为背诵卡');
    }).catch(function (e) {
      if (btn) btn.disabled = false;
      toast(e && e.message ? e.message : '保存失败，请稍后重试');
    });
  }

  /* ---------------- 视图：内容管理 ----------------
     后台入口：题库、考纲章节、背诵卡的增删改，以及内置内容上云与 JSON 导入导出。
     写入一律走站点 Function，由服务端校验「只有站点所有者能改」。 */

  var ADM_TABS = [
    { id: 'questions', name: '题目' },
    { id: 'chapters', name: '考纲章节' },
    { id: 'cards', name: '背诵卡' }
  ];
  var ADM_LEVEL = { 1: '基础', 2: '常考', 3: '高频重点' };
  var ADM_LIST_CAP = 200;
  var ADM_BATCH = 4;

  function admRows(kind, subject, q) {
    var needle = String(q || '').trim().toLowerCase();
    function hit(text) { return !needle || String(text || '').toLowerCase().indexOf(needle) > -1; }
    if (kind === 'questions') {
      var out = [];
      SUBJ_ORDER.forEach(function (s) {
        if (subject !== 'all' && s !== subject) return;
        (window.QB[s] || []).forEach(function (x) {
          if (hit(x.stem) || hit(x.chapter) || hit(x.id) || hit((x.tags || []).join(' '))) out.push(x);
        });
      });
      return out;
    }
    if (kind === 'chapters') {
      var chs = [];
      SUBJ_ORDER.forEach(function (s) {
        if (subject !== 'all' && s !== subject) return;
        var syl = window.SYLLABUS[s];
        ((syl && syl.chapters) || []).forEach(function (c) {
          if (hit(c.name) || hit(c.id) || hit((c.points || []).join(' '))) {
            chs.push({ id: c.id, subject: s, name: c.name, weight: c.weight, points: c.points, built_in: c.built_in });
          }
        });
      });
      return chs;
    }
    var cds = [];
    SUBJ_ORDER.forEach(function (s) {
      if (subject !== 'all' && s !== subject) return;
      (window.CARDS[s] || []).forEach(function (c) {
        if (hit(c.front) || hit(c.back) || hit(c.chapter) || hit(c.id)) {
          cds.push({ id: c.id, subject: s, chapter: c.chapter, front: c.front, back: c.back, built_in: c.built_in });
        }
      });
    });
    return cds;
  }

  function admBadge(builtIn) {
    return builtIn ? '<span class="tag tag-mute">内置</span>' : '<span class="tag tag-own">自建</span>';
  }

  function renderAdminList() {
    var host = document.getElementById('adminList');
    if (!host) return;
    var a = state.admin;
    var rows = admRows(a.tab, a.subject, a.q);
    var canWrite = canWriteContent();
    var shown = rows.slice(0, ADM_LIST_CAP);
    var body;

    if (!rows.length) {
      body = '<div class="empty"><p class="empty-title">没有匹配的内容</p>' +
        '<p>换个关键词，或者点「新建」添加一条。</p></div>';
    } else if (a.tab === 'questions') {
      body = shown.map(function (x) {
        return '<div class="adm-row">' +
          '<div class="adm-main">' +
          '<div class="adm-line"><span class="subj-pill subj-' + x.subject + '">' + SUBJ[x.subject].code + '</span>' +
          '<span class="q-type">' + TYPE_LABEL[x.type] + '</span>' +
          '<span class="tag">' + esc(x.chapter) + '</span>' +
          '<span class="tag tag-mute">' + (ADM_LEVEL[x.level] || '常考') + '</span>' +
          admBadge(x.built_in) + '</div>' +
          '<div class="adm-title">' + esc(x.stem) + '</div>' +
          '<div class="adm-sub">编号 ' + esc(x.id) + '</div>' +
          '</div>' +
          '<div class="adm-act">' +
          '<button class="btn btn-sm" data-act="adm-edit" data-kind="question" data-id="' + esc(x.id) + '"' + (canWrite ? '' : ' disabled') + '>编辑</button>' +
          '<button class="btn btn-sm btn-ghost btn-danger" data-act="adm-del" data-kind="question" data-id="' + esc(x.id) + '"' + (canWrite ? '' : ' disabled') + '>删除</button>' +
          '</div></div>';
      }).join('');
    } else if (a.tab === 'chapters') {
      body = shown.map(function (x) {
        return '<div class="adm-row">' +
          '<div class="adm-main">' +
          '<div class="adm-line"><span class="subj-pill subj-' + x.subject + '">' + SUBJ[x.subject].code + '</span>' +
          '<span class="tag">' + (x.weight ? '约 ' + x.weight + '%' : '方法') + '</span>' +
          '<span class="tag tag-mute">' + (x.points || []).length + ' 个考点</span>' +
          admBadge(x.built_in) + '</div>' +
          '<div class="adm-title">' + esc(x.name) + '</div>' +
          '<div class="adm-sub">编号 ' + esc(x.id) + '</div>' +
          '</div>' +
          '<div class="adm-act">' +
          '<button class="btn btn-sm" data-act="adm-edit" data-kind="chapter" data-id="' + esc(x.id) + '"' + (canWrite ? '' : ' disabled') + '>编辑</button>' +
          '<button class="btn btn-sm btn-ghost btn-danger" data-act="adm-del" data-kind="chapter" data-id="' + esc(x.id) + '"' + (canWrite ? '' : ' disabled') + '>删除</button>' +
          '</div></div>';
      }).join('');
    } else {
      body = shown.map(function (x) {
        return '<div class="adm-row">' +
          '<div class="adm-main">' +
          '<div class="adm-line"><span class="subj-pill subj-' + x.subject + '">' + SUBJ[x.subject].code + '</span>' +
          '<span class="tag">' + esc(x.chapter) + '</span>' + admBadge(x.built_in) + '</div>' +
          '<div class="adm-title">' + esc(x.front) + '</div>' +
          '<div class="adm-sub">编号 ' + esc(x.id) + '</div>' +
          '</div>' +
          '<div class="adm-act">' +
          '<button class="btn btn-sm" data-act="adm-edit" data-kind="card" data-id="' + esc(x.id) + '"' + (canWrite ? '' : ' disabled') + '>编辑</button>' +
          '<button class="btn btn-sm btn-ghost btn-danger" data-act="adm-del" data-kind="card" data-id="' + esc(x.id) + '"' + (canWrite ? '' : ' disabled') + '>删除</button>' +
          '</div></div>';
      }).join('');
    }

    host.innerHTML = body +
      (rows.length > ADM_LIST_CAP
        ? '<p class="fey-note" style="text-align:center;padding:12px 0">只列出前 ' + ADM_LIST_CAP + ' 条，共 ' + rows.length + ' 条。用搜索或科目筛选缩小范围。</p>'
        : '');
    var countEl = document.getElementById('admCount');
    if (countEl) countEl.textContent = rows.length + ' 条';
  }

  /* 编辑器顶部的富文本工具条：选字段 → 插图片 / 看预览。
     这里所有操作都直接改 DOM，绝不走 render()——编辑器的输入只在保存时才回写 state，
     中途整页重绘会把用户正在打的字全部丢掉。 */
  function markupTargets(d) {
    if (d.kind === 'question') {
      var t = [{ v: 'stem', label: '题干' }];
      if (d.qtype !== 'blank' && d.qtype !== 'short') {
        var slots = d.qtype === 'judge' ? 2 : (d.opts || []).length || 4;
        for (var i = 0; i < slots; i++) t.push({ v: 'opt:' + i, label: '选项 ' + letter(i) });
      }
      t.push({ v: 'explain_text', label: '解析' });
      if (d.qtype === 'blank' || d.qtype === 'short') t.push({ v: 'answer', label: '参考答案' });
      return t;
    }
    if (d.kind === 'chapter') return [{ v: 'points', label: '考点清单' }];
    return [{ v: 'front', label: '正面' }, { v: 'back', label: '背面' }];
  }

  function markupBar(d) {
    var targets = markupTargets(d);
    // 插图只有自建服务能用：Qoder 站点的 Function 没有 upload 动作，按钮摆出来也只会报错。
    var canUpload = state.account.mode === 'accounts' && canWriteContent();
    return '<div class="field markup-bar">' +
      '<span class="field-label">公式 / 配图</span>' +
      '<div class="row wrap" style="gap:8px;align-items:center">' +
      '<select id="amTarget" aria-label="选择字段">' + targets.map(function (t) {
        return '<option value="' + t.v + '">' + t.label + '</option>';
      }).join('') + '</select>' +
      (canUpload
        ? '<button class="btn btn-sm" data-act="adm-img"' + (state.admin.imgBusy ? ' disabled' : '') + '>' +
          (state.admin.imgBusy ? '上传中…' : '插入图片') + '</button>' +
          '<input type="file" id="amFile" accept="image/png,image/jpeg,image/gif,image/webp" hidden>'
        : '') +
      '<button class="btn btn-sm btn-ghost" data-act="am-preview">' +
      (state.admin.preview ? '收起预览' : '预览效果') + '</button>' +
      '<span class="am-status" id="amStatus" role="status"></span>' +
      '</div>' +
      '<span class="f-help">支持 $E=mc^2$ 行内公式、$$…$$ 独立公式、$\\ce{H2SO4}$ 化学式、**加粗**；' +
      '图片写成 ![说明](地址)，地址由「插入图片」自动生成。' +
      (canUpload ? '' : '当前后端不支持插图，只能手写图片地址。') + '</span>' +
      '<div id="amPreviewHost">' +
      (state.admin.preview ? '<div class="markup-preview" id="admPreview"></div>' : '') +
      '</div></div>';
  }

  function amStatus(text, bad) {
    var el = document.getElementById('amStatus');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'am-status' + (bad ? ' is-err' : '');
  }

  // 'opt:2' 这种带下标的目标指向第 3 个选项输入框，其余就是普通的 data-f 名。
  function amTargetEl(value) {
    var box = document.getElementById('admEditor');
    if (!box) return null;
    var parts = String(value || '').split(':');
    if (parts[0] === 'opt') {
      var els = box.querySelectorAll('[data-f="opt"]');
      return els[parseInt(parts[1], 10)] || null;
    }
    return box.querySelector('[data-f="' + parts[0] + '"]');
  }

  function amRefreshPreview() {
    if (!state.admin.preview) return;
    var box = document.getElementById('admPreview');
    var sel = document.getElementById('amTarget');
    if (!box || !sel) return;
    var field = String(sel.value || '').split(':')[0];
    var el = amTargetEl(sel.value);
    var text = el ? el.value : '';
    var html;
    if (field === 'points') {
      // 考点是一行一条、每条单独渲染的，预览也得按行来，跟实际显示一致。
      html = text.split('\n').map(function (line) {
        return line.trim() ? '<p class="mp-line">' + rich(line) + '</p>' : '';
      }).join('');
    } else if (field === 'opt') {
      html = text.trim() ? '<p class="mp-line"><b>' + esc(letter(parseInt(String(sel.value).split(':')[1], 10))) +
        '.</b> ' + rich(text) + '</p>' : '';
    } else html = rich(text);
    box.innerHTML = html.trim() ? html : '<p class="mp-empty">这个字段还没有内容。</p>';
    paintMath(box);
  }

  var amPreviewQueued = false;
  function amRefreshPreviewSoon() {
    if (amPreviewQueued || !state.admin.preview) return;
    amPreviewQueued = true;
    setTimeout(function () { amPreviewQueued = false; amRefreshPreview(); }, 0);
  }

  function amTogglePreview() {
    state.admin.preview = !state.admin.preview;
    var host = document.getElementById('amPreviewHost');
    var btn = document.querySelector('[data-act="am-preview"]');
    if (btn) btn.textContent = state.admin.preview ? '收起预览' : '预览效果';
    if (!host) return;
    host.innerHTML = state.admin.preview ? '<div class="markup-preview" id="admPreview"></div>' : '';
    amRefreshPreview();
  }

  function amInsertImage(file) {
    var sel = document.getElementById('amTarget');
    var el = amTargetEl(sel ? sel.value : 'stem');
    var btn = document.querySelector('[data-act="adm-img"]');
    if (!el) { amStatus('找不到要插入的输入框。', true); return; }
    if (state.admin.imgBusy) return;
    state.admin.imgBusy = true;
    if (btn) { btn.disabled = true; btn.textContent = '上传中…'; }
    amStatus('正在上传 ' + (file.name || '图片') + '…');
    // 记住光标位置：上传是异步的，回来时焦点可能已经跑到别处了。
    var at = el.selectionStart;
    window.Cloud.uploadImage(file).then(function (url) {
      var text = el.value || '';
      var pos = typeof at === 'number' && at >= 0 && at <= text.length ? at : text.length;
      var multi = el.tagName === 'TEXTAREA';
      var snippet = multi ? '\n\n![配图](' + url + ')\n' : '![配图](' + url + ')';
      el.value = text.slice(0, pos) + snippet + text.slice(pos);
      try {
        el.focus();
        var caret = pos + snippet.length;
        el.setSelectionRange(caret, caret);
      } catch (e) { /* 定位不了光标就算了，内容已经插进去了 */ }
      amRefreshPreview();
      amStatus('已插入，别忘了点「保存到云端」。');
    }, function (e) {
      amStatus((e && e.message) || '图片上传失败。', true);
    }).then(function () {
      state.admin.imgBusy = false;
      var b = document.querySelector('[data-act="adm-img"]');
      if (b) { b.disabled = false; b.textContent = '插入图片'; }
    });
  }

  function admEditor() {
    var d = state.admin.editing;
    if (!d) return '';
    var isNew = !d.exists;
    var idField = '<div class="field"><label for="f-id">编号</label>' +
      '<input id="f-id" data-f="id" type="text" value="' + esc(d.id || '') + '"' + (isNew ? '' : ' disabled') +
      ' placeholder="小写字母、数字和短横线，例如 bio-20">' +
      '<span class="f-help">编号是内容的唯一标识，保存后不能改。删除重建会丢掉这条内容对应的做题记录。</span></div>';

    var subjectField = '<div class="field"><label for="f-subject">科目</label>' +
      '<select id="f-subject" data-f="subject">' + SUBJ_ORDER.map(function (s) {
        return '<option value="' + s + '"' + (d.subject === s ? ' selected' : '') + '>' + esc(SUBJ[s].full) + '</option>';
      }).join('') + '</select></div>';

    var inner;
    if (d.kind === 'question') {
      var isText = d.qtype === 'blank' || d.qtype === 'short';
      var slots = d.qtype === 'judge' ? 2 : 6;
      var opts = [];
      for (var i = 0; i < slots; i++) opts.push(d.opts[i] || (d.qtype === 'judge' ? (i === 0 ? '正确' : '错误') : ''));
      inner =
        '<div class="field"><label for="f-chapter">章节</label>' +
        '<input id="f-chapter" data-f="chapter" type="text" value="' + esc(d.chapter || '') + '" list="admChapters" placeholder="与考纲章节名一致，便于按章节筛题"></div>' +
        '<datalist id="admChapters">' + chaptersOf(d.subject).map(function (c) {
          return '<option value="' + esc(c) + '"></option>';
        }).join('') + '</datalist>' +
        '<div class="row wrap" style="gap:12px">' +
        '<div class="field" style="flex:1;min-width:150px"><label for="f-qtype">题型</label>' +
        '<select id="f-qtype" data-f="qtype">' + Object.keys(TYPE_LABEL).map(function (t) {
          return '<option value="' + t + '"' + (d.qtype === t ? ' selected' : '') + '>' + TYPE_LABEL[t] + '</option>';
        }).join('') + '</select></div>' +
        '<div class="field" style="flex:1;min-width:150px"><label for="f-level">重要程度</label>' +
        '<select id="f-level" data-f="level">' + Object.keys(ADM_LEVEL).map(function (l) {
          return '<option value="' + l + '"' + (String(d.level) === l ? ' selected' : '') + '>' + ADM_LEVEL[l] + '</option>';
        }).join('') + '</select></div>' +
        '<div class="field" style="flex:2;min-width:200px"><label for="f-tags">标签</label>' +
        '<input id="f-tags" data-f="tags" type="text" value="' + esc((d.tags || []).join('，')) + '" placeholder="用逗号分隔，例如 高频，易错"></div>' +
        '</div>' +
        '<div class="field"><label for="f-stem">题干</label>' +
        '<textarea id="f-stem" data-f="stem" rows="3" placeholder="填空题用 ___ 表示空位">' + esc(d.stem || '') + '</textarea></div>' +
        (isText ? '' :
          '<div class="field"><span class="field-label">选项（留空的末尾选项会自动去掉）</span>' +
          opts.map(function (o, k) {
            return '<div class="adm-opt"><span class="ao-l">' + letter(k) + '</span>' +
              '<input data-f="opt" data-i="' + k + '" type="text" value="' + esc(o) + '"></div>';
          }).join('') + '</div>') +
        '<div class="field">' +
        (isText
          ? '<label for="f-answer">参考答案</label><textarea id="f-answer" data-f="answer" rows="6" placeholder="' +
          (d.qtype === 'blank' ? '填空的标准答案' : '按要点分条写，可用 **加粗** 标关键词') + '">' + esc(isText ? (d.answer || '') : '') + '</textarea>' +
          (d.qtype === 'blank'
            ? '<span class="f-help">填空题按文本比对判分（忽略空格、大小写和标点）。一个空有多个可接受答案时，用「 / 」或「 | 」分隔，例如 officially / formally；不带空格的斜杠会当成答案本身，分数 1/2 不受影响。</span>'
            : '')
          : d.qtype === 'multi'
            ? '<span class="field-label">正确答案（多选，至少两项）</span>' +
            opts.map(function (o, k) {
              var on = Array.isArray(d.answer) && d.answer.indexOf(k) > -1;
              return '<label class="adm-check"><input type="checkbox" data-f="ans" data-i="' + k + '"' + (on ? ' checked' : '') + '>' +
                '<span>' + letter(k) + '. ' + esc(o || '（空选项）') + '</span></label>';
            }).join('')
            : '<label for="f-answer">正确答案</label><select id="f-answer" data-f="answer">' +
            opts.map(function (o, k) {
              return '<option value="' + k + '"' + (d.answer === k ? ' selected' : '') + '>' + letter(k) + '. ' + esc(o || '（空选项）') + '</option>';
            }).join('') + '</select>') +
        '</div>' +
        '<div class="field"><label for="f-explain">解析</label>' +
        '<textarea id="f-explain" data-f="explain_text" rows="5" placeholder="为什么选这个、其他选项错在哪、关联考点。可用 **加粗**。">' + esc(d.explain_text || '') + '</textarea></div>' +
        '<div class="field"><label for="f-source">出处</label>' +
        '<input id="f-source" data-f="source" type="text" value="' + esc(d.source || '') + '" placeholder="选填，例如 2019 年真题 / 教材第 3 章"></div>';
    } else if (d.kind === 'chapter') {
      inner =
        '<div class="field"><label for="f-name">章节名称</label>' +
        '<input id="f-name" data-f="name" type="text" value="' + esc(d.name || '') + '"></div>' +
        '<div class="field"><label for="f-weight">分值权重（%）</label>' +
        '<input id="f-weight" data-f="weight" type="number" min="0" max="100" value="' + (d.weight || 0) + '">' +
        '<span class="f-help">估分占比，填 0 表示这一章是方法论、不直接计分。</span></div>' +
        '<div class="field"><label for="f-points">考点清单（每行一条）</label>' +
        '<textarea id="f-points" data-f="points" rows="12" placeholder="氨基酸：20 种标准氨基酸的分类、符号、等电点计算&#10;肽键与肽：平面性、命名、生物活性肽">' +
        esc((d.points || []).join('\n')) + '</textarea>' +
        '<span class="f-help">考点勾选进度按「行号」记录：在中间插入或删除某一行，会让这一行之后已勾选的考点错位。建议只在末尾追加。</span></div>';
    } else {
      inner =
        '<div class="field"><label for="f-chapter">章节</label>' +
        '<input id="f-chapter" data-f="chapter" type="text" value="' + esc(d.chapter || '') + '"></div>' +
        '<div class="field"><label for="f-front">正面（问题 / 术语）</label>' +
        '<textarea id="f-front" data-f="front" rows="2">' + esc(d.front || '') + '</textarea></div>' +
        '<div class="field"><label for="f-back">背面（答案要点）</label>' +
        '<textarea id="f-back" data-f="back" rows="8" placeholder="换行分条，可用 **加粗** 标关键词">' + esc(d.back || '') + '</textarea></div>';
    }

    return '<div class="card adm-editor" id="admEditor">' +
      '<div class="card-head"><h2>' + (isNew ? '新建' : '编辑') +
      (d.kind === 'question' ? '题目' : d.kind === 'chapter' ? '考纲章节' : '背诵卡') + '</h2>' +
      (d.exists && d.built_in ? '<span class="hint">这是内置内容，保存后会变成你改过的版本</span>' : '') + '</div>' +
      idField + subjectField + markupBar(d) + inner +
      '<div class="row wrap" style="gap:8px;margin-top:6px">' +
      '<button class="btn btn-primary" data-act="adm-save"' + (state.admin.busy ? ' disabled' : '') + '>' +
      (state.admin.busy ? '保存中…' : '保存到云端') + '</button>' +
      '<button class="btn btn-ghost" data-act="adm-cancel"' + (state.admin.busy ? ' disabled' : '') + '>取消</button>' +
      '</div></div>';
  }

  // 管理员直接看到工具条；「启用后台管理」那一步只有 Qoder 站点（gateway）才需要。
  function adminTools() {
    var a = state.admin;
    return '<div class="row wrap" style="gap:8px">' +
      '<button class="btn btn-sm btn-primary" data-act="adm-sync"' + (a.busy ? ' disabled' : '') + '>' +
      (a.busy ? '处理中…' : '把内置内容同步到云端') + '</button>' +
      '<button class="btn btn-sm" data-act="adm-export">导出全部内容 JSON</button>' +
      '<button class="btn btn-sm" data-act="adm-import"' + (a.busy ? ' disabled' : '') + '>导入 JSON</button>' +
      '<button class="btn btn-sm btn-ghost" data-act="adm-reload">重新读取云端</button>' +
      '<input type="file" id="admFile" accept="application/json,.json" hidden>' +
      '</div>' +
      '<p class="fey-note" style="margin-top:10px">同步只会补充云端还没有的编号，不会覆盖你后来改过的内容，可以重复执行。</p>';
  }

  function gatewayOwnerCard() {
    var o = state.owner;
    var a = state.admin;
    if (o.status === 'loading') {
      return '<p class="adm-state">正在确认管理权限…</p>';
    }
    if (o.status === 'error') {
      return '<p class="adm-state is-bad">' + esc(o.message || '无法确认管理权限') + '</p>' +
        '<button class="btn btn-sm" data-act="adm-reload">重试</button>';
    }
    if (o.status === 'anon') {
      return '<p class="adm-state">修改题库需要先登录 Qoder 账号。请用站点所有者的账号打开本站，再回到这一页。</p>' +
        '<button class="btn btn-sm" data-act="adm-reload">我已登录，重新检查</button>';
    }
    if (o.status === 'other') {
      return '<p class="adm-state is-warn">后台管理已由另一个账号启用，当前账号只能浏览内容，不能修改。若需要换账号管理，请先由原所有者在云端清除所有者记录。</p>' +
        '<button class="btn btn-sm" data-act="adm-reload">重新检查</button>';
    }
    if (o.status === 'unclaimed') {
      return '<p class="adm-state">还没有启用后台管理。启用后，<b>只有当前登录的这个 Qoder 账号</b>能修改题库，其他访客即使打开这一页也只能浏览。</p>' +
        '<div class="adm-warn"><b>启用前请确认</b><p>云端题库需要在数据库层开放匿名读写，靠本站点的「私有访问 + 服务端所有者校验」来兜住权限。' +
        '站点一旦改为公开或邀请其他访客，这个前提就不再成立，需要重新评估。</p></div>' +
        '<button class="btn btn-primary" data-act="adm-claim"' + (a.busy ? ' disabled' : '') + '>' +
        (a.busy ? '启用中…' : '启用后台管理') + '</button>';
    }
    return '<p class="adm-state is-ok">后台管理已启用，当前账号可以修改题库。</p>' + adminTools();
  }

  // 自建部署下没有管理权限的人走到 #/admin：只说清「这里需要管理员账号」，
  // 不暴露题库条数、同步状态这些管理信息。
  function viewAdminLocked() {
    var head = '<div class="page-head"><h1>内容管理</h1></div>';
    var body;
    if (state.account.status !== 'ready') {
      body = '<p class="adm-state">正在确认登录身份…</p>';
    } else if (!isLoggedIn()) {
      body = '<p class="adm-state">这一页只对管理员开放。请用管理员账号登录后再访问。</p>' +
        '<button class="btn btn-primary" data-act="nav" data-to="account">去登录</button>';
    } else {
      body = '<p class="adm-state is-warn">当前账号没有管理权限，看不到这一页的内容。</p>' +
        '<p class="fey-note">需要修改题库、考纲或背诵卡，请让站点管理员把你的账号提升为管理员。</p>' +
        '<button class="btn" data-act="nav" data-to="dashboard">返回总览</button>';
    }
    return head + '<div class="card">' + body + '</div>';
  }

  function viewAdmin() {
    var a = state.admin;
    var n = contentCounts();
    var gateway = state.account.mode === 'gateway';
    var canWrite = canWriteContent();

    var head = '<div class="page-head"><h1>内容管理</h1>' +
      '<p class="sub">题库、考纲章节和背诵卡都存在云端，改动会同步到你所有设备上的这个站点。</p></div>';

    var sourceLine;
    if (state.cloud.status === 'loading') sourceLine = '<span class="adm-dot is-load"></span>正在读取云端题库…';
    else if (state.cloud.status === 'ready') {
      sourceLine = '<span class="adm-dot is-ok"></span>已连接云端题库' + (state.cloud.truncated ? '（内容超过单次读取上限，只显示前 5000 条）' : '');
    } else if (state.cloud.status === 'empty') {
      sourceLine = '<span class="adm-dot is-warn"></span>云端题库还是空的，当前显示的是随站点打包的内置内容';
    } else {
      sourceLine = '<span class="adm-dot is-bad"></span>云端题库读取失败，当前显示的是内置内容 —— ' + esc(state.cloud.message || '');
    }

    var manageCard = gateway ? gatewayOwnerCard()
      : '<p class="adm-state is-ok">当前账号 <b>' + esc(state.account.user.name || state.account.user.username) +
        '</b> 是管理员，可以直接修改内容。</p>' + adminTools();

    var msg = a.msg
      ? '<div class="adm-msg is-' + a.msg.kind + '">' + esc(a.msg.text) + '</div>'
      : '';

    // 有管理权限却还没把内置内容传上去：这时新建内容会让内置题目从界面上消失，必须先提醒。
    if (canWrite && state.cloud.status === 'empty') {
      msg = '<div class="adm-msg is-err">云端题库还是空的。请先点上面的「把内置内容同步到云端」，再开始新建或导入内容。' +
        '云端一旦有了题目就会成为唯一数据源，空云端里只加几条，会让随站点打包的内置题目在界面上全部消失。</div>' + msg;
    }

    var tabs = '<div class="chip-row" style="margin-bottom:12px">' + ADM_TABS.map(function (t) {
      return '<button class="chip" data-act="adm-tab" data-v="' + t.id + '" aria-pressed="' + (a.tab === t.id) + '">' +
        t.name + '</button>';
    }).join('') + '</div>';

    var subjChips = [{ id: 'all', name: '全部' }].concat(SUBJ_ORDER.map(function (s) {
      return { id: s, name: SUBJ[s].code + ' ' + SUBJ[s].name };
    })).map(function (x) {
      return '<button class="chip chip-sm" data-act="adm-subject" data-v="' + x.id + '" aria-pressed="' + (a.subject === x.id) + '">' +
        esc(x.name) + '</button>';
    }).join('');

    var toolbar = '<div class="card-head"><h2>' +
      (a.tab === 'questions' ? '题目' : a.tab === 'chapters' ? '考纲章节' : '背诵卡') +
      '<span class="hint" id="admCount" style="margin-left:8px"></span></h2>' +
      '<button class="btn btn-sm btn-primary" data-act="adm-new" data-kind="' +
      (a.tab === 'questions' ? 'question' : a.tab === 'chapters' ? 'chapter' : 'card') + '"' +
      (canWrite ? '' : ' disabled') + '>新建</button></div>' +
      '<div class="row wrap" style="gap:8px;margin-bottom:12px">' +
      '<input class="adm-search" type="search" data-bind="admin-q" value="' + esc(a.q) + '" placeholder="搜索题干、章节、编号、标签…" aria-label="搜索内容">' +
      '</div>' +
      '<div class="chip-row" style="margin-bottom:12px">' + subjChips + '</div>';

    return head +
      '<div class="card" style="margin-bottom:16px">' +
      '<div class="adm-src">' + sourceLine + '</div>' +
      '<div class="fey-nums" style="margin-top:14px">' +
      '<div class="dn"><b>' + n.questions + '</b><span>题目</span></div>' +
      '<div class="dn"><b>' + n.chapters + '</b><span>考纲章节</span></div>' +
      '<div class="dn"><b>' + n.cards + '</b><span>背诵卡</span></div>' +
      '</div></div>' +
      '<div class="card" style="margin-bottom:16px"><div class="card-head"><h2>管理权限</h2></div>' +
      manageCard + '</div>' +
      msg +
      importErrorsCard() +
      (canWrite ? admEditor() : '') +
      '<div class="card">' + tabs + toolbar +
      (canWrite ? '' : '<p class="fey-note" style="margin-bottom:12px">' +
        (state.owner.status === 'other' ? '当前账号只能浏览，不能修改内容。' : '启用后台管理后可以新建、编辑和删除内容。') + '</p>') +
      '<div class="adm-list" id="adminList"></div>' +
      '</div>';
  }

  function admMsg(kind, text) {
    state.admin.msg = { kind: kind, text: text };
  }

  // 导入这类长任务只改消息文字，不整页重绘，避免闪烁。
  function admMsgLive(kind, text) {
    state.admin.msg = { kind: kind, text: text };
    var box = document.querySelector('.adm-msg');
    if (box) { box.className = 'adm-msg is-' + kind; box.textContent = text; }
    else render();
  }

  function admNewId(kind) {
    var stamp = Date.now().toString(36);
    return kind === 'question' ? 'my-q-' + stamp : kind === 'chapter' ? 'ch-my-' + stamp : 'my-card-' + stamp;
  }

  function admOpenEditor(kind, id) {
    var subj = state.admin.subject === 'all' ? 'bio' : state.admin.subject;
    var d;
    if (kind === 'question') {
      var q = id ? findQuestion(id) : null;
      d = {
        kind: 'question', exists: !!q, built_in: q ? !!q.built_in : false,
        id: q ? q.id : admNewId('question'),
        subject: q ? q.subject : subj,
        chapter: q ? q.chapter : '', qtype: q ? q.type : 'single', level: q ? q.level : 2,
        tags: q ? (q.tags || []).slice() : [], stem: q ? q.stem : '',
        opts: q ? (q.options || []).slice() : [],
        answer: q ? q.answer : 0,
        explain_text: q ? (q.explain || '') : '', source: q ? (q.source || '') : ''
      };
    } else if (kind === 'chapter') {
      var ch = null, chSubj = subj;
      SUBJ_ORDER.forEach(function (s) {
        var syl = window.SYLLABUS[s];
        ((syl && syl.chapters) || []).forEach(function (c) { if (id && c.id === id) { ch = c; chSubj = s; } });
      });
      d = {
        kind: 'chapter', exists: !!ch, built_in: ch ? !!ch.built_in : false,
        id: ch ? ch.id : admNewId('chapter'), subject: chSubj,
        name: ch ? ch.name : '', weight: ch ? ch.weight : 0, points: ch ? (ch.points || []).slice() : []
      };
    } else {
      var cd = null, cdSubj = subj;
      SUBJ_ORDER.forEach(function (s) {
        (window.CARDS[s] || []).forEach(function (c) { if (id && c.id === id) { cd = c; cdSubj = s; } });
      });
      d = {
        kind: 'card', exists: !!cd, built_in: cd ? !!cd.built_in : false,
        id: cd ? cd.id : admNewId('card'), subject: cdSubj,
        chapter: cd ? cd.chapter : '', front: cd ? cd.front : '', back: cd ? cd.back : ''
      };
    }
    if (id && !d.exists) { admMsg('err', '找不到编号为 ' + id + ' 的内容，可能已被删除。'); render(); return; }
    state.admin.editing = d;
    state.admin.msg = null;
    state.admin.imgBusy = false;
    render();
    var box = document.getElementById('admEditor');
    if (box) box.scrollIntoView({ block: 'start' });
    // 预览面板在换内容时保持开着，但里面的字得换成新这条的。
    amRefreshPreview();
  }

  function admReadForm() {
    var d = state.admin.editing;
    var box = document.getElementById('admEditor');
    if (!d || !box) return null;
    function val(f) { var el = box.querySelector('[data-f="' + f + '"]'); return el ? el.value : null; }
    var next = {};
    for (var k in d) { if (Object.prototype.hasOwnProperty.call(d, k)) next[k] = d[k]; }
    var idEl = box.querySelector('[data-f="id"]');
    next.id = (idEl && !idEl.disabled ? idEl.value : d.id).trim();
    next.subject = val('subject') || d.subject;

    if (d.kind === 'question') {
      next.chapter = (val('chapter') || '').trim();
      next.qtype = val('qtype') || d.qtype;
      next.level = parseInt(val('level'), 10) || 2;
      next.tags = (val('tags') || '').split(/[,，、]/).map(function (t) { return t.trim(); })
        .filter(function (t) { return t; }).slice(0, 8);
      next.stem = val('stem') || '';
      var optEls = box.querySelectorAll('[data-f="opt"]');
      if (optEls.length) {
        var opts = [];
        for (var i = 0; i < optEls.length; i++) opts.push(optEls[i].value.trim());
        while (opts.length && !opts[opts.length - 1]) opts.pop();
        next.opts = opts;
      }
      if (next.qtype === 'multi') {
        var boxes = box.querySelectorAll('[data-f="ans"]');
        var picks = [];
        for (var j = 0; j < boxes.length; j++) {
          if (boxes[j].checked) picks.push(parseInt(boxes[j].getAttribute('data-i'), 10));
        }
        next.answer = picks;
      } else if (next.qtype === 'blank' || next.qtype === 'short') {
        next.answer = val('answer') || '';
      } else {
        next.answer = parseInt(val('answer'), 10) || 0;
      }
      next.explain_text = val('explain_text') || '';
      next.source = (val('source') || '').trim();
    } else if (d.kind === 'chapter') {
      next.name = (val('name') || '').trim();
      var w = parseInt(val('weight'), 10);
      next.weight = isFinite(w) ? w : 0;
      next.points = (val('points') || '').split('\n').map(function (p) { return p.trim(); })
        .filter(function (p) { return p; });
    } else {
      next.chapter = (val('chapter') || '').trim();
      next.front = val('front') || '';
      next.back = val('back') || '';
    }
    return next;
  }

  function admValidate(d) {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(d.id || '')) {
      return '编号只能用小写字母、数字和短横线，2~64 位，且以字母或数字开头。';
    }
    if (d.kind === 'question') {
      if (!String(d.chapter || '').trim()) return '章节不能为空。';
      if (!String(d.stem || '').trim()) return '题干不能为空。';
      if (d.qtype === 'blank' || d.qtype === 'short') {
        if (!String(d.answer || '').trim()) return '参考答案不能为空。';
        if (d.qtype === 'blank' && new TextEncoder().encode(String(d.answer)).length > 600) return '填空题答案请控制在 600 字节以内。';
        return null;
      }
      var need = d.qtype === 'multi' ? 3 : 2;
      if (d.opts.length < need) return '这个题型至少要有 ' + need + ' 个非空选项。';
      for (var i = 0; i < d.opts.length; i++) {
        if (!d.opts[i]) return '选项中间不能留空，请把内容往前挪。';
      }
      if (d.qtype === 'multi' && (!d.answer || d.answer.length < 2)) return '多选题至少要选两个正确答案。';
      if (d.answer >= d.opts.length) return '正确答案超出了选项范围。';
      return null;
    }
    if (d.kind === 'chapter') {
      if (!d.name) return '章节名称不能为空。';
      if (d.weight < 0 || d.weight > 100) return '分值权重要在 0~100 之间。';
      return null;
    }
    if (!String(d.chapter || '').trim()) return '章节不能为空。';
    if (!String(d.front || '').trim()) return '卡片正面不能为空。';
    if (!String(d.back || '').trim()) return '卡片背面不能为空。';
    return null;
  }

  function admPayload(d) {
    if (d.kind === 'question') {
      var text = d.qtype === 'blank' || d.qtype === 'short';
      var p = {
        id: d.id, subject: d.subject, chapter: d.chapter, qtype: d.qtype, level: d.level,
        tags: d.tags, stem: d.stem, opts: text ? [] : d.opts,
        answer: d.answer, explain_text: d.explain_text
      };
      if (d.source) p.source = d.source;
      return p;
    }
    if (d.kind === 'chapter') {
      return { id: d.id, subject: d.subject, name: d.name, weight: d.weight, points: d.points };
    }
    return { id: d.id, subject: d.subject, chapter: d.chapter, front: d.front, back: d.back };
  }

  var ADM_KIND_NAME = { question: '题目', chapter: '考纲章节', card: '背诵卡' };
  var ADM_TABLE_NAME = { questions: '题目', syllabus_chapters: '考纲章节', cards: '背诵卡' };

  function admApi(kind, op) {
    if (kind === 'question') return op === 'del' ? window.Cloud.deleteQuestion : window.Cloud.upsertQuestion;
    if (kind === 'chapter') return op === 'del' ? window.Cloud.deleteChapter : window.Cloud.upsertChapter;
    return op === 'del' ? window.Cloud.deleteCard : window.Cloud.upsertCard;
  }

  var UNKNOWN_WRITE_HINT = '网络中断，这次改动可能已生效也可能没有。请先点「重新读取云端」核对当前内容，不要直接重复提交同一条。';

  function admSave() {
    var d = admReadForm();
    if (!d) return;
    state.admin.editing = d;
    var problem = admValidate(d);
    if (problem) { admMsg('err', problem); render(); return; }
    state.admin.busy = true;
    admMsg('info', '正在保存…');
    render();
    admApi(d.kind, 'up')(admPayload(d)).then(function (res) {
      state.admin.busy = false;
      state.admin.editing = null;
      admMsg('ok', (res && res.created ? '已新建' : '已更新') + '这条' + ADM_KIND_NAME[d.kind] + '，云端题库已同步。');
      return reloadCloud();
    }).catch(function (e) {
      state.admin.busy = false;
      admMsg('err', window.Cloud.isWriteOutcomeUnknown(e) ? UNKNOWN_WRITE_HINT
        : (e && e.message ? e.message : '保存失败，请稍后重试'));
      render();
    });
  }

  function admDelete(kind, id) {
    openModal('删除这条' + ADM_KIND_NAME[kind] + '？',
      '编号 ' + id + ' 会从云端题库删除，你所有设备上的这个站点都会同步。相关的做题与复习记录也会一并清除，操作不可撤销。',
      '', '确认删除', function () {
        state.admin.busy = true;
        admMsg('info', '正在删除…');
        render();
        admApi(kind, 'del')(id).then(function () {
          if (kind === 'question') forgetQuestion(id);
          if (kind === 'card') {
            delete state.cards[id];
            Store.set('cards', state.cards);
            delete state.feynman['card:' + id];
            Store.set('feynman', state.feynman);
          }
          state.admin.busy = false;
          admMsg('ok', '已删除 ' + id + '。');
          return reloadCloud();
        }).catch(function (e) {
          state.admin.busy = false;
          admMsg('err', window.Cloud.isWriteOutcomeUnknown(e) ? UNKNOWN_WRITE_HINT
            : (e && e.message ? e.message : '删除失败，请稍后重试'));
          render();
        });
      });
  }

  function admClaim() {
    state.admin.busy = true;
    admMsg('info', '正在启用后台管理…');
    render();
    window.Cloud.claimOwner().then(function () {
      // 紧接着把内置内容传上去：云端一旦有了题目就会成为唯一数据源，
      // 空云端里只加一条新题，会让打包的内置题目在界面上全部消失。
      admMsg('info', '已启用，正在把内置内容上传到云端…');
      render();
      return window.Cloud.syncBuiltin();
    }).then(function (res) {
      state.admin.busy = false;
      var parts = (res.results || []).map(function (x) {
        return (ADM_TABLE_NAME[x.table] || x.table) + ' ' + x.inserted + ' 条';
      });
      admMsg(res.incomplete ? 'err' : 'ok',
        '后台管理已启用，内置内容已上传到云端（' + parts.join('、') + '）。从现在起只有当前登录的这个账号能修改题库。');
      return Promise.all([loadCloud(), loadOwner()]);
    }).catch(function (e) {
      state.admin.busy = false;
      admMsg('err', (e && e.message ? e.message : '启用失败') +
        ' 请先点「把内置内容同步到云端」补上，再开始新建内容；否则云端只有零星几条时，内置题目会在界面上消失。');
      return Promise.all([loadCloud(), loadOwner()]);
    }).then(function () { render(); });
  }

  function admSync() {
    state.admin.busy = true;
    admMsg('info', '正在把内置内容同步到云端…');
    render();
    window.Cloud.syncBuiltin().then(function (res) {
      state.admin.busy = false;
      var parts = (res.results || []).map(function (x) {
        return (ADM_TABLE_NAME[x.table] || x.table) + '新增 ' + x.inserted +
          '、已存在跳过 ' + x.skipped + (x.failed ? '、失败 ' + x.failed : '');
      });
      admMsg(res.incomplete ? 'err' : 'ok', '同步完成 —— ' + parts.join('；') + '。');
      return reloadCloud();
    }).catch(function (e) {
      state.admin.busy = false;
      admMsg('err', window.Cloud.isWriteOutcomeUnknown(e) ? UNKNOWN_WRITE_HINT
        : (e && e.message ? e.message : '同步失败，请稍后重试'));
      render();
    });
  }

  function admReload() {
    state.admin.busy = true;
    admMsg('info', '正在重新读取云端…');
    render();
    // accounts 模式下能打开这一页就说明权限已经确认过，不必再拉一次身份，
    // 也避免顺手触发一次进度回灌把本地改动盖掉。
    var identity = state.account.mode === 'gateway' ? loadOwner() : Promise.resolve();
    Promise.all([loadCloud(), identity]).then(function () {
      state.admin.busy = false;
      var n = contentCounts();
      var summary = '题目 ' + n.questions + '、章节 ' + n.chapters + '、背诵卡 ' + n.cards + '。';
      if (state.cloud.status === 'ready') admMsg('ok', '已重新读取云端题库：' + summary);
      else if (state.cloud.status === 'empty') admMsg('ok', '云端题库是空的，已改用内置内容：' + summary);
      else admMsg('err', '云端题库读取失败，仍显示内置内容：' + summary +
        (state.cloud.message ? '（' + state.cloud.message + '）' : ''));
      render();
    });
  }

  function admExport() {
    var out = {
      format: 'cpu-biomed-bank/1',
      exportedAt: new Date().toISOString(),
      origin: state.source,
      questions: [], chapters: [], cards: []
    };
    SUBJ_ORDER.forEach(function (s) {
      (window.QB[s] || []).forEach(function (q) {
        out.questions.push({
          id: q.id, subject: s, chapter: q.chapter, qtype: q.type, level: q.level,
          tags: q.tags || [], stem: q.stem, opts: q.options || [], answer: q.answer,
          explain_text: q.explain || '', source: q.source || null
        });
      });
      var syl = window.SYLLABUS[s];
      ((syl && syl.chapters) || []).forEach(function (c) {
        out.chapters.push({ id: c.id, subject: s, name: c.name, weight: c.weight, points: c.points || [] });
      });
      (window.CARDS[s] || []).forEach(function (c) {
        out.cards.push({ id: c.id, subject: s, chapter: c.chapter, front: c.front, back: c.back });
      });
    });
    var blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = '药大生医题库-' + today() + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    admMsg('ok', '已导出题目 ' + out.questions.length + '、章节 ' + out.chapters.length + '、背诵卡 ' + out.cards.length + '。');
    render();
  }

  function admImport(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onerror = function () { admMsg('err', '文件读取失败，请重试。'); render(); };
    reader.onload = function () {
      var data;
      try { data = JSON.parse(String(reader.result)); } catch (e) {
        admMsg('err', 'JSON 解析失败：' + e.message); render(); return;
      }
      var batch = [];
      ['questions', 'chapters', 'cards'].forEach(function (k) {
        var list = data && data[k];
        if (!Array.isArray(list) || !list.length) return;
        var kind = k === 'questions' ? 'question' : k === 'chapters' ? 'chapter' : 'card';
        list.forEach(function (row) { batch.push({ kind: kind, row: row }); });
      });
      if (!batch.length) {
        admMsg('err', '文件里没有 questions / chapters / cards 数组，或数组为空。');
        render();
        return;
      }
      admRunImport(batch);
    };
    reader.readAsText(file);
  }

  var ADM_KIND_LABEL = { question: '题目', chapter: '章节', card: '背诵卡' };

  // 分批并发提交，逐批报进度。失败只累计不中断，最后如实汇总。
  // 但「失败 33 条」这种数字对改数据毫无帮助，所以每条失败的编号、字段和原因都记下来。
  function admRunImport(batch) {
    state.admin.busy = true;
    state.admin.importErrors = null;
    var done = 0, unknown = 0, fails = [];
    function finish() {
      state.admin.busy = false;
      state.admin.importErrors = fails.length ? fails : null;
      admMsg(fails.length ? 'err' : 'ok', '导入结束：成功 ' + done + ' 条，失败 ' + fails.length + ' 条。' +
        (fails.length ? '失败清单列在下面，改完那几条再导一次同一个文件即可。' : '') +
        (unknown ? '其中 ' + unknown + ' 条结果未知（网络中断），请先「重新读取云端」核对，再决定是否重跑失败的部分。' : ''));
      reloadCloud();
    }
    function step(i) {
      if (i >= batch.length) { finish(); return; }
      var group = batch.slice(i, i + ADM_BATCH);
      admMsgLive('info', '正在导入 ' + Math.min(i + ADM_BATCH, batch.length) + ' / ' + batch.length +
        '（已成功 ' + done + '，失败 ' + fails.length + '）');
      Promise.all(group.map(function (x, k) {
        return admApi(x.kind, 'up')(x.row).then(function () { done++; }, function (e) {
          if (window.Cloud.isWriteOutcomeUnknown(e)) unknown++;
          fails.push({
            no: i + k + 1,
            kind: ADM_KIND_LABEL[x.kind] || x.kind,
            id: (x.row && x.row.id) || '（这一条没有编号）',
            field: (e && e.field) || '',
            text: (e && e.message) || '未知原因'
          });
        });
      })).then(function () { step(i + ADM_BATCH); }, function () { step(i + ADM_BATCH); });
    }
    step(0);
  }

  var ADM_FAIL_SHOWN = 40;
  function importErrorsCard() {
    var list = state.admin.importErrors;
    if (!list || !list.length) return '';
    var shown = list.slice(0, ADM_FAIL_SHOWN);
    return '<div class="card adm-import-errors">' +
      '<div class="card-head"><h2>导入失败清单</h2><span class="hint">' + list.length + ' 条没写进云端</span></div>' +
      '<p class="fey-note" style="margin-bottom:10px">改完这些条目再导一次同一个文件就行：已经成功的编号会按新内容更新，不会产生重复。' +
      '想在导入前一次性找出所有问题，用离线体检脚本 <code>node deploy/tools/check-bank.mjs 你的文件.json</code>，' +
      '它会逐条列出编号、字段和原因，还能查公式和图片的写法。</p>' +
      '<ul class="ie-list">' + shown.map(function (f) {
        return '<li><span class="ie-no">第 ' + f.no + ' 条</span>' +
          '<b>' + esc(f.kind) + ' · ' + esc(f.id) + '</b>' +
          (f.field ? '<code>' + esc(f.field) + '</code>' : '') +
          '<span class="ie-why">' + esc(f.text) + '</span></li>';
      }).join('') + '</ul>' +
      (list.length > shown.length
        ? '<p class="fey-note">只列出前 ' + ADM_FAIL_SHOWN + ' 条，还有 ' + (list.length - shown.length) +
          ' 条没显示。这种情况建议改用上面的离线脚本，一次看全。</p>'
        : '') +
      '<button class="btn btn-sm btn-ghost" data-act="adm-import-clear" style="margin-top:10px">收起清单</button>' +
      '</div>';
  }

  /* ---------------- 视图：账号 ----------------
     登录不是进站门槛，而是「想把进度带到别的设备上」时才需要的一步。 */
  function viewAccount() {
    var head = '<div class="page-head"><h1>账号</h1>' +
      '<p class="sub">浏览内容和做题都不需要登录。登录只为一件事：把学习进度备一份到服务器，换设备时能找回来。</p></div>';
    if (state.account.mode === 'gateway') return head + gatewayAccountCard();
    if (state.account.status !== 'ready') {
      return head + '<div class="card acc-card"><p class="adm-state">正在确认登录状态…</p></div>';
    }
    return head + (isLoggedIn() ? accountCard() : authCard());
  }

  function gatewayAccountCard() {
    var o = state.owner;
    var text = o.status === 'owner' ? '当前 Qoder 账号是本站点所有者，可以修改题库内容。'
      : o.status === 'unclaimed' ? '当前 Qoder 账号还没有启用后台管理，去「内容管理」里可以启用。'
        : o.status === 'other' ? '后台管理已由另一个 Qoder 账号启用，当前账号只能浏览内容。'
          : o.status === 'anon' ? '还没有登录 Qoder 账号。'
            : o.status === 'error' ? (o.message || '无法读取管理权限') : '正在确认登录状态…';
    return '<div class="card acc-card">' +
      '<p class="adm-state">' + esc(text) + '</p>' +
      '<p class="fey-note">这个站点托管在 Qoder Sites 上，身份由平台统一提供，没有本站自己的登录页；' +
      '学习进度只保存在这台设备的浏览器里，不会同步到别处。</p>' +
      '</div>';
  }

  function authCard() {
    var a = state.account;
    var reg = a.form === 'register';
    var label = reg ? '注册并登录' : '登录';
    var msg = a.msg
      ? '<div class="acc-msg is-' + a.msg.kind + '" id="accMsg">' + esc(a.msg.text) + '</div>'
      : '<div class="acc-msg" id="accMsg" hidden></div>';
    return '<div class="card acc-card">' +
      '<div class="chip-row" style="margin-bottom:14px">' +
      '<button class="chip" data-act="acc-tab" data-v="login" aria-pressed="' + !reg + '">登录</button>' +
      '<button class="chip" data-act="acc-tab" data-v="register" aria-pressed="' + reg + '">注册新账号</button>' +
      '</div>' + msg +
      '<form id="accForm">' +
      '<label class="acc-field"><span>用户名</span>' +
      '<input type="text" name="username" autocomplete="username" required minlength="3" maxlength="32" ' +
      'pattern="[A-Za-z0-9_.\\-]{3,32}" placeholder="3–32 位字母、数字或 . _ -" ' +
      'title="3–32 位字母、数字、点、下划线或短横线">' +
      '<small>不区分大小写，存进数据库时会统一转成小写。</small></label>' +
      (reg ? '<label class="acc-field"><span>昵称（可选）</span>' +
        '<input type="text" name="displayName" maxlength="40" autocomplete="nickname" placeholder="留空就用用户名"></label>' : '') +
      '<label class="acc-field"><span>口令</span>' +
      '<input type="password" name="password" minlength="8" maxlength="128" required ' +
      'autocomplete="' + (reg ? 'new-password' : 'current-password') + '" placeholder="至少 8 位"></label>' +
      (reg ? '<label class="acc-field"><span>再输一次口令</span>' +
        '<input type="password" name="password2" minlength="8" maxlength="128" required ' +
        'autocomplete="new-password" placeholder="和上面保持一致"></label>' : '') +
      '<button class="btn btn-primary btn-block" type="submit" id="accSubmit" data-label="' + label + '"' +
      (a.busy ? ' disabled' : '') + '>' + (a.busy ? '处理中…' : label) + '</button>' +
      '</form>' +
      '<p class="fey-note" style="margin-top:12px">' +
      (reg ? '注册是开放的，任何人都能建账号；只有管理员账号能看到「内容管理」并修改题库。'
        : '还没有账号就切到「注册新账号」，注册完直接就是登录状态。') + '</p>' +
      '</div>';
  }

  function accountCard() {
    var u = state.account.user;
    var admin = isAdmin();
    return '<div class="card acc-card">' +
      '<div class="acc-id">' +
      '<span class="acc-avatar acc-avatar-lg" aria-hidden="true">' + esc(String(u.name || u.username).slice(0, 1)) + '</span>' +
      '<div class="acc-idtext"><b>' + esc(u.name || u.username) + '</b>' +
      '<p class="acc-sub">用户名 ' + esc(u.username) + ' · ' + (admin ? '管理员' : '学习者') + '</p></div>' +
      '</div>' +
      '<div class="acc-sync"><span class="adm-dot ' + (sync.status === 'error' ? 'is-bad' : 'is-ok') + '"></span>' +
      '<span id="accSync">' + esc(syncText()) + '</span></div>' +
      '<p class="fey-note">进度以这台设备上的浏览器存储为准，登录后每次改动会在几秒内备一份到服务器。' +
      '换设备登录时，服务器那份比本地新就用服务器的覆盖本地。</p>' +
      '<div class="row wrap" style="gap:8px;margin-top:14px">' +
      '<button class="btn btn-sm" data-act="acc-sync-now">立即同步</button>' +
      '<button class="btn btn-sm" data-act="acc-pull">从服务器恢复</button>' +
      '<div style="flex:1"></div>' +
      '<button class="btn btn-sm btn-ghost" data-act="acc-logout"' + (state.account.busy ? ' disabled' : '') + '>退出登录</button>' +
      '</div>' +
      (admin ? '<p class="fey-note" style="margin-top:12px">你是管理员，导航里有「内容管理」，可以改题库、考纲和背诵卡。</p>' : '') +
      '</div>';
  }

  function accSetMsg(kind, text) {
    state.account.msg = kind ? { kind: kind, text: text } : null;
    var box = document.getElementById('accMsg');
    // 报错时只改那一行，不整页重绘，免得把用户刚填的内容冲掉。
    if (!box) { render(); return; }
    box.className = 'acc-msg' + (kind ? ' is-' + kind : '');
    box.textContent = text || '';
    box.hidden = !kind;
  }

  function accBusy(on) {
    state.account.busy = on;
    var btn = document.getElementById('accSubmit');
    if (!btn) return;
    btn.disabled = on;
    btn.textContent = on ? '处理中…' : btn.getAttribute('data-label');
  }

  function accSubmit() {
    if (state.account.busy) return;
    var form = document.getElementById('accForm');
    if (!form) return;
    var reg = state.account.form === 'register';
    var f = form.elements;
    var username = String(f.username.value || '').trim();
    var password = String(f.password.value || '');
    if (reg && password !== String(f.password2.value || '')) {
      accSetMsg('err', '两次输入的口令不一致。');
      return;
    }
    accSetMsg(null);
    accBusy(true);
    var req = reg
      ? window.Cloud.register(username, password, String(f.displayName.value || '').trim())
      : window.Cloud.login(username, password);
    req.then(function (res) {
      state.account.user = (res && res.user) || null;
      accBusy(false);
      sync.status = 'idle'; sync.at = null; sync.message = null;
      toast(reg ? '账号已创建，进度会开始同步' : '已登录');
      render();
      return pullProgress();
    }, function (e) {
      accBusy(false);
      accSetMsg('err', e && e.message ? e.message : '操作失败，请稍后重试');
    });
  }

  function accLogout() {
    if (state.account.busy) return;
    flushSyncNow();                          // 退出前把最后一份快照丢出去
    state.account.busy = true;
    window.Cloud.logout().then(function () {
      state.account.user = null;
      state.account.busy = false;
      sync.status = 'idle'; sync.at = null; sync.dirty = false; sync.message = null;
      clearTimeout(sync.timer);
      toast('已退出登录，进度仍留在这台设备上');
      // 退出后「内容管理」就不该再停着了。
      if (state.route === 'admin') navigate('dashboard'); else render();
    }, function (e) {
      state.account.busy = false;
      accSetMsg('err', e && e.message ? e.message : '退出失败，请刷新页面重试');
    });
  }

  function accPull() {
    openModal('用服务器上的进度覆盖本机？',
      '本机的做题记录、错题本、背诵卡进度和复习计划都会被服务器那份替换，此操作不可撤销。',
      '', '覆盖本机', function () {
        window.Cloud.loadProgress().then(function (res) {
          if (!res || !res.data) { toast('服务器上还没有这个账号的进度'); return; }
          applyProgress(res.data);
          Store.setQuiet('savedAt', Number(res.data.savedAt) || 0);
          sync.at = res.updated_at || null;
          sync.status = 'saved';
          render();
          toast('已恢复服务器上的进度');
        }, function (e) {
          toast(e && e.message ? e.message : '读取失败，请稍后重试');
        });
      });
  }

  /* ---------------- 路由 ---------------- */
  function routeFromHash() {
    var h = (location.hash || '').replace(/^#\/?/, '');
    var name = h.split('/')[0] || 'dashboard';
    return ROUTES.some(function (r) { return r.id === name; }) ? name : 'dashboard';
  }

  var viewEl, showingResult = false;

  function render() {
    var html;
    if (showingResult && state.session) html = viewResult();
    else {
      switch (state.route) {
        case 'practice': html = viewPractice(); break;
        case 'mistakes': html = viewMistakes(); break;
        case 'cards': html = viewCards(); break;
        case 'feynman': html = viewFeynman(); break;
        case 'syllabus': html = viewSyllabus(); break;
        case 'plan': html = viewPlan(); break;
        case 'account': html = viewAccount(); break;
        // 手输 #/admin 进来的非管理员看锁定页，而不是被弹回总览：
        // 身份还在确认时弹跳会让真正的管理员也闪一下。
        case 'admin': html = canSeeAdmin() ? viewAdmin() : viewAdminLocked(); break;
        default: html = viewDashboard();
      }
    }
    viewEl.innerHTML = html;
    renderNav();
    renderCountdown();
    if (state.route === 'admin') renderAdminList();
    paintMath(viewEl);
  }

  function navigate(r) {
    showingResult = false;
    state.deck = null;
    if (location.hash !== '#/' + r) location.hash = '#/' + r;
    else render();
    closeNav();
  }

  /* ---------------- 交互 ---------------- */
  function toast(msg) {
    var old = document.querySelector('.toast');
    if (old) old.remove();
    var t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () {
      t.classList.add('out');
      setTimeout(function () { if (t.parentNode) t.remove(); }, 220);
    }, 1900);
  }

  function openModal(title, desc, bodyHtml, okLabel, onOk) {
    var back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
      '<h3>' + esc(title) + '</h3>' +
      (desc ? '<p class="m-desc">' + esc(desc) + '</p>' : '') +
      (bodyHtml || '') +
      '<div class="modal-actions"><button class="btn btn-ghost" data-m="cancel">取消</button>' +
      '<button class="btn btn-primary" data-m="ok">' + esc(okLabel || '确定') + '</button></div></div>';
    document.body.appendChild(back);
    var input = back.querySelector('input');
    if (input) { input.focus(); }
    function close() { back.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter') { e.preventDefault(); onOk(input ? input.value : null); close(); }
    }
    back.addEventListener('click', function (e) {
      var m = e.target.getAttribute && e.target.getAttribute('data-m');
      if (m === 'cancel' || e.target === back) close();
      if (m === 'ok') { onOk(input ? input.value : null); close(); }
    });
    document.addEventListener('keydown', onKey);
  }

  function recordAnswer(qid, ok) {
    var st = state.stats[qid] || { right: 0, wrong: 0 };
    if (ok) st.right++; else st.wrong++;
    st.last = Date.now();
    state.stats[qid] = st;
    Store.set('stats', state.stats);

    if (ok) {
      // 答对即从错题本移除（重做答对视为已消灭）
      if (state.mistakes[qid]) { delete state.mistakes[qid]; Store.set('mistakes', state.mistakes); }
    } else {
      var m = state.mistakes[qid] || { n: 0 };
      m.n = (m.n || 0) + 1;
      m.last = Date.now();
      state.mistakes[qid] = m;
      Store.set('mistakes', state.mistakes);
    }
    markActivity();
  }

  function onClick(e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    var act = el.getAttribute('data-act');
    var ss = state.session;

    switch (act) {
      case 'nav': navigate(el.getAttribute('data-to')); break;

      case 'edit-exam':
        openModal('修改初试日期', '用于计算倒计时。默认按考研初试惯例填写，请按研招网当年公布的具体日期修改。',
          '<input type="date" value="' + esc(examDate()) + '" aria-label="考试日期">', '保存',
          function (v) {
            if (v) { state.examDate = v; Store.set('examDate', v); render(); toast('考试日期已更新为 ' + v); }
          });
        break;

      case 'quick-practice':
        state.setup.subject = el.getAttribute('data-s');
        state.setup.chapters = []; state.setup.types = []; state.setup.onlyWrong = false;
        state.setup.count = 10;
        navigate('practice');
        break;
      case 'quick-cards':
      case 'kp-cards':
        startDeck(el.getAttribute('data-s'), true);
        navigate('cards');
        break;
      case 'quick-syllabus':
      case 'syl-subject':
        state.sylSubject = subjKey(el.getAttribute('data-s'));
        if (state.route !== 'syllabus') navigate('syllabus'); else render();
        break;
      case 'kp-practice':
        state.setup.subject = el.getAttribute('data-s');
        state.setup.chapters = []; state.setup.types = []; state.setup.onlyWrong = false;
        navigate('practice');
        break;

      /* ---- 刷题设置 ---- */
      case 'setup-subject':
        state.setup.subject = el.getAttribute('data-s');
        state.setup.chapters = []; state.setup.types = [];
        render();
        break;
      case 'setup-chapter': {
        var c = el.getAttribute('data-c');
        var i = state.setup.chapters.indexOf(c);
        if (i > -1) state.setup.chapters.splice(i, 1); else state.setup.chapters.push(c);
        render();
        break;
      }
      case 'setup-type': {
        var t = el.getAttribute('data-t');
        var j = state.setup.types.indexOf(t);
        if (j > -1) state.setup.types.splice(j, 1); else state.setup.types.push(t);
        render();
        break;
      }
      case 'setup-wrong':
        state.setup.onlyWrong = !state.setup.onlyWrong;
        render();
        break;
      case 'start-quiz': {
        var pool = buildPool();
        if (!pool.length) { toast('没有符合筛选条件的题目'); break; }
        var n = state.setup.count === 0 ? pool.length : Math.min(state.setup.count, pool.length);
        var ids = shuffle(pool).slice(0, n).map(function (q) { return q.id; });
        startSession(ids, { subject: state.setup.subject });
        showingResult = false;
        render();
        window.scrollTo(0, 0);
        break;
      }

      /* ---- 答题 ---- */
      case 'pick': {
        if (!ss || ss.results[ss.idx] !== null) break;
        var q = findQuestion(ss.ids[ss.idx]);
        var idx = parseInt(el.getAttribute('data-i'), 10);
        if (q.type === 'multi') {
          var p = (ss.picks[ss.idx] || []).slice();
          var k = p.indexOf(idx);
          if (k > -1) p.splice(k, 1); else p.push(idx);
          ss.picks[ss.idx] = p;
        } else ss.picks[ss.idx] = idx;
        Store.set('session', ss);
        render();
        break;
      }
      case 'submit': {
        if (!ss || ss.results[ss.idx] !== null) break;
        var q2 = findQuestion(ss.ids[ss.idx]);
        if (q2.type === 'blank') {
          var inp = viewEl.querySelector('[data-bind="blank"]');
          var v = inp ? inp.value : (ss.picks[ss.idx] || '');
          if (!String(v).trim()) break;
          ss.picks[ss.idx] = v;
          var okB = blankAccepted(q2.answer).indexOf(norm(v)) > -1;
          ss.results[ss.idx] = okB;
          recordAnswer(q2.id, okB);
          Store.set('session', ss);
          render();
          break;
        }
        var pick = ss.picks[ss.idx];
        if (pick === null || (q2.type === 'multi' && !pick.length)) break;
        var ok;
        if (q2.type === 'multi') {
          var a = q2.answer.slice().sort().join(',');
          var b = pick.slice().sort().join(',');
          ok = a === b;
        } else ok = pick === q2.answer;
        ss.results[ss.idx] = ok;
        recordAnswer(q2.id, ok);
        Store.set('session', ss);
        render();
        break;
      }
      case 'short-check': {
        if (!ss) break;
        var ta = viewEl.querySelector('[data-bind="short"]');
        ss.picks[ss.idx] = ta ? ta.value : '';
        ss.results[ss.idx] = 'pending';
        Store.set('session', ss);
        render();
        break;
      }
      case 'self-rate': {
        if (!ss) break;
        var q4 = findQuestion(ss.ids[ss.idx]);
        var ok2 = el.getAttribute('data-r') === 'know';
        ss.results[ss.idx] = ok2;
        recordAnswer(q4.id, ok2);
        Store.set('session', ss);
        render();
        break;
      }
      case 'next':
        if (ss && ss.idx < ss.ids.length - 1) { ss.idx++; Store.set('session', ss); render(); }
        break;
      case 'prev':
        if (ss && ss.idx > 0) { ss.idx--; Store.set('session', ss); render(); }
        break;
      case 'finish':
        if (ss) { ss.finished = true; Store.set('session', ss); }
        showingResult = true; render(); window.scrollTo(0, 0); break;
      case 'quit':
        openModal('结束本次训练？', '已作答的题目成绩会保留，未作答的题目不计入统计。', '', '结束', function () {
          state.session = null; Store.set('session', null);
          showingResult = false;
          render();
        });
        break;
      case 'again':
        startSession(ss ? shuffle(ss.ids) : [], ss ? ss.meta : {});
        showingResult = false; render(); window.scrollTo(0, 0);
        break;
      case 'review-wrong': {
        var wrongIds = ss.ids.filter(function (id, i) { return ss.results[i] === false; });
        startSession(wrongIds, {});
        showingResult = false; render(); window.scrollTo(0, 0);
        break;
      }
      case 'go-mistakes': navigate('mistakes'); break;
      case 'go-home': state.session = null; Store.set('session', null); showingResult = false; navigate('dashboard'); break;

      /* ---- 错题本 ---- */
      case 'mistake-drill':
      case 'drill-one': {
        var s2 = el.getAttribute('data-s');
        var one = el.getAttribute('data-q');
        var ids2;
        if (one) ids2 = [one];
        else ids2 = Object.keys(state.mistakes).filter(function (id) { return !s2 || subjectOfQ(id) === s2; });
        if (!ids2.length) { toast('没有对应的错题'); break; }
        startSession(shuffle(ids2), { drill: true });
        showingResult = false;
        navigate('practice');
        break;
      }
      case 'mistake-drill-all': {
        var all = Object.keys(state.mistakes);
        startSession(shuffle(all), { drill: true });
        showingResult = false; navigate('practice');
        break;
      }
      case 'mistake-remove':
        delete state.mistakes[el.getAttribute('data-q')];
        Store.set('mistakes', state.mistakes);
        render(); toast('已标记为掌握');
        break;
      case 'mistake-clear':
        openModal('清空错题本？', '所有错题记录都会被删除，答题统计数据保留。此操作不可撤销。', '', '清空', function () {
          state.mistakes = {}; Store.set('mistakes', {}); render(); toast('错题本已清空');
        });
        break;

      /* ---- 背诵卡 ---- */
      case 'deck-due': startDeck(el.getAttribute('data-s'), true); render(); break;
      case 'deck-all': startDeck(el.getAttribute('data-s'), false); render(); break;
      case 'flip':
        if (state.deck) { state.deck.flipped = !state.deck.flipped; render(); }
        break;
      case 'rate': {
        var d = state.deck;
        if (!d) break;
        var cid = d.queue[d.idx];
        var st = state.cards[cid] || { stage: 0 };
        var r = el.getAttribute('data-r');
        var ns;
        if (r === 'again') { st.stage = 0; st.due = today(); }
        else {
          ns = Math.min(st.stage + 1, CARD_INTERVALS.length - 1);
          st.stage = ns;
          var days = r === 'hard' ? Math.max(1, Math.floor(CARD_INTERVALS[ns] / 2)) : (CARD_INTERVALS[ns] || 1);
          var dt = new Date(); dt.setDate(dt.getDate() + days);
          st.due = dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
        }
        st.last = Date.now();
        state.cards[cid] = st;
        Store.set('cards', state.cards);
        markActivity();

        if (r === 'again') {
          d.queue.push(cid);
        } else {
          d.idx++;
        }
        d.flipped = false;
        if (d.idx >= d.queue.length) {
          state.deck = null;
          render();
          toast('这一组卡片复习完成');
        } else render();
        break;
      }
      case 'deck-exit':
        state.deck = null; render(); break;

      /* ---- 费曼讲解 ---- */
      case 'fey-subject': state.talkSetup.subject = el.getAttribute('data-s'); render(); break;
      case 'fey-source': state.talkSetup.source = el.getAttribute('data-v'); render(); break;
      case 'fey-scope': state.talkSetup.scope = el.getAttribute('data-v'); render(); break;
      case 'fey-start': startTalk(null); break;
      case 'fey-exit':
      case 'fey-back':
        state.talk = null; render(); break;
      case 'fey-reveal': {
        var t = state.talk;
        if (!t || t.done || t.revealed) break;
        var talkEl = viewEl.querySelector('[data-bind="talk"]');
        if (talkEl) t.text = talkEl.value;
        if (!String(t.text || '').trim()) break;
        t.revealed = true;
        render();
        window.scrollTo(0, 0);
        break;
      }
      case 'fey-rate': {
        var t2 = state.talk;
        if (!t2 || t2.done) break;
        var rating = el.getAttribute('data-r');
        if (FEY_RATINGS.indexOf(rating) === -1) break;
        var key2 = t2.keys[t2.idx];
        var noteEl = viewEl.querySelector('[data-bind="talknote"]');
        var note = noteEl ? noteEl.value.trim() : String(t2.note || '').trim();
        var rec = state.feynman[key2] || { stage: 0 };
        if (rating === 'clear') rec.stage = Math.min((rec.stage || 0) + 1, CARD_INTERVALS.length - 1);
        else if (rating === 'stuck') rec.stage = 0;
        rec.due = datePlus(rating === 'clear' ? (CARD_INTERVALS[rec.stage] || 1) : rating === 'shaky' ? 1 : 0);
        rec.last = Date.now();
        rec.stuck = rating !== 'clear';
        rec.notes = rating === 'clear' ? null : (note || null);
        state.feynman[key2] = rec;
        Store.set('feynman', state.feynman);
        markActivity();
        t2.results.push({ key: key2, r: rating, note: rec.notes || '' });
        t2.idx++;
        t2.revealed = false; t2.text = ''; t2.note = '';
        if (t2.idx >= t2.keys.length) t2.done = true;
        render();
        window.scrollTo(0, 0);
        break;
      }
      case 'fey-redo': startTalk([el.getAttribute('data-k')]); break;
      case 'fey-again-stuck': {
        var t3 = state.talk;
        if (!t3) break;
        var again = t3.results.filter(function (x) { return x.r !== 'clear'; })
          .map(function (x) { return x.key; });
        if (again.length) startTalk(again);
        break;
      }
      case 'fey-tocard': saveStuckCard(el.getAttribute('data-k'), el); break;

      /* ---- 账号 ---- */
      case 'acc-tab': {
        if (state.account.busy) break;
        state.account.form = el.getAttribute('data-v') === 'register' ? 'register' : 'login';
        state.account.msg = null;
        render();
        break;
      }
      case 'acc-sync-now': {
        clearTimeout(sync.timer);
        sync.dirty = true;
        flushSync();
        break;
      }
      case 'acc-pull': accPull(); break;
      case 'acc-logout': accLogout(); break;

      /* ---- 内容管理 ---- */
      case 'adm-tab': {
        state.admin.tab = el.getAttribute('data-v');
        state.admin.editing = null;
        render();
        break;
      }
      case 'adm-subject': {
        state.admin.subject = el.getAttribute('data-v');
        renderAdminList();
        document.querySelectorAll('[data-act="adm-subject"]').forEach(function (b) {
          b.setAttribute('aria-pressed', String(b === el));
        });
        break;
      }
      case 'adm-new': admOpenEditor(el.getAttribute('data-kind'), null); break;
      case 'adm-edit': admOpenEditor(el.getAttribute('data-kind'), el.getAttribute('data-id')); break;
      case 'adm-del': {
        if (state.admin.busy) break;
        admDelete(el.getAttribute('data-kind'), el.getAttribute('data-id'));
        break;
      }
      case 'adm-save': if (!state.admin.busy) admSave(); break;
      case 'adm-cancel': {
        if (state.admin.busy) break;
        state.admin.editing = null;
        state.admin.msg = null;
        render();
        break;
      }
      case 'adm-claim': if (!state.admin.busy) admClaim(); break;
      case 'adm-sync': if (!state.admin.busy) admSync(); break;
      case 'adm-reload': if (!state.admin.busy) admReload(); break;
      case 'adm-export': admExport(); break;
      case 'adm-import': {
        if (state.admin.busy) break;
        var fi = document.getElementById('admFile');
        if (fi) { fi.value = ''; fi.click(); }
        break;
      }
      case 'adm-import-clear':
        state.admin.importErrors = null;
        render();
        break;
      case 'adm-img': {
        if (state.admin.imgBusy) break;
        var imgInput = document.getElementById('amFile');
        if (!imgInput) { amStatus('这个后端不支持插图。', true); break; }
        amStatus('');
        imgInput.value = '';
        imgInput.click();
        break;
      }
      case 'am-preview': amTogglePreview(); break;

      /* ---- 考纲 ---- */
      case 'kp': {
        var key = el.getAttribute('data-k');
        if (state.kp[key]) delete state.kp[key];
        else { state.kp[key] = true; markActivity(); }
        Store.set('kp', state.kp);
        render();
        break;
      }
      case 'kp-reset': {
        var sk = el.getAttribute('data-s');
        openModal('清空 ' + SUBJ[sk].name + ' 的考点勾选？', '所有考点掌握进度会被重置，此操作不可撤销。', '', '清空', function () {
          Object.keys(state.kp).forEach(function (k) { if (k.indexOf(sk + '|') === 0) delete state.kp[k]; });
          Store.set('kp', state.kp); render(); toast('已清空');
        });
        break;
      }

      /* ---- 计划 ---- */
      case 'task': {
        var tid = el.getAttribute('data-t');
        if (state.plan[tid]) delete state.plan[tid];
        else { state.plan[tid] = true; markActivity(); }
        Store.set('plan', state.plan);
        render();
        break;
      }
      case 'plan-reset':
        openModal('清空全部计划进度？', '所有任务的勾选状态会被重置，此操作不可撤销。', '', '清空', function () {
          state.plan = {}; Store.set('plan', {}); render(); toast('已清空');
        });
        break;
    }
  }

  function startDeck(s, dueOnly) {
    var list = window.CARDS[s] || [];
    var queue = (dueOnly ? dueCards(s) : list).map(function (c) { return c.id; });
    if (!queue.length) { toast(dueOnly ? '这一科目前没有到期卡片，可以「全部过一遍」' : '没有卡片'); return; }
    state.deck = { subject: s, queue: shuffle(queue), idx: 0, flipped: false };
  }

  function onChange(e) {
    var el = e.target;
    var b = el.getAttribute && el.getAttribute('data-bind');
    if (b === 'count') {
      state.setup.count = parseInt(el.value, 10) || 0;
      render();
    } else if (b === 'feycount') {
      state.talkSetup.count = parseInt(el.value, 10) || 0;
      render();
    }
    if (el.id === 'admFile') {
      var f = el.files && el.files[0];
      if (f) admImport(f);
      return;
    }
    var f = el.getAttribute && el.getAttribute('data-f');
    // 题型和科目决定编辑器的其余控件长什么样，改了要整块重绘。
    if ((f === 'qtype' || f === 'subject') && document.getElementById('admEditor')) {
      var draft = admReadForm();
      if (draft) { state.admin.editing = draft; render(); amRefreshPreview(); }
    }
    if (el.id === 'amTarget') { amRefreshPreview(); return; }
    if (el.id === 'amFile') {
      var img = el.files && el.files[0];
      el.value = '';
      if (img) amInsertImage(img);
      return;
    }
  }

  function onInput(e) {
    var el = e.target;
    var b = el.getAttribute && el.getAttribute('data-bind');
    if (b === 'talk') {
      if (!state.talk) return;
      state.talk.text = el.value;
      var rev = viewEl.querySelector('[data-act="fey-reveal"]');
      if (rev) rev.disabled = !el.value.trim();
      return;
    }
    if (b === 'talknote') {
      if (state.talk) state.talk.note = el.value;
      return;
    }
    if (b === 'admin-q') {
      // 只重绘列表，避免整页重渲染打断输入焦点。
      state.admin.q = el.value;
      renderAdminList();
      return;
    }
    // 编辑器的字段改动只刷新预览，state 里的草稿仍是旧的（保存时统一读取）。
    if (el.getAttribute && el.getAttribute('data-f') &&
        el.closest && el.closest('#admEditor')) amRefreshPreviewSoon();
    var ss = state.session;
    if (!ss) return;
    if (b === 'blank' && ss.results[ss.idx] === null) {
      ss.picks[ss.idx] = el.value;
      var btn = viewEl.querySelector('[data-act="submit"]');
      if (btn) btn.disabled = !el.value.trim();
    } else if (b === 'short' && ss.results[ss.idx] === null) {
      ss.picks[ss.idx] = el.value;
    }
  }

  function onKeydown(e) {
    if (e.target.matches && e.target.matches('input, textarea, select')) {
      if (e.key === 'Enter' && e.target.getAttribute && e.target.getAttribute('data-bind') === 'blank') {
        e.preventDefault();
        var sb = viewEl.querySelector('[data-act="submit"]');
        if (sb && !sb.disabled) sb.click();
      }
      return;
    }
    if (document.querySelector('.modal-back')) return;

    if (state.deck) {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (!state.deck.flipped) { state.deck.flipped = true; render(); }
        return;
      }
      if (state.deck.flipped) {
        if (e.key === '1') { document.querySelector('[data-r="again"]').click(); return; }
        if (e.key === '2') { document.querySelector('[data-r="hard"]').click(); return; }
        if (e.key === '3') { document.querySelector('[data-r="easy"]').click(); return; }
      }
    }

    if (state.route === 'feynman' && state.talk && !state.talk.done) {
      var tk = state.talk;
      if (!tk.revealed) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          var rv = viewEl.querySelector('[data-act="fey-reveal"]');
          if (rv && !rv.disabled) rv.click();
        }
        return;
      }
      var map = { 1: 'stuck', 2: 'shaky', 3: 'clear' };
      if (map[e.key]) {
        var rb = viewEl.querySelector('[data-act="fey-rate"][data-r="' + map[e.key] + '"]');
        if (rb) { e.preventDefault(); rb.click(); }
        return;
      }
    }

    var ss2 = state.session;
    if (!ss2 || state.route !== 'practice') return;    var q = findQuestion(ss2.ids[ss2.idx]);
    if (!q) return;
    var res = ss2.results[ss2.idx];
    var done = res !== null && res !== 'pending';

    if (res === 'pending') {
      if (e.key === '1') { document.querySelector('[data-r="unknown"]').click(); return; }
      if (e.key === '2') { document.querySelector('[data-r="know"]').click(); return; }
    }
    if (/^[1-9]$/.test(e.key) && !done && q.options && q.options.length >= parseInt(e.key, 10)) {
      var btns = viewEl.querySelectorAll('.opt');
      if (btns[parseInt(e.key, 10) - 1]) btns[parseInt(e.key, 10) - 1].click();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!done) {
        var sub = viewEl.querySelector('[data-act="submit"]');
        if (sub && !sub.disabled) sub.click();
      } else {
        var nx = viewEl.querySelector('[data-act="next"]') || viewEl.querySelector('[data-act="finish"]');
        if (nx) nx.click();
      }
    }
  }

  /* ---------------- 移动端导航 ---------------- */
  var scrim = document.getElementById('scrim');
  var menuBtn = document.getElementById('menuBtn');
  function openNav() {
    document.body.classList.add('nav-open');
    scrim.hidden = false;
    menuBtn.setAttribute('aria-expanded', 'true');
  }
  function closeNav() {
    document.body.classList.remove('nav-open');
    scrim.hidden = true;
    menuBtn.setAttribute('aria-expanded', 'false');
  }
  menuBtn.addEventListener('click', function () {
    if (document.body.classList.contains('nav-open')) closeNav(); else openNav();
  });
  scrim.addEventListener('click', closeNav);

  /* ---------------- 启动 ---------------- */
  viewEl = document.getElementById('view');
  // 主视图的公式在 render() 末尾直接渲染；这里兜住弹窗、后台列表搜索这些
  // 不经过 render() 的写入点，省得每处 innerHTML 后面都补一行。
  // KaTeX 自己渲染时也会改 DOM，但那时节点已经打了 data-math-done，不会再进来。
  // 用 setTimeout 而不是 requestAnimationFrame 合批：rAF 在页面不可见时不触发，
  // 排队标志会一直卡住，等页面回到前台才补渲染；setTimeout 在后台也会跑。
  if (window.MutationObserver) {
    var mathQueued = false;
    new MutationObserver(function () {
      if (mathQueued) return;
      mathQueued = true;
      setTimeout(function () { mathQueued = false; paintMath(document); }, 0);
    }).observe(document.body, { childList: true, subtree: true });
  }
  document.getElementById('view').addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  document.addEventListener('keydown', onKeydown);
  // 用真正的 <form> 提交，回车就能登录；这里只拦掉默认跳转。
  document.addEventListener('submit', function (e) {
    if (e.target && e.target.id === 'accForm') { e.preventDefault(); accSubmit(); }
  });
  window.addEventListener('hashchange', function () {
    state.route = routeFromHash();
    if (state.route !== 'practice') showingResult = false;
    render();
    window.scrollTo(0, 0);
  });
  // 关页面时防抖还没到点，那份改动就丢了；这里补一枪。
  window.addEventListener('pagehide', flushSyncNow);

  state.route = routeFromHash();
  showingResult = !!(state.session && state.session.finished);
  if (!location.hash) location.replace('#/dashboard');
  // 先用打包的内置内容把界面画出来，云端读到内容后再覆盖一次。
  normalizeContent();
  migrateKp();
  render();
  loadCloud().then(render, render);
  loadIdentity();
})();

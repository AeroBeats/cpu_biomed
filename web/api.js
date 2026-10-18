/* ============================================================
   云端题库接口层 · 药大生医初试复习台
   同源调用站点 Function（逻辑名 app），失败时回落到内置数据。
   进度数据仍存本地 localStorage，云端只承载「内容」。
   ============================================================ */

window.Cloud = (function () {
  'use strict';

  var FN = '/functions/v1/app';
  var SUBJECTS = ['bio', 'ana', 'pol', 'eng'];

  // 内置数据快照：api.js 在数据脚本之后、app.js 之前加载，
  // 此处固定引用，之后 window.QB 被云端数据替换也不受影响。
  var BUILTIN = { QB: window.QB, SYLLABUS: window.SYLLABUS, CARDS: window.CARDS };

  /* ---------------- 通用请求 ---------------- */

  function ApiError(message, code, status, field) {
    var e = new Error(message);
    e.name = 'ApiError';
    e.code = code;
    e.status = status || 0;
    e.field = field || null;
    return e;
  }

  // 提示文案由本文件按已知公开错误码给出，绝不直接展示服务端原文。
  var MESSAGES = {
    login_required: '需要先登录 Qoder 账号，才能使用题库后台管理。',
    invalid_user_context: '登录状态校验失败，请刷新页面后重试。',
    owner_not_claimed: '还没有启用后台管理，请先点击「启用后台管理」。',
    owner_exists: '后台管理已由其他账号启用，当前账号无法修改题库。',
    not_owner: '当前账号不是本站点所有者，只能浏览、不能修改。',
    invalid_field: '提交的内容格式有误，请检查填写的字段。',
    invalid_request: '请求内容无法解析，请重试。',
    payload_too_large: '一次提交的内容过大，请分批保存。',
    too_many_records: '一次同步的记录过多，请分批提交。',
    duplicate_id: '这个编号已经存在，请换一个编号。',
    not_found: '要操作的内容不存在，可能已被删除。',
    write_rejected: '数据库拒绝了这次写入，请稍后重试。',
    database_request_failed: '数据库连接失败，请稍后重试。',
    method_not_allowed: '请求方式不被允许。',
    database_runtime_unavailable: '云端题库服务暂时不可用。'
  };

  var FALLBACK_MESSAGE = '操作失败，请先确认当前内容状态再重试。';

  function requestJson(url, init, messages) {
    init = init || {};
    messages = messages || MESSAGES;
    var headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    var opts = {};
    for (var k in init) { if (k !== 'headers') opts[k] = init[k]; }
    opts.headers = headers;
    opts.credentials = 'same-origin';

    return fetch(url, opts).then(function (response) {
      if (response.status === 401 || response.status === 403) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          var code = typeof body.error === 'string' ? body.error : 'access_denied';
          throw ApiError(messages[code] || '请确认站点访问权限后重新登录。', code, response.status);
        });
      }
      var ct = response.headers.get('content-type') || '';
      if (response.redirected || ct.indexOf('application/json') === -1) {
        throw ApiError('站点服务返回了非预期响应，请确认访问权限。', 'invalid_response', response.status);
      }
      return response.json().catch(function () {
        throw ApiError('站点服务返回了无法解析的内容。', 'invalid_response', response.status);
      }).then(function (data) {
        var body = data && typeof data === 'object' ? data : null;
        var code = body && typeof body.error === 'string' ? body.error
          : (!response.ok || (body && body.ok === false)) && body && typeof body.code === 'string' ? body.code
            : response.ok ? null : 'request_failed';
        if (!response.ok || (body && body.ok === false) || code) {
          var resolved = code || 'request_failed';
          throw ApiError(
            Object.prototype.hasOwnProperty.call(messages, resolved) ? messages[resolved] : FALLBACK_MESSAGE,
            resolved, response.status, body && typeof body.field === 'string' ? body.field : null
          );
        }
        return data;
      });
    }, function (error) {
      if (error && error.name === 'ApiError') throw error;
      if (init.signal && init.signal.aborted) throw error;
      throw ApiError('无法连接站点服务，请检查网络后重试。变更前先确认当前内容状态。', 'network_error');
    });
  }

  // 响应丢失时无法判断写入是否已生效，这类错误绝不能自动重放。
  function isWriteOutcomeUnknown(error) {
    if (!error || error.name !== 'ApiError') return false;
    if (error.status === 401 || error.status === 403) return false;
    if (error.code === 'write_rejected') return false;
    return ['network_error', 'invalid_response', 'write_result_unknown'].indexOf(error.code) !== -1
      || (error.status >= 500 && error.status < 600);
  }

  function get(action) { return requestJson(FN + '?action=' + action); }
  function post(action, body) {
    return requestJson(FN + '?action=' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  /* ---------------- 内置数据 → 云端记录 ---------------- */

  function chapterId(subject, index) { return 'ch-' + subject + '-' + (index + 1); }

  function flattenBuiltin() {
    var questions = [], chapters = [], cards = [];
    // 全局递增的 sort_order，保证云端读取顺序稳定且四科不互相穿插。
    var qi = 0, ci = 0, ki = 0;
    SUBJECTS.forEach(function (s) {
      (BUILTIN.QB[s] || []).forEach(function (q) {
        questions.push({
          id: q.id, subject: s, chapter: q.chapter, qtype: q.type, level: q.level,
          tags: q.tags || [], stem: q.stem, opts: q.options || [], answer: q.answer,
          explain_text: q.explain || '', sort_order: qi++
        });
      });
      var syl = BUILTIN.SYLLABUS[s];
      ((syl && syl.chapters) || []).forEach(function (c, i) {
        chapters.push({
          id: chapterId(s, i), subject: s, name: c.name, weight: c.weight,
          points: c.points || [], sort_order: ci++
        });
      });
      (BUILTIN.CARDS[s] || []).forEach(function (c) {
        cards.push({
          id: c.id, subject: s, chapter: c.chapter, front: c.front, back: c.back, sort_order: ki++
        });
      });
    });
    return { questions: questions, chapters: chapters, cards: cards };
  }

  /* ---------------- 云端记录 → 应用数据 ---------------- */

  function byOrder(rows) {
    return rows.slice().sort(function (a, b) {
      return (a.sort_order - b.sort_order) || String(a.id).localeCompare(String(b.id));
    });
  }

  function toAppData(bank) {
    var QB = {}, CARDS = {}, SYLLABUS = {};
    SUBJECTS.forEach(function (s) { QB[s] = []; CARDS[s] = []; SYLLABUS[s] = null; });

    byOrder(bank.questions || []).forEach(function (r) {
      if (!QB[r.subject]) return;
      QB[r.subject].push({
        id: r.id, chapter: r.chapter, type: r.qtype, level: r.level,
        tags: r.tags || [], stem: r.stem, options: r.opts || [], answer: r.answer,
        explain: r.explain_text || '', source: r.source || null, built_in: !!r.built_in
      });
    });
    byOrder(bank.cards || []).forEach(function (r) {
      if (!CARDS[r.subject]) return;
      CARDS[r.subject].push({
        id: r.id, chapter: r.chapter, front: r.front, back: r.back, built_in: !!r.built_in
      });
    });

    var grouped = {};
    byOrder(bank.chapters || []).forEach(function (r) {
      if (!SYLLABUS.hasOwnProperty(r.subject)) return;
      (grouped[r.subject] = grouped[r.subject] || []).push({
        id: r.id, name: r.name, weight: r.weight, points: r.points || [], built_in: !!r.built_in
      });
    });
    SUBJECTS.forEach(function (s) {
      var builtin = BUILTIN.SYLLABUS[s] || {};
      // 科目简介不入库，沿用内置文案；章节与考点以云端为准。
      SYLLABUS[s] = { desc: builtin.desc || '', chapters: grouped[s] || [] };
    });

    return { QB: QB, CARDS: CARDS, SYLLABUS: SYLLABUS };
  }

  /* ---------------- 对外接口 ---------------- */

  return {
    SUBJECTS: SUBJECTS,
    BUILTIN: BUILTIN,
    ApiError: ApiError,
    isWriteOutcomeUnknown: isWriteOutcomeUnknown,
    chapterId: chapterId,
    flattenBuiltin: flattenBuiltin,
    toAppData: toAppData,
    loadBank: function () { return get('bank'); },
    ownerState: function () { return get('owner'); },
    claimOwner: function () { return post('claim-owner', {}); },
    syncBuiltin: function () { return post('sync-builtin', flattenBuiltin()); },
    upsertQuestion: function (row) { return post('upsert-question', row); },
    deleteQuestion: function (id) { return post('delete-question', { id: id }); },
    upsertChapter: function (row) { return post('upsert-chapter', row); },
    deleteChapter: function (id) { return post('delete-chapter', { id: id }); },
    upsertCard: function (row) { return post('upsert-card', row); },
    deleteCard: function (id) { return post('delete-card', { id: id }); }
  };
})();

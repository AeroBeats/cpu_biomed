/* ============================================================
   云端接口层 · 药大生医初试复习台
   同源调用站点后端（逻辑名 app），失败时回落到内置数据。

   同一份前端要能跑在两种后端上：
   · gateway —— Qoder Sites，身份由平台网关给，只有 bank / owner / claim-owner；
   · accounts —— 自建服务器，有登录页、角色和进度同步。
   用 detectMode() 探一次 ?action=session 来区分：自建后端认得它，
   Qoder 的 Function 会回 not_found，那就是 gateway。
   ============================================================ */

window.Cloud = (function () {
  'use strict';

  var FN = '/functions/v1/app';
  var SUBJECTS = ['bio', 'ana', 'pol', 'eng'];
  // 与 deploy/server/media.mjs 的 MAX_IMAGE_BYTES 保持一致；改一边就得改另一边。
  var MAX_IMAGE_BYTES = 2 * 1024 * 1024;

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
    login_required: '这个操作需要先登录。',
    bad_credentials: '用户名或口令不对，请重试。',
    username_taken: '这个用户名已经被占用，换一个吧。',
    not_admin: '当前账号没有管理权限，只能浏览内容和同步自己的进度。',
    progress_too_large: '进度数据太大，无法同步到服务器。',
    image_too_large: '图片超过 2 MB，请先压一压再上传。',
    unsupported_image: '只收 png / jpg / gif / webp 四种位图，SVG 和 PDF 都不行。',
    upload_unavailable: '服务器没有开启图片存储（未配置 MEDIA_DIR），暂时无法插图。',
    upload_failed: '图片写入服务器失败，可能是磁盘满了或目录没有写权限。',
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

  /* ---------------- 后端形态探测 ---------------- */

  // accounts：自建服务器，有登录页 / 角色 / 进度同步。
  // gateway：Qoder Sites，身份来自平台网关，没有这些动作。
  // 探测失败（断网、5xx）时按 accounts 处理并当作未登录，页面仍能用内置数据。
  function detectMode() {
    return get('session').then(function (s) {
      return { mode: 'accounts', loggedIn: !!s.loggedIn, user: s.user || null };
    }, function (e) {
      if (e && e.code === 'not_found') return { mode: 'gateway' };
      return { mode: 'accounts', loggedIn: false, user: null, error: e };
    });
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
    detectMode: detectMode,
    loadBank: function () { return get('bank'); },
    session: function () { return get('session'); },
    login: function (username, password) {
      return post('login', { username: username, password: password });
    },
    register: function (username, password, displayName) {
      var body = { username: username, password: password };
      if (displayName) body.display_name = displayName;
      return post('register', body);
    },
    logout: function () { return post('logout', {}); },
    loadProgress: function () { return get('progress'); },
    saveProgress: function (data) { return post('progress', { data: data }); },
    // 关页面时来不及等一次往返，用 beacon / keepalive 把最后一份快照丢出去。
    // 发得出去不代表服务器收下了，所以它只用来兜底，不更新同步状态。
    saveProgressNow: function (data) {
      var body = JSON.stringify({ data: data });
      if (navigator.sendBeacon) {
        return navigator.sendBeacon(FN + '?action=progress', new Blob([body], { type: 'application/json' }));
      }
      try {
        fetch(FN + '?action=progress', {
          method: 'POST', keepalive: true, credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: body
        });
        return true;
      } catch (e) { return false; }
    },
    /* 插图：把文件读成 data URL 交给后端，后端按文件头判类型、生成随机文件名落盘，
       回一个 /media/… 的相对路径，直接写进题目内容里就能用。
       大小在本地先卡一道——超了也传不上去，白等一轮往返不如立刻说清。 */
    uploadImage: function (file) {
      return new Promise(function (resolve, reject) {
        if (!file) { reject(ApiError(MESSAGES.invalid_request, 'invalid_request')); return; }
        if (file.size > MAX_IMAGE_BYTES) {
          reject(ApiError(MESSAGES.image_too_large, 'image_too_large')); return;
        }
        var reader = new FileReader();
        reader.onerror = function () { reject(ApiError('这张图读不出来，可能已经损坏，换一张试试。', 'read_failed')); };
        reader.onload = function () {
          post('upload', { data: String(reader.result) }).then(function (res) {
            if (res && typeof res.url === 'string') resolve(res.url);
            else reject(ApiError(MESSAGES.upload_failed, 'upload_failed'));
          }, reject);
        };
        reader.readAsDataURL(file);
      });
    },
    ownerState: function () { return get('owner'); },    claimOwner: function () { return post('claim-owner', {}); },
    syncBuiltin: function () { return post('sync-builtin', flattenBuiltin()); },
    upsertQuestion: function (row) { return post('upsert-question', row); },
    deleteQuestion: function (id) { return post('delete-question', { id: id }); },
    upsertChapter: function (row) { return post('upsert-chapter', row); },
    deleteChapter: function (id) { return post('delete-chapter', { id: id }); },
    upsertCard: function (row) { return post('upsert-card', row); },
    deleteCard: function (id) { return post('delete-card', { id: id }); }
  };
})();

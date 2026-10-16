/* 在 Qoder 站点上导出云端题库 + 学习进度
   ------------------------------------------------------------------
   用法：
   1. 用你自己的浏览器打开 https://cpu-biomed-q1r9t5025uh.qoder.website/ 并登录；
   2. F12 打开开发者工具 → Console（控制台）；
   3. 把本文件全部内容复制粘贴进去，回车；
   4. 浏览器会下载一个 qoder-export-*.json，把它放到 deploy/migrate/ 目录下；
   5. 在电脑上运行：node deploy/tools/import-bundle.mjs deploy/migrate/qoder-export-xxxx.json

   这段脚本只读不写：不会修改云端题库，也不会动你的进度数据。
   ------------------------------------------------------------------ */
(async function exportFromQoder() {
  var NS = 'cpuBioMed.';
  var out = { exported_at: new Date().toISOString(), origin: location.origin };

  var res = await fetch('/functions/v1/app?action=bank', { credentials: 'same-origin' });
  if (!res.ok) {
    console.error('读取云端题库失败，HTTP ' + res.status + '。请确认已登录 Qoder 账号后刷新页面再试。');
    return;
  }
  out.bank = await res.json();

  out.progress = {};
  for (var i = 0; i < localStorage.length; i++) {
    var key = localStorage.key(i);
    if (key && key.indexOf(NS) === 0) out.progress[key] = localStorage.getItem(key);
  }

  var q = out.bank.questions || [], c = out.bank.cards || [], ch = out.bank.chapters || [];
  var custom = {
    questions: q.filter(function (r) { return !r.built_in; }).map(function (r) { return r.id; }),
    cards: c.filter(function (r) { return !r.built_in; }).map(function (r) { return r.id; }),
    chapters: ch.filter(function (r) { return !r.built_in; }).map(function (r) { return r.id; })
  };

  console.log('%c云端题库导出完成', 'font-weight:bold');
  console.log('  题目 ' + q.length + ' 条，考纲章节 ' + ch.length + ' 条，背诵卡 ' + c.length + ' 条');
  console.log('  进度项 ' + Object.keys(out.progress).length + ' 个：' + Object.keys(out.progress).map(function (k) { return k.slice(NS.length); }).join(', '));
  console.log('  后台手动新增（built_in=false）：题目 ' + custom.questions.length
    + '，卡片 ' + custom.cards.length + '，章节 ' + custom.chapters.length);
  if (custom.questions.length || custom.cards.length || custom.chapters.length) {
    console.log('  这些是只有云端才有、本地文件里没有的内容，务必用导出文件做种子：', custom);
  } else {
    console.log('  云端内容与仓库内置文件一致，用 build-seed.mjs 生成的种子也等价。');
  }
  if (out.bank.truncated) console.warn('  注意：bank 返回被截断（超过 5000 行），请联系维护者分批导出。');

  var name = 'qoder-export-' + new Date().toISOString().slice(0, 10) + '.json';
  var blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  console.log('已下载 ' + name + '，请把它放到 deploy/migrate/ 目录。');
})();

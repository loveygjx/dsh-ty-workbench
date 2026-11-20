// 天源报告原生导出 · ego 驱动引擎
// 通过 ego-browser nodejs 模式，在真实 Chromium（带登录态）里用页面内 fetch 调天源接口：
//   列表 → 生成 → 轮询 → 下载，全程复用浏览器会话，不落地任何 Cookie。
//
// 设计要点（对应历史缺陷）：
//  1. 一律按 companyId + reportType + version 三重比对，绝不用公司名模糊匹配；
//  2. refresh 模式先记录基线最高版本，只认「版本更高 且 jobState=2 且 attachId 非空」；
//  3. 每份下载立刻校验 ZIP 头，不合格即判该项失败；
//  4. 单项失败不影响其余项，最终 ok 仅当全部成功。

export const REPORT_SENTINEL = '@@DSH_REPORT@@';
export const SPACE_NAME = 'workbench-sync';

// 页面内可用的辅助代码（作为 evaluate 表达式的公共前缀）
const PAGE_LIB = [
  'const __api = async (p, o) => {',
  '  const r = await fetch("https://excel.zhrdc.net" + p, Object.assign({credentials:"include", headers:{"Accept":"application/json"}}, o||{}));',
  '  const t = await r.text();',
  '  try { return JSON.parse(t); } catch (e) { return {code:-1, msg:"非JSON:"+t.slice(0,120)}; }',
  '};',
].join('\n');

/** 把「页面内 async 函数体」包成可 evaluate 的表达式 */
function pageExpr(fnBody) {
  return '(async () => {\n' + PAGE_LIB + '\n' + fnBody + '\n})()';
}

/**
 * 生成 ego 脚本。
 * DATA: { projectId, items:[{companyId,companyName,type,mode}], pollMs?, maxWaitMs? }
 */
export function buildReportScript(DATA) {
  const pid = String(DATA.projectId);
  const listExpr = pageExpr(
    'const res = await __api("/ty/api/report/project?pageNum=1&limit=200&projectId=" + encodeURIComponent(' + JSON.stringify(pid) + ') + "&reportType=&companyId=");\n' +
    'return JSON.stringify(res);'
  );

  // 每项作业的生成/下载表达式在运行期按 item 拼（这里只放模板常量）
  const buildExprTpl = pageExpr(
    'const res = await __api("/ty/api/report/build/" + encodeURIComponent(PID) + "/" + encodeURIComponent(CID) + "/" + TYPE, {method:"POST", headers:{"Content-Type":"application/json"}});\n' +
    'return JSON.stringify(res);'
  );
  const downloadExprTpl = pageExpr(
    'const r = await fetch("https://excel.zhrdc.net/ty/api/attach/" + encodeURIComponent(AID) + "/download", {credentials:"include"});\n' +
    'if (!r.ok) return "__HTTP_" + r.status;\n' +
    'const ct = r.headers.get("content-type") || "";\n' +
    'if (ct.indexOf("json") >= 0) { const t = await r.text(); return "__JSON_" + t.slice(0,160); }\n' +
    'const buf = new Uint8Array(await r.arrayBuffer());\n' +
    'if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) return "__NOTZIP_" + buf.length;\n' +
    'let s = ""; const CH = 0x8000;\n' +
    'for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));\n' +
    'return btoa(s);'
  );

  return '(' + egoMain.toString() + ')(' + JSON.stringify(DATA) + ', cdp, '
    + (DATA.__setup === false ? 'null' : 'async function () {'
      + ' const list = await ego.helpers.listTaskSpaces();'
      + ' const t = (list || []).find(function (s) { return s && s.name === ' + JSON.stringify(SPACE_NAME) + '; });'
      + ' if (!t || t.ownership === "agent") return ego.helpers.useOrCreateTaskSpace(' + JSON.stringify(SPACE_NAME) + ');'
      + ' if (true) return ego.helpers.claimTaskSpace(t.id);'
      + ' throw new Error("SPACE_OWNED:" + t.id);'
      + '}')
    + ', '
    + JSON.stringify({ listExpr, buildExprTpl, downloadExprTpl })
    + ');';
}

/**
 * ego 内主流程。参数：DATA、cdp、setup、TPL。
 * 注意：这个函数会被 toString() 序列化后送进 ego，不能引用外部变量。
 */
async function egoMain(DATA, cdp, setup, TPL) {
  const out = { ok: false, files: [], errors: [], logs: [] };
  const log = (m) => { out.logs.push(m); };
  const emit = () => console.log('@@DSH_REPORT@@' + JSON.stringify(out));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const TYPE_LABEL = { 1: '评估报告', 2: '评估说明', 3: '长投说明' };

  async function evaluate(expr) {
    const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) throw new Error('evaluate: ' + JSON.stringify(r.exceptionDetails).slice(0, 240));
    return r && r.result ? r.result.value : null;
  }
  async function goto(url) {
    await cdp('Page.navigate', { url });
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const st = await evaluate('document.readyState + "|" + location.href').catch(() => null);
      if (st && st.indexOf('complete|') === 0) return st.slice(9);
    }
    return await evaluate('location.href').catch(() => null);
  }

  // 关键：导航后必须确认没被踢回登录页。被踢回时页面在 auth.zhrdc.net，
  // 后续对 excel.zhrdc.net 的 fetch 会变成跨域，浏览器直接抛 "Failed to fetch"，
  // 真实原因（未登录）会被这个假象掩盖。
  async function assertNotRedirectedToLogin() {
    const href = await evaluate('location.href').catch(() => '');
    if (href && href.indexOf('auth.zhrdc.net') >= 0) {
      const err = new Error('NOT_LOGGED_IN');
      err.tyMsg = '被重定向到登录页，会话已过期';
      throw err;
    }
  }

  try {
    if (typeof setup === 'function') await setup();
    const pid = String(DATA.projectId);
    await goto('https://excel.zhrdc.net/ty/operation/' + pid + '/report');
    try { await assertNotRedirectedToLogin(); } catch (e) {
      out.ok = false; out.code = 'NOT_LOGGED_IN';
      out.msg = '这个 ego 窗口的天源登录态已失效（' + ((e && e.tyMsg) || '需要重新登录') + '）。请在该窗口重新登录一次后重试。';
      emit(); return;
    }

    // 列表读取（同时充当登录态探测）
    async function listReports() {
      const raw = await evaluate(TPL.listExpr);
      const j = JSON.parse(raw || '{}');
      if (j.code !== 200) {
        const err = new Error('NOT_LOGGED_IN');
        err.tyMsg = j.msg || ('code ' + j.code);
        throw err;
      }
      const rows = Array.isArray(j.data) ? j.data : ((j.data && j.data.list) || []);
      return rows.map((x) => ({
        companyId: String(x.companyId), type: Number(x.reportType),
        version: Number(x.version) || 0, jobState: Number(x.jobState),
        attachId: x.attachId ? String(x.attachId) : null, companyName: x.companyName || '',
      }));
    }

    let before;
    try {
      before = await listReports();
    } catch (e) {
      if (e && e.message === 'NOT_LOGGED_IN') {
        out.ok = false; out.code = 'NOT_LOGGED_IN';
        out.msg = '这个 ego 窗口还没登录天源（接口返回：' + ((e && e.tyMsg) || '未知') + '）。请在该窗口登录一次后重试。';
        emit(); return;
      }
      throw e;
    }

    for (let i = 0; i < DATA.items.length; i++) {
      const it = DATA.items[i];
      const label = TYPE_LABEL[it.type] || ('类型' + it.type);
      const tag = '[' + (i + 1) + '/' + DATA.items.length + '] ' + (it.companyName || it.companyId) + ' · ' + label;
      try {
        let target = null;
        if (it.mode === 'refresh') {
          log(tag + '：提交生成任务');
          const bExpr = TPL.buildExprTpl
            .replace('PID', JSON.stringify(pid))
            .replace('CID', JSON.stringify(String(it.companyId)))
            .replace('TYPE', String(Number(it.type)));
          const bj = JSON.parse(await evaluate(bExpr) || '{}');
          if (bj.code !== 200) throw new Error('生成任务提交失败：' + (bj.msg || bj.code));
          const baseVer = before.filter((r) => r.companyId === String(it.companyId) && r.type === Number(it.type))
            .reduce((m, r) => Math.max(m, r.version), 0);
          log(tag + '：任务 ' + bj.data + ' 已提交（基线 V' + baseVer + '），等待生成…');
          const t0 = Date.now();
          const maxWait = Number(DATA.maxWaitMs) || 600000;
          const pollMs = Number(DATA.pollMs) || 8000;
          while (Date.now() - t0 < maxWait) {
            await sleep(pollMs);
            const rows = await listReports();
            const mine = rows.filter((r) => r.companyId === String(it.companyId) && r.type === Number(it.type)
              && r.version > baseVer && r.attachId && r.jobState === 2);
            if (mine.length) { mine.sort((a, b) => b.version - a.version); target = mine[0]; break; }
            const anyNew = rows.filter((r) => r.companyId === String(it.companyId) && r.type === Number(it.type) && r.version > baseVer);
            log(tag + '：' + (anyNew.length ? '新版本 V' + anyNew[0].version + ' 生成中…' : '等待调度…'));
          }
          if (!target) throw new Error('等待生成超时（' + Math.round(maxWait / 60000) + ' 分钟）');
        } else {
          const rows = await listReports();
          const mine = rows.filter((r) => r.companyId === String(it.companyId) && r.type === Number(it.type)
            && r.attachId && r.jobState === 2);
          if (!mine.length) throw new Error('没有已生成的' + label + '（可能从未生成，请改用「生成新版本」）');
          mine.sort((a, b) => b.version - a.version);
          target = mine[0];
        }

        log(tag + '：下载 V' + target.version);
        const dExpr = TPL.downloadExprTpl.replace('AID', JSON.stringify(String(target.attachId)));
        const b64 = await evaluate(dExpr);
        if (typeof b64 !== 'string' || b64.indexOf('__') === 0) throw new Error('下载失败：' + String(b64).slice(0, 160));

        const safeName = String(it.companyName || target.companyName || it.companyId).replace(/[\\/:*?"<>|]/g, '_');
        out.files.push({
          companyId: String(it.companyId), companyName: it.companyName || target.companyName,
          type: Number(it.type), version: target.version, base64: b64,
          fileName: safeName + '-' + label + '-V' + target.version + '.docx',
        });
        log(tag + '：已取回 V' + target.version + '（约 ' + Math.round(b64.length * 0.75 / 1024) + ' KB）');
      } catch (e) {
        out.errors.push(tag + '：' + String((e && e.message) || e));
        log(tag + '：失败 ' + String((e && e.message) || e));
      }
    }

    out.ok = out.errors.length === 0 && out.files.length > 0;
    emit();
  } catch (e) {
    out.ok = false;
    out.code = 'SCRIPT_FAIL';
    out.msg = String((e && e.message) || e);
    emit();
  }
}

/**
 * 列出项目下公司 + 各家可导出的文档类型（reportConfigList）。
 */
export function buildCompaniesScript(projectId) {
  const DATA = { projectId: String(projectId) };
  const expr = pageExpr(
    'const res = await __api("/ty/api/company/list", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({projectId: PID})});\n' +
    'const j = res && res.code === 200 ? res : null;\n' +
    'if (!j) return JSON.stringify({code: res ? res.code : -1, msg: res ? res.msg : "网络错误"});\n' +
    'const arr = j.data || [];\n' +
    'return JSON.stringify({code:200, companies: arr.map(c => ({\n' +
    '  id: String(c.id), name: c.name || "",\n' +
    '  types: (c.reportConfigList || []).map(x => Number(x.reportType ?? x.type)).filter(t => t >= 1 && t <= 3),\n' +
    '}))});'
  );
  return '(' + egoCompanies.toString() + ')(' + JSON.stringify(DATA) + ', cdp, async function () {'
    + ' const list = await ego.helpers.listTaskSpaces();'
    + ' const t = (list || []).find(function (s) { return s && s.name === ' + JSON.stringify(SPACE_NAME) + '; });'
    + ' if (!t || t.ownership === "agent") return ego.helpers.useOrCreateTaskSpace(' + JSON.stringify(SPACE_NAME) + ');'
    + ' return ego.helpers.claimTaskSpace(t.id);'
    + '}, ' + JSON.stringify({ expr }) + ');';
}

async function egoCompanies(DATA, cdp, setup, TPL) {
  const out = { ok: false, companies: [], msg: '' };
  const emit = () => console.log('@@DSH_REPORT@@' + JSON.stringify(out));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function evaluate(expr) {
    const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) throw new Error('evaluate: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
    return r && r.result ? r.result.value : null;
  }
  try {
    if (typeof setup === 'function') await setup();
    await cdp('Page.navigate', { url: 'https://excel.zhrdc.net/ty/operation/' + String(DATA.projectId) + '/equity/list' });
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const st = await evaluate('document.readyState').catch(() => null);
      if (st === 'complete') break;
    }
    // 被踢回登录页时页面在 auth.zhrdc.net，跨域 fetch 会抛 "Failed to fetch"，
    // 必须先把真实原因（会话过期）识别出来，否则报错信息会误导排查方向。
    const href = await evaluate('location.href').catch(() => '');
    if (href && href.indexOf('auth.zhrdc.net') >= 0) {
      out.ok = false; out.code = 'NOT_LOGGED_IN';
      out.msg = '这个 ego 窗口的天源登录态已失效（被重定向到登录页）。请在该窗口重新登录一次后重试。';
      emit(); return;
    }
    const expr = TPL.expr.replace(/PID/g, JSON.stringify(String(DATA.projectId)));
    const j = JSON.parse(await evaluate(expr) || '{}');
    if (j.code !== 200) { out.ok = false; out.msg = (j.msg || ('code ' + j.code)); if (/未登录|login/i.test(out.msg) || j.code === 403) out.code = 'NOT_LOGGED_IN'; emit(); return; }
    out.ok = true;
    out.companies = j.companies || [];
    emit();
  } catch (e) {
    out.ok = false; out.msg = String((e && e.message) || e); emit();
  }
}

/**
 * 只探测登录态 + 拉报告列表（不下载）。
 */
export function buildProbeScript(projectId) {
  const DATA = { projectId: String(projectId) };
  return '(' + egoProbe.toString() + ')(' + JSON.stringify(DATA) + ', cdp, async function () {'
    + ' const list = await ego.helpers.listTaskSpaces();'
    + ' const t = (list || []).find(function (s) { return s && s.name === ' + JSON.stringify(SPACE_NAME) + '; });'
    + ' if (!t || t.ownership === "agent") return ego.helpers.useOrCreateTaskSpace(' + JSON.stringify(SPACE_NAME) + ');'
    + ' return ego.helpers.claimTaskSpace(t.id);'
    + '}, ' + JSON.stringify({ listExpr: pageExpr(
      'const res = await __api("/ty/api/report/project?pageNum=1&limit=200&projectId=" + encodeURIComponent(PID) + "&reportType=&companyId=");\nreturn JSON.stringify(res);'
    ) }) + ');';
}

async function egoProbe(DATA, cdp, setup, TPL) {
  const out = { ok: false, logged: false, reports: [], msg: '' };
  const emit = () => console.log('@@DSH_REPORT@@' + JSON.stringify(out));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function evaluate(expr) {
    const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) throw new Error('evaluate: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
    return r && r.result ? r.result.value : null;
  }
  try {
    if (typeof setup === 'function') await setup();
    await cdp('Page.navigate', { url: 'https://excel.zhrdc.net/ty/operation/' + String(DATA.projectId) + '/report' });
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const st = await evaluate('document.readyState').catch(() => null);
      if (st === 'complete') break;
    }
    // 会话过期时会跳到 auth.zhrdc.net，此后对 excel 域的 fetch 会变成跨域失败，
    // 报错信息会从"未登录"歪曲成"Failed to fetch"，所以先判 URL。
    const href = await evaluate('location.href').catch(() => '');
    if (href && href.indexOf('auth.zhrdc.net') >= 0) {
      out.ok = true; out.logged = false; out.code = 'NOT_LOGGED_IN';
      out.msg = '这个 ego 窗口的天源登录态已失效（被重定向到登录页）。请在该窗口重新登录一次。';
      emit(); return;
    }
    const expr = TPL.listExpr.replace('PID', JSON.stringify(String(DATA.projectId)));
    const j = JSON.parse(await evaluate(expr) || '{}');
    if (j.code !== 200) { out.ok = true; out.logged = false; out.msg = j.msg || ('code ' + j.code); emit(); return; }
    const rows = Array.isArray(j.data) ? j.data : ((j.data && j.data.list) || []);
    out.ok = true; out.logged = true;
    out.reports = rows.map((x) => ({
      companyId: String(x.companyId), companyName: x.companyName || '',
      type: Number(x.reportType), version: Number(x.version),
      jobState: Number(x.jobState), attachId: x.attachId ? String(x.attachId) : null,
      downloadable: !!(x.attachId && Number(x.jobState) === 2),
    }));
    emit();
  } catch (e) {
    out.ok = false; out.msg = String((e && e.message) || e); emit();
  }
}

/**
 * 打开 ego 的同步窗口并导航到天源首页，供用户在**该窗口**里扫码登录。
 *
 * 为什么不能复用 playwright 的登录：ego 的 task space 之间 cookie 是隔离的，
 * playwright 那套 profile 登录完，ego 窗口里依然是未登录。
 */
export function buildLoginScript() {
  // 登录场景不抢所有权：窗口若是 user 所有（用户自己点过）就直接用，
  // 强行 claim 会失败，反而打不开窗口。
  return '(' + egoLogin.toString() + ')(' + JSON.stringify({ space: SPACE_NAME }) + ', cdp, async function () {'
    + ' const list = await ego.helpers.listTaskSpaces();'
    + ' const t = (list || []).find(function (s) { return s && s.name === ' + JSON.stringify(SPACE_NAME) + '; });'
    + ' if (!t) return ego.helpers.useOrCreateTaskSpace(' + JSON.stringify(SPACE_NAME) + ');'
    + ' if (t.ownership === "user") return null;'
    + ' return ego.helpers.claimTaskSpace(t.id);'
    + '}, null);';
}

async function egoLogin(DATA, cdp, setup) {
  const out = { ok: false, logged: false, url: '', msg: '' };
  const emit = () => console.log('@@DSH_REPORT@@' + JSON.stringify(out));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function evaluate(expr) {
    const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) throw new Error('evaluate: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
    return r && r.result ? r.result.value : null;
  }
  try {
    if (typeof setup === 'function') await setup();
    // 慢一点：给浏览器窗口弹出的时间，用户能看见
    await sleep(300);
    await cdp('Page.navigate', { url: 'https://ty.zhrdc.net/project/my' });
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const st = await evaluate('document.readyState').catch(() => null);
      if (st === 'complete') break;
    }
    out.url = (await evaluate('location.href').catch(() => '')) || '';
    // /project/my 在登录页上；跳到 auth.zhrdc.net 说明还没登录
    out.logged = out.url.indexOf('/project/my') >= 0 && out.url.indexOf('auth.zhrdc.net') < 0;
    out.ok = true;
    out.msg = out.logged
      ? '该窗口已是登录状态'
      : '已打开天源登录窗口，请在这个窗口里扫码登录；登录完成后在导出面板点「重新检测」。';
    emit();
  } catch (e) {
    out.ok = false; out.msg = String((e && e.message) || e); emit();
  }
}

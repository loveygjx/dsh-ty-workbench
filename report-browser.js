// 天源报告原生导出 · 真实浏览器（opencli / Browser Bridge）驱动引擎
//
// 走 opencli 的 Browser Bridge，直接跑在用户日常使用的 Chrome profile 里，
// 天然共享登录态，不需要额外登录，也不需要安装/启动第二个浏览器。
//
// 复用：数据工具（dsh-data-tools）里阿里拍卖模块验证过的同一条 opencli 通道。
//
// 设计约束（真实失败换来的判定纪律）：
//  1. 一律按 companyId + reportType + version 三重比对，绝不用公司名模糊匹配；
//  2. refresh 模式先记录基线最高版本，只认「版本更高 且 jobState=2 且 attachId 非空」；
//  3. 每份下载立刻校验 ZIP 头（PK），不合格即判该项失败；
//  4. 单项失败不影响其余项，最终 ok 仅当全部成功。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OPENCLI_CANDIDATES = [
  join(homedir(), '.npm-global', 'bin', 'opencli'),
  join(homedir(), '.local', 'bin', 'opencli'),
  '/opt/homebrew/bin/opencli',
  '/usr/local/bin/opencli',
  'opencli',
];

const SESSION = 'dsh-report';
const TY_ORIGIN = 'https://excel.zhrdc.net';
const TYPE_LABEL = { 1: '评估报告', 2: '评估说明', 3: '长投说明' };

/** 找可用的 opencli 可执行文件；找不到返回 null。 */
export function resolveOpencliBin() {
  for (const p of OPENCLI_CANDIDATES) {
    try {
      if (p === 'opencli' || existsSync(p)) {
        // 'opencli' 这一项交给 PATH 解析，其余要求文件真实存在
        if (p === 'opencli') return p;
        return p;
      }
    } catch { /* 继续找下一个 */ }
  }
  return null;
}

/** 执行一次 opencli 命令，返回 { code, stdout, stderr }。 */
export function runOpencli(args, { timeout = 60000, bin } = {}) {
  return new Promise((resolve) => {
    const exe = bin || resolveOpencliBin();
    if (!exe) { resolve({ code: -1, stdout: '', stderr: 'OPENCLI_NOT_FOUND' }); return; }
    let child;
    try {
      child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e && e.message || e) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      done({ code: -2, stdout, stderr: stderr + '\nOPENCLI_TIMEOUT' });
    }, timeout);
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (e) => done({ code: -1, stdout, stderr: stderr + String(e && e.message || e) }));
    child.on('close', (code) => done({ code: code == null ? -1 : code, stdout, stderr }));
  });
}

/** opencli 的输出常带升级提示尾巴，这里剥掉非 JSON 部分。 */
function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  // 从第一个 { 开始尝试逐段截取（应对 JSON 后面跟广告文案）
  for (let end = s.length; end > start; end--) {
    const chunk = s.slice(start, end);
    try { return JSON.parse(chunk); } catch { /* 继续缩短 */ }
  }
  return null;
}

/** 在绑定会话里跑一段页面内 JS，返回字符串结果。 */
export async function evalInPage(expr, { timeout = 180000, bin } = {}) {
  const r = await runOpencli(['browser', SESSION, 'eval', expr], { timeout, bin });
  const out = String(r.stdout || '').trim();
  if (r.code !== 0) {
    const err = new Error('OPENCLI_EVAL_FAILED');
    err.detail = out.slice(0, 400) || String(r.stderr || '').slice(0, 400);
    throw err;
  }
  return out;
}

/**
 * 确保会话已绑定到用户真实浏览器。
 * 绑定失败通常意味着：Chrome 没开、或 OpenCLI 扩展未启用。
 */
export async function ensureBound({ bin } = {}) {
  // 只探测会话是否已有可用页面；不调用 bind。
  // bind 会把会话绑到用户"当前活跃标签页"，等于劫持用户正在看的页面；
  // 这里改用 open 在同一个 Chrome profile 里开一个我们自己拥有的标签页，
  // 既共享登录态（cookie 同 profile），又不打扰用户当前在工作台页面上的操作。
  const st = await runOpencli(['browser', SESSION, 'get', 'url'], { timeout: 30000, bin });
  if (st.code === 0 && /^https?:\/\//.test(String(st.stdout || '').trim())) {
    return { ok: true, url: String(st.stdout).trim().split('\n')[0], owned: true };
  }
  // 会话还没有页面：确认 opencli + 浏览器可用（doctor 只在失败时才有意义，这里用 open 探）
  if (!resolveOpencliBin()) {
    const err = new Error('NO_OPENCLI');
    err.detail = '未找到 opencli（浏览器通道）';
    throw err;
  }
  return { ok: true, url: '', owned: true, pending: true };
}

/** 打开（或复用）一个天源页面作为 API 调用宿主，并确认没被踢到登录页。 */
export async function openTyHost(projectId, { bin } = {}) {
  const target = `${TY_ORIGIN}/ty/operation/${projectId}/report`;
  const cur = await runOpencli(['browser', SESSION, 'get', 'url'], { timeout: 30000, bin });
  const curUrl = String(cur.stdout || '').trim().split('\n')[0] || '';
  let opened = false;
  let openedPage = '';
  if (!curUrl.startsWith(`${TY_ORIGIN}/ty/operation/${projectId}`)) {
    // 用户标签页不能 tab new，改用 open（owned session 会自动开新页）
    opened = true;
    const o = await runOpencli(['browser', SESSION, 'open', target], { timeout: 30000, bin });
    if (o.code !== 0) {
      const raw = String(o.stdout || o.stderr || '').trim();
      if (isBridgeDown(raw) || o.code === -2) {
        const err = new Error('BRIDGE_DISCONNECTED');
        err.detail = '连不上浏览器：请确认 Chrome 正在运行，并且 OpenCLI 扩展是启用状态（chrome://extensions）。启用后再点「重新检测」。';
        throw err;
      }
      const err = new Error('OPEN_FAILED');
      err.detail = raw.slice(0, 240);
      throw err;
    }
    // open 的返回里带 page id：记下来，导出结束只关这一个
    const oj = extractJson(o.stdout) || {};
    if (oj.page) openedPage = String(oj.page);
    // 等页面就绪
    await runOpencli(['browser', SESSION, 'wait', 'time', '1'], { timeout: 15000, bin });
  }
  const href = String(await evalInPage('location.href', { timeout: 30000, bin })).trim();
  if (href.indexOf('auth.zhrdc.net') >= 0) {
    const err = new Error('NOT_LOGGED_IN');
    err.detail = '浏览器被重定向到天源登录页';
    throw err;
  }
  return { ok: true, href, opened, openedPage };
}

// 关闭本次由 openTyHost 自己开的那个标签页（按 page id 精确关，用户原有标签页绝不动）
async function closeOwnedTab(pageId, { bin } = {}) {
  if (!pageId || !/^[A-F0-9]{8,}$/i.test(String(pageId))) return { closed: 0 };
  try {
    const c = await runOpencli(['browser', SESSION, 'tab', 'close', String(pageId)], { timeout: 30000, bin });
    return { closed: c.code === 0 ? 1 : 0 };
  } catch {
    return { closed: 0 };
  }
}

// 识别 opencli 的"扩展未连接"：这种情况重试没用，要让用户去开 Chrome / 启用扩展
function isBridgeDown(text) {
  const t = String(text || '');
  return /Browser Bridge extension not connected|extension is not connected|Extension: not connected|not connected yet/i.test(t);
}

// ---------------- 桥接自愈 ----------------
// 实测：Chrome 的 MV3 service worker 会被回收，扩展随之与 daemon 断开。
// 此时 `opencli daemon restart` 能让扩展在 1~2 秒内自动重连（实测 1.2s）。
// 所以遇到 BRIDGE_DISCONNECTED 先自动重启一次 daemon 再重试，仍失败才报给用户。
const RECOVER_COOLDOWN_MS = 15000;   // 两次自愈之间至少间隔，避免并发调用打群架
let LAST_RECOVER_AT = 0;
let RECOVERING = null;

async function recoverBridge({ bin } = {}) {
  const now = Date.now();
  if (RECOVERING) return RECOVERING;
  if (now - LAST_RECOVER_AT < RECOVER_COOLDOWN_MS) return { ok: false, skipped: true };
  LAST_RECOVER_AT = now;
  RECOVERING = (async () => {
    try {
      const r = await runOpencli(['daemon', 'restart'], { timeout: 20000, bin });
      if (r.code !== 0) return { ok: false, detail: String(r.stdout || r.stderr || '').trim().slice(0, 200) };
      // 重启后扩展重连需要一点时间，轮询 doctor 直到 connected 或超时
      for (let i = 0; i < 12; i++) {
        await new Promise((res) => setTimeout(res, 500));
        const d = await runOpencli(['doctor'], { timeout: 15000, bin });
        const out = String(d.stdout || '') + String(d.stderr || '');
        if (/\[OK\] Extension: connected/i.test(out)) return { ok: true, ms: (i + 1) * 500 };
        if (/\[MISSING\] Extension: not connected/i.test(out)) continue;
      }
      return { ok: false, detail: 'daemon 已重启但扩展仍未连上' };
    } catch (e) {
      return { ok: false, detail: String((e && e.message) || e) };
    } finally {
      RECOVERING = null;
    }
  })();
  return RECOVERING;
}

/** 主动检查桥接状态；已连接返回 {ok:true}，未连接返回 {ok:false}。 */
export async function bridgeHealth({ bin } = {}) {
  const d = await runOpencli(['doctor'], { timeout: 15000, bin });
  const out = String(d.stdout || '') + String(d.stderr || '');
  if (/\[OK\] Extension: connected/i.test(out)) return { ok: true };
  if (/\[MISSING\] Extension: not connected/i.test(out) || /not connected/i.test(out)) {
    return { ok: false, detail: '扩展未连接到 opencli daemon' };
  }
  return { ok: d.code === 0, detail: out.trim().slice(0, 200) };
}

/** 手动触发一次自愈（供「重新连接浏览器」按钮用），绕过冷却窗口。 */
export async function recoverBridgeNow({ bin } = {}) {
  LAST_RECOVER_AT = 0;
  RECOVERING = null;
  return recoverBridge({ bin });
}

// 包一层：先跑 fn，命中桥接断连就自愈后重试一次
async function withBridgeRecovery(fn, { bin, onLog } = {}) {
  try {
    return await fn();
  } catch (e) {
    if (!e || e.message !== 'BRIDGE_DISCONNECTED') throw e;
    const log = (m) => { try { if (onLog) onLog(m); } catch { /* noop */ } };
    log('浏览器扩展断开了，正在自动重连…');
    const rec = await recoverBridge({ bin });
    if (!rec.ok) {
      const err = new Error('BRIDGE_DISCONNECTED');
      err.detail = '连不上浏览器扩展（自动重连也没成功）：' + (rec.detail || '') +
        '。请确认 Chrome 正在运行、OpenCLI 扩展已启用，然后点「重新检测」。';
      throw err;
    }
    log('已重连（' + Math.round((rec.ms || 0) / 100) / 10 + 's），继续…');
    return await fn();
  }
}

// ---------------- 页面准备（串行 + 复用） ----------------
// companies / probe 两个路由在前端是并发发的，首次都没有页面时会各自 open 一个标签页。
// 这里用一个进程内的串行锁把"准备页面"合并成一次，并把打开的 page id 记下来供结束后关闭。
let PREP = { projectId: '', promise: null, pages: [] };

async function prepare(projectId, opts) {
  const key = String(projectId);
  if (PREP.projectId === key && PREP.promise) return PREP.promise;
  const promise = (async () => {
    await ensureBound(opts);
    const host = await openTyHost(key, opts);
    if (host && host.openedPage) PREP.pages.push(host.openedPage);
    touchIdle();
    return host;
  })();
  PREP = { projectId: key, promise, pages: PREP.pages };
  // 失败时清掉锁，让下次重试可以重新准备
  promise.catch(() => { if (PREP.projectId === key && PREP.promise === promise) PREP = { projectId: '', promise: null, pages: PREP.pages }; });
  return promise;
}

// 关闭本次为此项目打开的所有临时标签页
export async function releasePages({ bin } = {}) {
  if (ACTIVE > 0) return { closed: 0, busy: true };   // 导出进行中：不能关
  const pages = PREP.pages.slice();
  PREP = { projectId: '', promise: null, pages: [] };
  let n = 0;
  for (const pg of pages) {
    const r = await closeOwnedTab(pg, { bin });
    if (r.closed) n += 1;
  }
  return { closed: n };
}

// 空闲自动收尾：探测类调用结束后过一会儿把临时标签页关掉，
// 避免用户浏览器里留一堆天源页面。导出期间（ACTIVE>0）不触发。
const IDLE_MS = 20000;
let ACTIVE = 0;
let IDLE_TIMER = null;

function touchIdle() {
  if (IDLE_TIMER) clearTimeout(IDLE_TIMER);
  IDLE_TIMER = setTimeout(() => {
    IDLE_TIMER = null;
    if (ACTIVE > 0) return;
    if (!PREP.pages.length) return;
    releasePages().catch(() => {});
  }, IDLE_MS);
  if (IDLE_TIMER.unref) IDLE_TIMER.unref();
}

// ---------------- 页面内 API 辅助 ----------------
// 统一在 excel.zhrdc.net 同源下用 credentials:'include' 调接口。
const API_PREFIX = `const __api = async (p, o) => {
  const r = await fetch(${JSON.stringify(TY_ORIGIN)} + p, Object.assign({credentials:'include', headers:{'Accept':'application/json'}}, o||{}));
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return {code:-1, msg:'非JSON:'+t.slice(0,120)}; }
};
`;

function pageExpr(body) {
  return `(async () => { ${API_PREFIX} ${body} })()`;
}

/** 取项目下所有已生成报告（扁平数组）。 */
export async function listReports(projectId, { bin, prepared, onLog } = {}) {
  return withBridgeRecovery(() => listReportsOnce(projectId, { bin, prepared }), { bin, onLog });
}

async function listReportsOnce(projectId, { bin, prepared } = {}) {
  // 允许调用方先自行 prepare（避免重复开标签页）；未 prepare 时这里补上
  if (!prepared) await prepare(projectId, { bin });
  const expr = pageExpr(`
    // 自适应分页：第一页满 200 继续翻页，直到拿不满一页或服务端 total 已取满。
    // 只取第一页会漏掉新版本（胡庆余堂这类大项目行数可能超过单页 limit）。
    const all = [];
    const LIMIT = 200, MAXP = 50;
    for (let page = 1; page <= MAXP; page++) {
      const res = await __api("/ty/api/report/project?pageNum=" + page + "&limit=" + LIMIT + "&projectId=" + encodeURIComponent(${JSON.stringify(String(projectId))}) + "&reportType=&companyId=");
      if (res.code !== 200) return JSON.stringify({__err: res.code, msg: res.msg});
      const rows = Array.isArray(res.data) ? res.data : ((res.data && res.data.list) || []);
      all.push(...rows);
      if (rows.length < LIMIT) break;
      const meta = res.data && (res.data.total !== undefined ? Number(res.data.total) : (res.data.pages !== undefined ? Number(res.data.pages) * LIMIT : null));
      if (meta !== null && Number.isFinite(meta) && all.length >= meta) break;
      if (page === MAXP) return JSON.stringify({__err: 'LIST_OVERFLOW', msg: '报告列表超过 ' + MAXP + ' 页仍未取完'});
    }
    return JSON.stringify(all.map(x => ({
      companyId: String(x.companyId), companyName: x.companyName || '',
      type: Number(x.reportType), version: Number(x.version) || 0,
      jobState: Number(x.jobState), attachId: x.attachId ? String(x.attachId) : null
    })));
  `);
  const raw = await evalInPage(expr, { bin });
  const j = extractJson('{"r":' + raw + '}');
  const arr = j ? j.r : null;
  if (!Array.isArray(arr)) {
    const e = extractJson(raw);
    if (e && e.__err) {
      const err = new Error('NOT_LOGGED_IN');
      err.detail = e.msg || ('code ' + e.__err);
      throw err;
    }
    throw new Error('列表解析失败：' + String(raw).slice(0, 200));
  }
  return arr;
}

/** 提交生成任务，返回 jobId。 */
export async function buildReport(projectId, companyId, type, { bin } = {}) {
  const expr = pageExpr(`
    const res = await __api("/ty/api/report/build/" + encodeURIComponent(${JSON.stringify(String(projectId))})
      + "/" + encodeURIComponent(${JSON.stringify(String(companyId))})
      + "/" + ${JSON.stringify(String(Number(type)))}, {method:"POST", headers:{"Content-Type":"application/json"}});
    return JSON.stringify(res);
  `);
  const raw = await evalInPage(expr, { bin, timeout: 120000 });
  const j = extractJson(raw) || {};
  if (j.code !== 200) throw new Error('生成任务提交失败：' + (j.msg || j.code));
  return j.data;
}

/** 下载附件，返回 { bytes, base64 }。 */
export async function downloadAttachment(attachId, { bin, timeout = 300000 } = {}) {
  const expr = pageExpr(`
    const r = await fetch(${JSON.stringify(TY_ORIGIN)} + "/ty/api/attach/" + encodeURIComponent(${JSON.stringify(String(attachId))}) + "/download", {credentials:"include"});
    if (!r.ok) return JSON.stringify({__http: r.status});
    const ct = r.headers.get("content-type") || "";
    if (ct.indexOf("json") >= 0) { const t = await r.text(); return JSON.stringify({__json: t.slice(0,160)}); }
    const u = new Uint8Array(await r.arrayBuffer());
    if (u.length < 4 || u[0] !== 0x50 || u[1] !== 0x4b) return JSON.stringify({__notzip: u.length});
    let s = ""; const CH = 32768;
    for (let i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, u.subarray(i, i + CH));
    return JSON.stringify({n: u.length, b64: btoa(s)});
  `);
  const raw = await evalInPage(expr, { bin, timeout });
  const j = extractJson(raw) || {};
  if (j.__http) throw new Error('下载失败：HTTP ' + j.__http);
  if (j.__json) throw new Error('下载返回了 JSON：' + j.__json);
  if (j.__notzip) throw new Error('下载内容不是 ZIP（' + j.__notzip + ' 字节）');
  if (!j.b64) throw new Error('下载结果为空');
  const buf = Buffer.from(j.b64, 'base64');
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('ZIP 校验失败');
  return { bytes: buf.length, base64: j.b64 };
}

/**
 * 主流程：按 items 逐项取文档。
 * items: [{companyId, companyName, type, mode:'current'|'refresh'}]
 * 返回 { ok, files:[{companyId,companyName,type,version,base64,fileName}], errors:[], logs:[] }
 */
export async function exportReports({ projectId, items, pollMs = 8000, maxWaitMs = 600000, bin, onLog } = {}) {
  ACTIVE += 1;
  try {
    return await digestReports({ projectId, items, pollMs, maxWaitMs, bin, onLog });
  } finally {
    ACTIVE -= 1;
  }
}

async function digestReports({ projectId, items, pollMs = 8000, maxWaitMs = 600000, bin, onLog } = {}) {
  const out = { ok: false, files: [], errors: [], logs: [] };
  const log = (m) => { out.logs.push(m); try { if (onLog) onLog(m); } catch { /* noop */ } };

  // 只对「准备页面」这一步做桥接自愈：下载/轮询中途重试会重复提交作业，不能整体重跑
  let host;
  try {
    host = await prepare(projectId, { bin });
  } catch (e) {
    if (e && e.message === 'BRIDGE_DISCONNECTED') {
      const rec = await recoverBridge({ bin });
      if (!rec.ok) throw e;
      log('浏览器扩展断开了，已自动重连，继续导出…');
      host = await prepare(projectId, { bin });
    } else {
      throw e;
    }
  }

  let before;
  try {
    before = await listReports(projectId, { bin, prepared: true });
  } catch (e) {
    if (e && e.message === 'NOT_LOGGED_IN') {
      const err = new Error('NOT_LOGGED_IN');
      err.detail = e.detail || '';
      throw err;
    }
    // 基线读取失败必须整体中止：refresh 模式没有基线就分不清"旧版本"和
    // "本次刚生成的版本"，猜基线会把旧版下载回来冒充新导出。不得降级继续。
    const err = new Error('读取报告基线失败，已中止导出（refresh 模式需要基线区分新旧版本）：' + String((e && e.detail) || e));
    err.code = 'BASELINE_FAILED';
    throw err;
  }
  log('已读取现有报告 ' + before.length + ' 份');

  // 每项作业记录自己的基线：同公司同类型重复任务时，第二项的基线
  // 已包含第一项生成的版本，不会互相误判旧版本为新导出。
  const baseline = new Map();
  for (const r0 of before) {
    const key = String(r0.companyId) + ':' + Number(r0.type);
    baseline.set(key, Math.max(baseline.get(key) || 0, Number(r0.version) || 0));
  }

  for (let i = 0; i < (items || []).length; i++) {
    const it = items[i];
    const label = TYPE_LABEL[Number(it.type)] || ('类型' + it.type);
    const tag = '[' + (i + 1) + '/' + items.length + '] ' + (it.companyName || it.companyId) + ' · ' + label;
    try {
      let target = null;
      if (it.mode === 'refresh') {
        const jobId = await buildReport(projectId, it.companyId, it.type, { bin });
        const baseKey = String(it.companyId) + ':' + Number(it.type);
        const baseVer = baseline.get(baseKey) || 0;
        log(tag + '：任务 ' + jobId + ' 已提交（基线 V' + baseVer + '），等待生成…');
        const t0 = Date.now();
        while (Date.now() - t0 < maxWaitMs) {
          await new Promise((r) => setTimeout(r, pollMs));
          const rows = await listReports(projectId, { bin, prepared: true });
          const mine = rows.filter((r) => r.companyId === String(it.companyId) && r.type === Number(it.type)
            && r.version > baseVer && r.attachId && r.jobState === 2);
          if (mine.length) {
            mine.sort((a, b) => b.version - a.version);
            target = mine[0];
            // 同类型重复任务：基线提升到本次结果，后续同项不会误判
            baseline.set(baseKey, Math.max(baseVer, Number(target.version) || 0));
            break;
          }
          const anyNew = rows.filter((r) => r.companyId === String(it.companyId) && r.type === Number(it.type) && r.version > baseVer);
          log(tag + '：' + (anyNew.length ? '新版本 V' + anyNew[0].version + ' 生成中…' : '等待调度…'));
        }
        if (!target) throw new Error('等待生成超时（' + Math.round(maxWaitMs / 60000) + ' 分钟）');
      } else {
        const rows = await listReports(projectId, { bin, prepared: true });
        const mine = rows.filter((r) => r.companyId === String(it.companyId) && r.type === Number(it.type)
          && r.attachId && r.jobState === 2);
        if (!mine.length) throw new Error('没有已生成的' + label + '（可能从未生成，请改用「生成新版本」）');
        mine.sort((a, b) => b.version - a.version);
        target = mine[0];
      }

      log(tag + '：下载 V' + target.version);
      const dl = await downloadAttachment(target.attachId, { bin });
      const safeName = String(it.companyName || target.companyName || it.companyId).replace(/[\\/:*?"<>|]/g, '_');
      out.files.push({
        companyId: String(it.companyId),
        companyName: it.companyName || target.companyName,
        type: Number(it.type),
        version: target.version,
        base64: dl.base64,
        fileName: safeName + '-' + label + '-V' + target.version + '.docx',
      });
      log(tag + '：已取回 V' + target.version + '（' + Math.round(dl.bytes / 1024) + ' KB）');
    } catch (e) {
      out.errors.push(tag + '：' + String((e && e.message) || e));
      log(tag + '：失败 ' + String((e && e.message) || e));
    }
  }

  if (host && host.opened && host.openedPage) {
    const cc = await closeOwnedTab(host.openedPage, { bin });
    if (cc.closed) log('已关闭本次导出临时打开的标签页');
  }
  PREP = { projectId: '', promise: null, pages: [] };

  out.ok = out.errors.length === 0 && out.files.length > 0;
  return out;
}

/** 读项目下公司 + 各家可导出的文档类型（reportConfigList 是权威来源）。 */
export async function listCompanies(projectId, { bin, onLog } = {}) {
  return withBridgeRecovery(() => listCompaniesOnce(projectId, { bin }), { bin, onLog });
}

/**
 * 列出项目下所有被评估公司**以及每家在报告系统里配置了哪些报告类型**。
 *
 * 与 listCompanies 的区别：不过滤 types 为空的公司。
 * 「报告比对」要知道某公司有没有配「评估报告」这个类型——没配就该在界面上
 * 说清楚，而不是让用户对着一个必然失败的类型去点「重新生成」。
 *
 * 数据来源是 /ty/api/company/list 的 reportConfigList，这是天源报告系统
 * 自己的配置表，比 report/project 列表更权威：列表为空可能是没生成，
 * 配置为空则是这个类型压根没建。
 */
export async function listCompanyTypes(projectId, { bin, onLog } = {}) {
  return withBridgeRecovery(() => listCompaniesOnce(projectId, { bin, keepEmpty: true }), { bin, onLog });
}

async function listCompaniesOnce(projectId, { bin, keepEmpty = false } = {}) {
  await prepare(projectId, { bin });
  const expr = pageExpr(`
    const res = await __api("/ty/api/company/list", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({projectId: ${JSON.stringify(String(projectId))}})});
    if (res.code !== 200) return JSON.stringify({__err: res.code, msg: res.msg});
    const rows = Array.isArray(res.data) ? res.data : [];
    return JSON.stringify(rows.map(c => ({
      id: String(c.id), name: c.name || c.companyName || '',
      types: [...new Set((c.reportConfigList || []).map(t => Number(t.reportType)).filter(t => [1,2,3].includes(t)))].sort()
    })));
  `);
  const raw = await evalInPage(expr, { bin });
  const j = extractJson('{"r":' + raw + '}');
  const arr = j ? j.r : null;
  if (!Array.isArray(arr)) {
    const e = extractJson(raw);
    if (e && e.__err) {
      const err = new Error('NOT_LOGGED_IN');
      err.detail = e.msg || ('code ' + e.__err);
      throw err;
    }
    throw new Error('公司列表解析失败：' + String(raw).slice(0, 200));
  }
  return keepEmpty ? arr : arr.filter((c) => c.types.length > 0);
}

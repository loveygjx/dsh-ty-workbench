// 天源网页端导出：通过 CDP 驱动已登录的工具箱浏览器，取得原生 docx。
// 与前端的 JSON 重建路径互补：这条路径拿到的是天源系统自己导出的文件（内容 100% 一致）。
import { homedir } from 'node:os';

const PORT = Number(process.env.TIANYUAN_CDP_PORT || 9345);
const BASE = 'https://excel.zhrdc.net';
const TYPE_LABEL = { 1: '评估报告', 2: '评估说明', 3: '长投说明' };
const TYPE_ENTRY = { 1: '报告', 2: '说明', 3: '长投说明' };

export class TyWebError extends Error {}

async function tabs() {
  let r;
  try { r = await fetch(`http://127.0.0.1:${PORT}/json/list`); }
  catch (e) { throw new TyWebError(`工具箱浏览器未运行（端口 ${PORT}）。请先启动评估工具箱浏览器。`); }
  if (!r.ok) throw new TyWebError(`工具箱浏览器无响应（HTTP ${r.status}）`);
  return (await r.json()).filter(t => t.type === 'page');
}

async function attach(preferredId) {
  const list = await tabs();
  const t = list.find(x => x.id === preferredId) || list.find(x => /zhrdc\.net/.test(x.url));
  if (!t) throw new TyWebError('未找到天源标签页。请在工具箱浏览器中打开天源并登录。');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const events = [];
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    if (m.method && m.method.startsWith('Browser.download')) events.push(m);
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new TyWebError('CDP 连接失败')); });
  const evalJs = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r?.exceptionDetails) throw new TyWebError('页面脚本异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
    return r?.result?.value;
  };
  const nav = async (url, wait = 6000) => { await send('Page.navigate', { url }); await new Promise(r => setTimeout(r, wait)); };
  return { evalJs, nav, send, events, close: () => { try { ws.close(); } catch (_) {} } };
}

// 校验工具箱浏览器可用且已登录天源
export async function probe() {
  const c = await attach();
  try {
    await c.nav('https://ty.zhrdc.net/project/my', 5000);
    const url = await c.evalJs('location.href');
    const logged = !/auth\.zhrdc\.net\/login/.test(url);
    let user = null;
    if (logged) { try { user = await c.evalJs(`(document.body.innerText.match(/\\n([\\u4e00-\\u9fa5]{2,4})\\n系统设置/)||[])[1]||null`); } catch (_) {} }
    return { ok: true, logged, user, port: PORT };
  } finally { c.close(); }
}

// 列出项目下所有公司及各自的 报告/说明/长投说明 入口
export async function listCompanies(projectId) {
  if (!/^\d+$/.test(String(projectId))) throw new TyWebError('项目 ID 必须是数字');
  const c = await attach();
  try {
    await c.nav(`${BASE}/ty/operation/${projectId}/equity/list`);
    const raw = await c.evalJs(`
    (function(){
      const rs=[...document.querySelectorAll("table tr")].slice(1);
      const out=[];
      for(const r of rs){
        const td=[...r.querySelectorAll("td")].map(x=>x.innerText.trim());
        if(td.length<3) continue;
        const name=td[2];
        if(!name||name==="AAA") continue;
        const links=[...r.querySelectorAll("button")].map(b=>b.innerText.trim()).filter(t=>["报告","说明","长投说明"].includes(t));
        if(!links.length) continue;
        out.push({code:td[1], name, entries:links});
      }
      return JSON.stringify(out);
    })()`);
    const list = JSON.parse(raw || '[]');
    const codes = list.map(x => x.code);
    return list.map(x => ({
      code: x.code,
      name: x.name,
      types: [1, 2, 3].filter(t => x.entries.includes(TYPE_ENTRY[t])),
    }));
  } finally { c.close(); }
}

// 查询项目现有报告（类型/版本/状态/是否可下载）
export async function listReports(projectId) {
  const c = await attach();
  try {
    await c.nav(`${BASE}/ty/operation/${projectId}/report`);
    const raw = await c.evalJs(`
    (function(){
      const rs=[...document.querySelectorAll("table tr")].slice(1);
      const out=[];
      for(const r of rs){
        const td=[...r.querySelectorAll("td")].map(x=>x.innerText.trim());
        if(td.length<7||!td[1]) continue;
        const name=td[1];
        let type=null;
        if(name.startsWith("评估报告")) type=1;
        else if(name.startsWith("评估说明")) type=2;
        else if(name.startsWith("长投说明")) type=3;
        out.push({name, type, version:td[3], updater:td[4], updatedAt:td[5], status:td[6], downloadable:[...r.querySelectorAll("button")].some(b=>b.innerText.trim()==="下载")});
      }
      return JSON.stringify(out);
    })()`);
    return JSON.parse(raw || '[]');
  } finally { c.close(); }
}

// 触发生成：返回 { ok, generated, version }
export async function generateDoc(projectId, companyName, type, onProgress) {
  const label = TYPE_ENTRY[type];
  const genLabel = type === 1 ? '生成报告' : type === 2 ? '生成说明' : '生成长投说明';
  const c = await attach();
  try {
    onProgress && onProgress('打开公司列表…');
    await c.nav(`${BASE}/ty/operation/${projectId}/equity/list`);
    const clicked = await c.evalJs(`
    (function(){
      const rs=[...document.querySelectorAll("table tr")].slice(1);
      const r=rs.find(x=>x.innerText.includes(${JSON.stringify(companyName)}));
      if(!r) return "NO_COMPANY";
      const b=[...r.querySelectorAll("button")].find(x=>x.innerText.trim()===${JSON.stringify(label)});
      if(!b) return "NO_ENTRY";
      b.click(); return "OK";
    })()`);
    if (clicked !== 'OK') throw new TyWebError(clicked === 'NO_COMPANY' ? `未找到公司：${companyName}` : `该公司没有「${label}」入口`);
    await new Promise(r => setTimeout(r, 9000));

    onProgress && onProgress('确认生成配置…');
    const btn = await c.evalJs(`
    (function(){
      const b=[...document.querySelectorAll("button")].find(x=>x.offsetParent&&x.innerText.trim()===${JSON.stringify(genLabel)});
      if(!b) return "NO_GEN";
      b.click(); return "OK";
    })()`);
    if (btn !== 'OK') throw new TyWebError(`未找到「${genLabel}」按钮，可能该文档尚未配置报告模板`);
    await new Promise(r => setTimeout(r, 6000));

    const dlg = await c.evalJs(`
    (function(){
      const d=[...document.querySelectorAll(".el-message-box,.el-dialog")].filter(x=>x.offsetParent);
      return d.length ? d[0].innerText.replace(/\\s+/g," ").slice(0,120) : "";
    })()`);
    if (!/生成成功|报告任务生成成功/.test(dlg)) throw new TyWebError('生成未成功：' + (dlg || '无响应弹窗'));
    await c.evalJs(`
    (function(){
      const b=[...document.querySelectorAll(".el-message-box button,.el-dialog button")].filter(x=>x.offsetParent).find(x=>x.innerText.trim()==="确定");
      if(b) b.click(); return "OK";
    })()`);
    onProgress && onProgress('已提交生成任务，等待系统出件…');
    return { ok: true };
  } finally { c.close(); }
}

// 轮询直到目标（类型+公司）出现「已生成」且可下载的版本
export async function waitReady(projectId, companyKeyword, type, { timeoutMs = 600000, intervalMs = 6000, onProgress } = {}) {
  const label = TYPE_LABEL[type];
  const started = Date.now();
  const c = await attach();
  try {
    while (Date.now() - started < timeoutMs) {
      await c.nav(`${BASE}/ty/operation/${projectId}/report`, 5000);
      const raw = await c.evalJs(`
      (function(){
        const rs=[...document.querySelectorAll("table tr")].slice(1);
        const out=[];
        for(const r of rs){
          const td=[...r.querySelectorAll("td")].map(x=>x.innerText.trim());
          if(td.length<7||!td[1]) continue;
          out.push({name:td[1], version:td[3], updatedAt:td[5], status:td[6], downloadable:[...r.querySelectorAll("button")].some(b=>b.innerText.trim()==="下载")});
        }
        return JSON.stringify(out);
      })()`);
      const list = JSON.parse(raw || '[]');
      const mine = list.filter(x => x.name.startsWith(label) && x.name.includes(companyKeyword));
      const ready = mine.find(x => x.status === '已生成' && x.downloadable);
      if (ready) return { ok: true, version: ready.version, name: ready.name, updatedAt: ready.updatedAt };
      const pending = mine.some(x => /生成中/.test(x.status));
      onProgress && onProgress(pending ? '系统生成中…' : '等待任务调度…');
      await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new TyWebError('等待生成超时（10 分钟）。请在网页端检查任务状态。');
  } finally { c.close(); }
}

// 下载指定类型+版本（精确匹配，避免下错文件）
export async function downloadDoc(projectId, type, version, destDir) {
  const label = TYPE_LABEL[type];
  const c = await attach();
  try {
    await c.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: destDir, eventsEnabled: true });
    await new Promise(r => setTimeout(r, 400));
    await c.nav(`${BASE}/ty/operation/${projectId}/report`, 5000);
    const clicked = await c.evalJs(`
    (function(){
      const rs=[...document.querySelectorAll("table tr")].slice(1);
      for(const r of rs){
        const td=[...r.querySelectorAll("td")].map(x=>x.innerText.trim());
        if(td.length<7||!td[1]) continue;
        if(!td[1].startsWith(${JSON.stringify(label)})) continue;
        if(${version ? `td[3]!==${JSON.stringify(String(version))}` : 'false'}) continue;
        if(td[6]!=="已生成") continue;
        const b=[...r.querySelectorAll("button")].find(x=>x.innerText.trim()==="下载");
        if(b){ b.click(); return JSON.stringify({ok:true,name:td[1],version:td[3]}); }
      }
      return JSON.stringify({ok:false,reason:"未找到可下载项"});
    })()`);
    const r = JSON.parse(clicked);
    if (!r.ok) throw new TyWebError(r.reason);
    // 等下载完成
    const t0 = Date.now();
    let file = null;
    while (Date.now() - t0 < 120000) {
      await new Promise(res => setTimeout(res, 700));
      for (const e of c.events) {
        if (e.method === 'Browser.downloadProgress' && e.params.state === 'completed' && e.params.filePath) file = e.params.filePath;
      }
      if (file) break;
    }
    if (!file) {
      const begin = c.events.find(e => e.method === 'Browser.downloadWillBegin');
      if (begin) throw new TyWebError('下载未完成，可能被浏览器拦截：' + begin.params.suggestedFilename);
      throw new TyWebError('下载超时');
    }
    return { ok: true, file, name: r.name, version: r.version };
  } finally { c.close(); }
}

export { TYPE_LABEL, TYPE_ENTRY };

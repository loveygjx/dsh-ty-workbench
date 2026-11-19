// 天源网页会话层：纯 Host 侧 Cookie 直调 excel.zhrdc.net 接口（原生报告生成/下载）。
// Cookie 来源暂不绑定：由调用方（路由）注入 setSession/clearSession；本层只负责使用与校验。
import { homedir } from 'node:os';

const AUTH_BASE = 'https://auth.zhrdc.net';
const EXCEL_BASE = 'https://excel.zhrdc.net';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

export class TySessionError extends Error {
  constructor(msg, code) { super(msg); this.code = code || 'TY_SESSION'; }
}

let cookie = { tk: '', sid: '' };   // 仅进程内存，不落盘
let meta = { user: null, checkedAt: 0 };

export function setSession({ tk, sid, user }) {
  cookie = { tk: String(tk || ''), sid: String(sid || '') };
  meta = { user: user || null, checkedAt: Date.now() };
}
export function clearSession() { cookie = { tk: '', sid: '' }; meta = { user: null, checkedAt: 0 }; }
export function hasSession() { return !!(cookie.tk || cookie.sid); }
export function sessionUser() { return meta.user; }

function cookieHeader() {
  const parts = [];
  if (cookie.tk) parts.push('tk=' + cookie.tk);
  if (cookie.sid) parts.push('sid=' + cookie.sid);
  return parts.join('; ');
}

// 统一请求：返回业务 JSON；403 未登录抛 TySessionError('UNAUTHENTICATED')
export async function tyApi(path, { method = 'GET', body, timeoutMs = 30000 } = {}) {
  if (!hasSession()) throw new TySessionError('尚未登录天源网页（请先在工作台完成扫码登录）', 'UNAUTHENTICATED');
  const url = path.startsWith('http') ? path : EXCEL_BASE + path;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method,
      headers: {
        'Cookie': cookieHeader(),
        'User-Agent': UA,
        'Accept': 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch (_) {
      if (r.status >= 400) throw new TySessionError(`天源接口 HTTP ${r.status}`, 'HTTP_' + r.status);
      throw new TySessionError('天源接口返回非 JSON', 'BAD_RESPONSE');
    }
    if (j && (j.code === 403 || /未登录/.test(j.msg || ''))) {
      clearSession();
      throw new TySessionError('天源网页登录已失效，请重新扫码', 'UNAUTHENTICATED');
    }
    return j;
  } finally { clearTimeout(timer); }
}

// 登录态探测：读账号接口
export async function probeSession() {
  if (!hasSession()) return { ok: false, logged: false, reason: 'no_cookie' };
  try {
    const j = await tyApi('/ty/api/page_data', { timeoutMs: 15000 });
    if (j && j.code === 200) {
      const u = j.data && (j.data.user || j.data.account || null);
      meta = { user: (u && (u.userName || u.name || u.fullName)) || meta.user, checkedAt: Date.now() };
      return { ok: true, logged: true, user: meta.user };
    }
    return { ok: true, logged: false, reason: j.msg || 'code_' + j.code };
  } catch (e) {
    return { ok: false, logged: false, reason: String(e.message || e) };
  }
}

// 报告列表（原生）——返回统一形态
export async function listReports(projectId) {
  const j = await tyApi(`/ty/api/report/project?pageNum=1&limit=100&projectId=${encodeURIComponent(projectId)}&reportType=&companyId=`);
  const rows = Array.isArray(j.data) ? j.data : (j.data && j.data.list) || [];
  return rows.map(x => ({
    reportId: x.id,
    companyId: x.companyId,
    companyName: x.companyName,
    type: x.reportType,            // 1 报告 2 说明 3 长投说明
    version: x.version,
    status: x.jobState,            // 2=已生成（观察值）；其余原样返回
    jobState: x.jobState,
    preferFlag: x.preferFlag,
    attachId: x.attachId || null,
    updatedAt: x.createTime,
    creator: x.createUserFullName || x.createUserName,
    downloadable: !!(x.attachId),
  }));
}

// 触发生成（原生）
export async function buildReport(projectId, companyId, type) {
  const j = await tyApi(`/ty/api/report/build/${encodeURIComponent(projectId)}/${encodeURIComponent(companyId)}/${Number(type)}`, { method: 'POST' });
  if (j && j.code === 200) return { ok: true, jobId: j.data, raw: j };
  throw new TySessionError('生成任务提交失败：' + ((j && (j.msg || j.data)) || '未知'), 'BUILD_FAILED');
}

// 下载（原始字节）：不经过 tyApi 的 JSON 解析
export async function downloadAttachmentRaw(attachId) {
  if (!hasSession()) throw new TySessionError('尚未登录天源网页', 'UNAUTHENTICATED');
  const r = await fetch(`${EXCEL_BASE}/ty/api/attach/${encodeURIComponent(attachId)}/download`, {
    headers: { 'Cookie': cookieHeader(), 'User-Agent': UA },
    signal: AbortSignal.timeout(180000),
  });
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('json')) {
    const j = await r.json().catch(() => ({}));
    if (j.code === 403) { clearSession(); throw new TySessionError('登录已失效', 'UNAUTHENTICATED'); }
    throw new TySessionError('下载失败：' + (j.msg || '未知'), 'DOWNLOAD_FAILED');
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 4 || buf.slice(0, 2).toString('hex') !== '504b') {
    throw new TySessionError('下载内容不是有效 docx（缺 ZIP 头）', 'NOT_DOCX');
  }
  return { buf, contentType: ct };
}

// 本地 docx 完整性校验（ZIP 结构 + 必需部件），下载落盘前调用
export async function validateDocx(buf) {
  if (!buf || buf.length < 4 || buf.slice(0, 2).toString('hex') !== '504b') return { ok: false, reason: '缺 ZIP 头' };
  try {
    const { unzip } = await import('node:zlib');
    // 快速结构校验：找 End of Central Directory 并解析条目数
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) return { ok: false, reason: '缺 ZIP EOCD' };
    const nEntries = buf.readUInt16LE(eocd + 10);
    if (nEntries < 5) return { ok: false, reason: `ZIP 条目过少(${nEntries})` };
    // 用 zlib 解压验证第一个 local file header 的 method=8 数据完整性成本高，改为抽查 [Content_Types].xml 存在
    const head = buf.slice(0, Math.min(buf.length, 4096)).toString('latin1');
    if (!/Content_Types\.xml/i.test(head) && !buf.includes(Buffer.from('[Content_Types].xml'))) {
      return { ok: false, reason: '缺 [Content_Types].xml（非 OOXML）' };
    }
    void unzip;
    return { ok: true, entries: nEntries };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
}

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

// 报告列表（原生）——返回统一形态。自适应分页：
// 第一页满 limit 时继续翻页，直到拿到不足一页的数据或服务端给出明确的
// total/pages 上限；绝不只信第一页，避免 limit 之上的新版本被漏掉。
const LIST_PAGE_SIZE = 200;
const LIST_MAX_PAGES = 50;   // 50×200=10000 份，超出的项目不该存在，防失控

export async function listReports(projectId) {
  const pid = encodeURIComponent(projectId);
  const all = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page++) {
    const j = await tyApi(`/ty/api/report/project?pageNum=${page}&limit=${LIST_PAGE_SIZE}&projectId=${pid}&reportType=&companyId=`);
    // 业务错误必须抛出，不得当空列表吞掉——基线快照靠它区分新旧版本，
    // 静默返回 [] 会把任何旧版本都当成"新版本"（正是审查问题 1）。
    if (j && j.code !== 200) throw new TySessionError('读取报告列表失败：' + (j.msg || ('code ' + j.code)), 'LIST_FAILED');
    const rows = Array.isArray(j.data) ? j.data : (j.data && j.data.list) || [];
    all.push(...rows);
    // 页不满 → 已到末页。若服务端在 data 上给出 total/pages 且已取满，也停。
    if (rows.length < LIST_PAGE_SIZE) break;
    const meta = j.data && (j.data.total !== undefined ? Number(j.data.total) : (j.data.pages !== undefined ? Number(j.data.pages) * LIST_PAGE_SIZE : null));
    if (meta !== null && Number.isFinite(meta) && all.length >= meta) break;
    if (page === LIST_MAX_PAGES) throw new TySessionError(`报告列表超过 ${LIST_MAX_PAGES} 页仍未取完，中止以防失控`, 'LIST_OVERFLOW');
  }
  return all.map(x => ({
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

// 本地 docx 完整性校验（完整解析 ZIP Central Directory + 校验 DOCX 必需部件），
// 下载落盘前调用。不信任扩展名与进程退出码：必须能解出 [Content_Types].xml、
// _rels/.rels、word/document.xml 三个部件，且三者均可完整 inflate（CRC 校验交给
// inflate 的合法流检查，损坏 ZIP 在这里直接报错而不是落盘后才发现）。
const DOCX_REQUIRED_PARTS = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'];

export async function validateDocx(buf) {
  if (!buf || !(buf instanceof Buffer) && !(buf instanceof Uint8Array)) return { ok: false, reason: '内容为空' };
  const u8 = buf instanceof Buffer ? buf : Buffer.from(buf);
  if (u8.length < 4 || u8.slice(0, 2).toString('hex') !== '504b') return { ok: false, reason: '缺 ZIP 头（不是 docx/zip）' };
  try {
    const zip = await parseZipCentralDirectory(u8);
    if (!zip.entries.length) return { ok: false, reason: 'ZIP 无条目' };
    if (zip.entries.length < 3) return { ok: false, reason: `ZIP 条目过少(${zip.entries.length})` };
    const names = new Set(zip.entries.map(e => e.name));
    for (const part of DOCX_REQUIRED_PARTS) {
      if (!names.has(part)) return { ok: false, reason: `缺必需部件 ${part}（非 OOXML docx）` };
    }
    // 解压三个必需部件，任何解包失败/截断都会抛错 → 判坏
    for (const part of DOCX_REQUIRED_PARTS) {
      const entry = zip.entries.find(e => e.name === part);
      try {
        const data = await inflateEntry(u8, entry);
        if (!data.length) return { ok: false, reason: `${part} 解压后为空` };
        if (part === 'word/document.xml') {
          const head = data.subarray(0, 256).toString('utf8');
          if (!/<\?xml|<w:document/i.test(head)) return { ok: false, reason: 'word/document.xml 不是 Word 文档 XML' };
        }
      } catch (e) {
        return { ok: false, reason: `${part} 解压失败（ZIP 数据损坏）：${String(e.message || e).slice(0, 120)}` };
      }
    }
    return { ok: true, entries: zip.entries.length };
  } catch (e) {
    return { ok: false, reason: 'ZIP 结构解析失败：' + String(e.message || e).slice(0, 160) };
  }
}

// 解析 ZIP End of Central Directory + Central Directory，返回条目表。
// 只做结构解析（偏移/长度/压缩方法），不做 CRC——必需部件的完整 inflate 已足够。
async function parseZipCentralDirectory(u8) {
  const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const CD_SIG = 0x02014b50;
  // 从尾部找 EOCD 签名（注释最长 65535 字节，但也得至少给 CD 留地方）
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
    if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('缺 ZIP EOCD');
  const totalEntries = u8.readUInt16LE(eocd + 10);
  const cdSize = u8.readUInt32LE(eocd + 12);
  const cdOffset = u8.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > u8.length) throw new Error('Central Directory 越界（截断的 ZIP）');
  // zip64 粗检：条目数/偏移达上限且存在 zip64 EOCD 记录时放弃精细解析，直接按"非标准"拒
  if (totalEntries === 0xffff || cdOffset === 0xffffffff) throw new Error('ZIP64 结构不受支持');
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > u8.length) throw new Error('Central Directory 条目截断');
    const sig = u8.readUInt32LE(p);
    if (sig !== CD_SIG) throw new Error(`Central Directory 第 ${i + 1} 条签名异常`);
    const method = u8.readUInt16LE(p + 10);
    const compSize = u8.readUInt32LE(p + 20);
    const nameLen = u8.readUInt16LE(p + 28);
    const extraLen = u8.readUInt16LE(p + 30);
    const commentLen = u8.readUInt16LE(p + 32);
    const localOffset = u8.readUInt32LE(p + 42);
    const name = u8.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, totalEntries };
}

// 按 Central Directory 条目定位 local file header 并 inflate。
// 支持 method 0（stored）与 8（deflate，docx 标准）；其余方法判坏。
async function inflateEntry(u8, entry) {
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`不支持的压缩方法 ${entry.method}`);
  const lo = entry.localOffset;
  if (lo + 30 > u8.length) throw new Error('Local header 越界');
  if (u8.readUInt32LE(lo) !== 0x04034b50) throw new Error('Local file header 签名异常');
  const nameLen = u8.readUInt16LE(lo + 26);
  const extraLen = u8.readUInt16LE(lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;
  if (dataStart + entry.compSize > u8.length) throw new Error('条目数据截断');
  const raw = u8.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return Buffer.from(raw);
  const { inflateRawSync } = await import('node:zlib');
  return inflateRawSync(raw);
}

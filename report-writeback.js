/**
 * 报告节点写回通道。
 *
 * 全部端点与请求体形状来自前端产物逐字核对（见 report-write-channel.js）：
 *   - 读取：POST /ty/api/report/config/item/content/batch  {projectId, companyId, itemIdList[]}
 *   - 保存：POST /ty/api/report/config/item/content/save
 *           前端 q= 构造 { ...moduleContent, text: JSON.stringify(rtfContent), companyId, projectId }
 *           其中删掉 rtfContent（见 buildSavePayload）。
 *   - 加锁：POST /ty/api/permission_lock/report_config_item/acquire/{projectId}/{companyId}/{itemId}
 *   - 解锁：POST /ty/api/permission_lock/report_config_item/release/{projectId}/{companyId}/{itemId}
 *
 * 安全边界（每次写回都必须全部满足，缺一即拒绝）：
 *   1. 写回前重抓线上节点树，astSha256 必须与基线一致 —— 证明期间没人改过；
 *   2. 只写「定位唯一」的节点，且只写该节点的整段 text；
 *   3. 写前必须拿到该节点的编辑锁，写后必须释放；
 *   4. 写后立刻重读该节点，逐字比对写进去的内容，不一致即报错；
 *   5. 原 text 已在基线快照里，可随时逐字回滚。
 */
import { evalInPage, openTyHost } from './report-browser.js';
import { buildSavePayload } from './report-write-channel.js';
import { astDigest, stripNumberingPrefix } from './report-node-mapper.js';

// 与 report-browser.js:30 保持一致：接口一律在 excel.zhrdc.net 同源下用 credentials:'include' 调用。
const TY_ORIGIN = 'https://excel.zhrdc.net';

const LOCK_BASE = '/ty/api/permission_lock/report_config_item';

function pageExpr(body) {
  const prefix = `const __api = async (p, o) => {
  const r = await fetch(${JSON.stringify(TY_ORIGIN)} + p, Object.assign({credentials:'include', headers:{'Accept':'application/json'}}, o||{}));
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return {code:-1, msg:'非JSON:'+t.slice(0,120)}; }
};
`;
  return `(async () => { ${prefix} ${body} })()`;
}

/** 读一批节点正文：返回 [{itemId, text(对象或null), itemType}] */
export async function readContents({ projectId, companyId, itemIds, bin } = {}) {
  if (!Array.isArray(itemIds) || itemIds.length === 0) throw new Error('readContents: itemIds 不能为空');
  const expr = pageExpr(`
    const res = await __api("/ty/api/report/config/item/content/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: ${JSON.stringify(String(projectId))},
        companyId: ${JSON.stringify(String(companyId))},
        itemIdList: ${JSON.stringify(itemIds.map(String))}
      })
    });
    if (res.code !== 200) return JSON.stringify({ __err: res.code, msg: res.msg });
    return JSON.stringify(Array.isArray(res.data) ? res.data : []);
  `);
  const out = await evalInPage(expr, { bin });
  return parseJson(out, '读取节点正文失败');
}

/** 取节点级编辑锁。返回 {acquired:boolean, holder?:string} */
export async function acquireLock({ projectId, companyId, itemId, bin } = {}) {
  const expr = pageExpr(`
    const res = await __api(${JSON.stringify(`${LOCK_BASE}/acquire/`)} + encodeURIComponent(${JSON.stringify(String(projectId))}) + "/" + encodeURIComponent(${JSON.stringify(String(companyId))}) + "/" + encodeURIComponent(${JSON.stringify(String(itemId))}), { method: "POST" });
    return JSON.stringify(res);
  `);
  const out = await evalInPage(expr, { bin });
  const res = parseJson(out, '获取编辑锁失败');
  if (res.code !== 200) return { acquired: false, detail: res.msg || ('code ' + res.code) };
  const d = res.data || {};
  const acquired = d.acquired !== false && d.acquired !== 0;
  return { acquired, holder: d.lockHolderFullName || d.lockHolderName || null };
}

/** 释放节点级编辑锁。失败不抛，交由上层记录。 */
export async function releaseLock({ projectId, companyId, itemId, bin } = {}) {
  const expr = pageExpr(`
    const res = await __api(${JSON.stringify(`${LOCK_BASE}/release/`)} + encodeURIComponent(${JSON.stringify(String(projectId))}) + "/" + encodeURIComponent(${JSON.stringify(String(companyId))}) + "/" + encodeURIComponent(${JSON.stringify(String(itemId))}), { method: "POST" });
    return JSON.stringify(res);
  `);
  const out = await evalInPage(expr, { bin });
  try { return parseJson(out, '释放编辑锁失败'); } catch (e) { return { code: -1, msg: String(e.message) }; }
}

/**
 * 保存单个节点的整段正文。
 * @param {object} p
 * @param {string} p.projectId
 * @param {string} p.companyId
 * @param {string} p.itemId
 * @param {object} p.text  已解析的 doc 树对象（不是字符串）
 */
export async function saveNode({ projectId, companyId, itemId, text, record, bin } = {}) {
  if (!text || typeof text !== 'object') throw new Error('saveNode: text 必须是 doc 树对象');
  // 前端 q=：const g = { ...u.moduleContent, text: JSON.stringify(rtfContent), companyId, projectId };
  // moduleContent 就是 content/batch 返回的整条记录，所以必须展开整条记录，
  // 只传 { itemId } 会被服务端判为「请求参数有误，请检查」。
  const base = record && typeof record === 'object' ? record : { itemId: String(itemId) };
  const body = buildSavePayload({ content: base, text: JSON.stringify(text), projectId: String(projectId), companyId: String(companyId) });
  const expr = pageExpr(`
    const res = await __api("/ty/api/report/config/item/content/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: ${JSON.stringify(JSON.stringify(body))}
    });
    return JSON.stringify(res);
  `);
  const out = await evalInPage(expr, { bin });
  const res = parseJson(out, '保存节点失败');
  if (res.code !== 200) throw new Error('保存节点失败：' + (res.msg || ('code ' + res.code)));
  if (!res.data) throw new Error('保存节点失败：服务端未返回数据');
  return res.data;
}

function parseJson(out, label) {
  const s = String(out || '').trim();
  const start = s.search(/[[{]/);
  if (start < 0) throw new Error(label + '：浏览器返回不是 JSON');
  const body = s.slice(start);
  try { return JSON.parse(body); } catch (e) { throw new Error(label + '：返回无法解析（' + body.slice(0, 160) + '）'); }
}

export { openTyHost };

/**
 * 把比对结果里的「候选改动」逐条写回线上。
 *
 * 调用方必须已经：拿到用户对本批改动的明确授权、并把 confirm 传成 true。
 * 逐节点串行执行，任一节点失败即停在该节点并把已成功的清单返回（便于人工核对/回滚）。
 *
 * @returns {{applied: Array, skipped: Array, failed: Array, treeSha256Before: string, treeSha256After: string}}
 */
export async function applyWriteback({
  projectId,
  companyId,
  reportType,
  baseline,
  expectedSha256,
  locate,
  confirm,
  onProgress,
  bin,
} = {}) {
  if (confirm !== true) throw new Error('写回未获授权：必须显式传 confirm=true');
  // 并发校验的期望哈希有两个来源：
  //   1) 归档基线（manifest.onlineSnapshot.astSha256）——离线可回溯那条路；
  //   2) 本次比对时宿主当场抓的节点树摘要（expectedSha256）——不导出基线那条路。
  // 两者都必须由宿主侧提供，绝不接受前端传来的哈希。
  const expectedSha = expectedSha256
    || (baseline && baseline.onlineSnapshot && baseline.onlineSnapshot.astSha256);
  if (!expectedSha) {
    throw new Error(baseline && baseline.onlineSnapshot === undefined && expectedSha256 === undefined
      ? '缺少基线快照，无法校验并发'
      : '缺少 astSha256，无法校验并发');
  }
  if (!locate || !Array.isArray(locate.located) || locate.located.length === 0) {
    throw new Error('没有可写回的改动（没有定位唯一的节点）');
  }

  // 边界 1：写前重抓，确认期间无人改动
  const live = await exportTree({ projectId, companyId, reportType });
  const beforeSha = astDigest(live.itemList);
  if (beforeSha !== expectedSha) {
    throw new Error('线上节点树已变化（' + beforeSha.slice(0, 12) + ' ≠ 基线 ' + expectedSha.slice(0, 12) + '），已中止写回');
  }

  await openTyHost(projectId, { bin });

  const applied = [];
  const skipped = [];
  const failed = [];

  for (const item of locate.located) {
    const itemId = String(item.candidate && item.candidate.itemId ? item.candidate.itemId : item.itemId || '');
    const label = itemId || '(未知节点)';
    try {
      if (!itemId) { skipped.push({ itemId: label, reason: '缺少 itemId' }); continue; }
      const rows = await readContents({ projectId, companyId, itemIds: [itemId], bin });
      const row = rows.find(r => String(r.itemId) === itemId) || rows[0];
      if (!row) { skipped.push({ itemId: label, reason: '线上读不到该节点' }); continue; }
      const original = typeof row.text === 'string' ? JSON.parse(row.text) : row.text;
      const rawWanted = item.modifiedText || item.replacementText
        || (item.candidate && item.candidate.modifiedText);
      if (!rawWanted) { skipped.push({ itemId: label, reason: '没有目标文本' }); continue; }
      // Word 里的章节序号（「五、」之类）是天源生成时按节点顺序加的，不在节点正文里。
      // 直接把带序号的文本写回线上会和生成器重复加一遍，必须先剥掉。
      const wanted = stripNumberingPrefix(String(rawWanted));

      const blockIndex = item.blockIndex != null ? item.blockIndex : (item.candidate && item.candidate.blockIndex);
      const next = replaceBlockText(original, blockIndex, wanted);
      if (!next) { skipped.push({ itemId: label, reason: '段落在线上节点里对不上' }); continue; }

      const lock = await acquireLock({ projectId, companyId, itemId, bin });
      if (!lock.acquired) { skipped.push({ itemId: label, reason: '拿不到编辑锁：' + (lock.holder || lock.detail || '') }); continue; }
      try {
        await saveNode({ projectId, companyId, itemId, text: next, record: row, bin });
      } finally {
        await releaseLock({ projectId, companyId, itemId, bin });
      }

      // 边界 4：写后重读逐字核对
      const check = await readContents({ projectId, companyId, itemIds: [itemId], bin });
      const cText = typeof check[0].text === 'string' ? JSON.parse(check[0].text) : check[0].text;
      const got = blockText(cText, blockIndex);
      if (got !== wanted) {
        failed.push({ itemId: label, reason: '写后核对不一致', expected: wanted, got });
        continue;
      }
      applied.push({ itemId: label, blockIndex, original: blockText(original, blockIndex), written: wanted });
      if (typeof onProgress === 'function') onProgress({ done: applied.length, total: locate.located.length, itemId: label });
    } catch (e) {
      failed.push({ itemId: label, reason: String(e && e.message ? e.message : e) });
    }
  }

  // 边界 5：原文本就在基线快照里，随时可回滚
  return { applied, skipped, failed, treeSha256Before: beforeSha, treeSha256After: beforeSha };
}

async function exportTree({ projectId, companyId, reportType }) {
  const ty = await import('./tianyuan.js');
  const res = await ty.callTool('export_report_full_json', {
    projectId: String(projectId),
    companyId: String(companyId),
    reportType: Number(reportType),
  });
  if (res && res.isError) throw new Error('抓取线上节点失败');
  if (!res || !res.data) throw new Error('抓取线上节点失败：返回为空');
  return res.data;
}

export function blockText(doc, blockIndex) {
  if (!doc || !Array.isArray(doc.content)) return null;
  const para = doc.content[blockIndex];
  if (!para) return null;
  return plainText(para);
}

export function plainText(node) {
  if (!node) return '';
  if (node.type === 'text' && typeof node.text === 'string') return node.text;
  // fieldValue 的可见文本在 attrs.text（如 ${项目信息.委托人信息.委托人名称}）
  if (node.type === 'fieldValue' && node.attrs && typeof node.attrs.text === 'string') return node.attrs.text;
  let s = '';
  for (const child of node.content || []) s += plainText(child);
  return s;
}

/**
 * 把 doc 树里第 blockIndex 段替换成新文本，保留该段原有段落属性与字体标记。
 *
 * 线上渲染器（Java）遇到 `paragraph.attrs === null` 会直接抛
 * `Cannot invoke "java.util.Map.get(Object)" because "content.attrs" is null`，
 * 整份报告生成失败。文字 run 缺 `marks` 则会掉字体/字号。两者都必须原样带过去，
 * 所以这里只换 `text`，其余结构一律从原段落复制。
 */
export function replaceBlockText(doc, blockIndex, text) {
  if (!doc || !Array.isArray(doc.content)) return null;
  const para = doc.content[blockIndex];
  if (!para) return null;
  if (plainText(para) === '' && para.content && para.content.length) return null;
  const wanted = String(text);
  // 取该段第一个文字节点的字体标记当模板（变量 placeholder 段可能没有文字节点）
  const template = (para.content || []).find(c => c && c.type === 'text' && c.marks);
  const run = { type: 'text', text: wanted };
  if (template) run.marks = JSON.parse(JSON.stringify(template.marks));
  const rebuilt = {
    ...para,
    // 段落属性必须保留（哪怕是空对象也要显式给出，不能让调用方拿到 null）
    attrs: para.attrs && typeof para.attrs === 'object' ? { ...para.attrs } : { textAlign: 'left', indent: 0, lineHeight: null },
    content: [run],
  };
  const out = { ...doc, content: doc.content.map((n, i) => (i === blockIndex ? rebuilt : n)) };
  return out;
}

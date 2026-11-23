// 线上节点「完整版」内容快照：为基线补上一份真正可用于回溯的节点正文。
//
// 为什么需要它（血泪教训）：
//   MCP 的 export_report_full_json 返回的 itemContent.text 是「精简版」——
//   {"type":"paragraph","content":[{"type":"text","text":"…"}]}
//   它剥掉了 attrs（对齐/缩进/行距）和 marks（字体/字号）。拿它写回天源会直接
//   让报告生成失败（content.attrs is null）。
//   网页 content/batch 返回的才是「完整版」：
//   {"type":"paragraph","attrs":{...},"content":[{"type":"text","marks":[...],"text":"…"}]}
//
// 所以基线里要单独存一份 content/batch 抓下来的东西，配一个独立的摘要，
// 才能在不联线的情况下回答「这个节点当初长什么样」。
//
// 证据边界：
//   - 本文件只做「同批次」声明：这份完整版是在归档该份 report.docx 的同一次
//     导出里抓的。不声明它与某个 report version 逐字节对应。
//   - 抓取失败不影响导出，也不影响简化版快照（online-snapshot.json）——
//     基线降级为「没有完整版」，这一项如实写进 manifest，不假装有。

import { createHash } from 'node:crypto';
import { stableStringify } from './report-node-mapper.js';

/** content/batch 单次请求的节点数上限（前端实测 40 稳定，不追求更大）。 */
export const FULL_CONTENT_CHUNK = 40;
/** 允许抓取的节点总数上限，防止异常节点树把内存吃穿。 */
export const MAX_FULL_ITEMS = 200000;
/** 单个节点 text 的字节上限（正常节点几 KB，超限说明结构异常）。 */
export const MAX_ITEM_TEXT = 4 * 1024 * 1024;
/** 整份完整版快照的字节上限。 */
export const MAX_FULL_PAYLOAD = 64 * 1024 * 1024;
export const FULL_FILE = 'online-full.json';

/** 只认 basicInfo/调用方给出的三个身份字段，别的一概不信。 */
function identityOf(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const identity = { projectId: input.projectId, companyId: input.companyId, reportType: input.reportType };
  for (const [key, value] of Object.entries(identity)) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    identity[key] = String(value);
  }
  return identity;
}

/** text 归一成字符串：服务端有时给对象、有时给 JSON 字符串，两种都要原样保住。 */
function normalizeText(text) {
  if (typeof text === 'string') return text;
  if (text && typeof text === 'object') return JSON.stringify(text);
  return null;
}

/**
 * 用 content/batch 抓回来的节点内容构造完整版快照。
 *
 * @param {{
 *   items?: Array<{ itemId?: unknown, itemType?: unknown, text?: unknown }>,
 *   expected?: { projectId?: unknown, companyId?: unknown, reportType?: unknown },
 *   capturedAt?: string
 * }} input
 * @returns {{ payload: object, descriptor: object }}
 */
export function buildOnlineFull({ items, expected = {}, capturedAt, expectedItemCount } = {}) {
  const identity = identityOf(expected);
  if (!identity) throw new Error('完整版快照缺少身份信息（projectId/companyId/reportType）');
  if (!Array.isArray(items)) throw new Error('完整版快照缺少节点内容');
  if (items.length > MAX_FULL_ITEMS) throw new Error('节点数量超过上限，完整版快照未保存');
  const seen = new Set();
  const normalized = [];
  let bytes = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object') throw new Error('完整版快照含非法节点');
    const itemId = item.itemId === null || item.itemId === undefined ? '' : String(item.itemId);
    if (!itemId) throw new Error('完整版快照含缺少 itemId 的节点');
    if (seen.has(itemId)) throw new Error('完整版快照含重复节点：' + itemId);
    seen.add(itemId);
    const text = normalizeText(item.text);
    if (text === null) throw new Error('节点 ' + itemId + ' 缺少正文内容');
    if (Buffer.byteLength(text, 'utf8') > MAX_ITEM_TEXT) throw new Error('节点 ' + itemId + ' 正文超过上限');
    const itemType = item.itemType === null || item.itemType === undefined ? null : Number(item.itemType);
    normalized.push({ itemId, itemType: Number.isFinite(itemType) ? itemType : null, text });
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_FULL_PAYLOAD) throw new Error('完整版快照超过体积上限，未保存');
  }
  if (!normalized.length) throw new Error('完整版快照为空');
  // 抓回来的节点数必须与计划抓的一致，否则说明有节点读取失败，
  // 存一份残缺的完整版比不存更危险（回溯时会以为原文就是这样）。
  if (expectedItemCount != null && normalized.length !== Number(expectedItemCount)) {
    throw new Error('完整版快照节点数不符（' + normalized.length + ' ≠ ' + expectedItemCount + '），可能有节点读取失败');
  }
  // 按 itemId 排序后算摘要：抓取顺序（分片并发）不影响摘要，只有内容影响。
  normalized.sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
  const captured = typeof capturedAt === 'string' && capturedAt ? capturedAt : new Date().toISOString();
  const payload = { schemaVersion: 1, capturedAt: captured, identity, items: normalized };
  const descriptor = {
    status: 'same_batch',
    // 与 online-snapshot.json 一致的口径：只证明同批次，不证明同版本。
    claim: 'full node content captured in the same export run as report.docx; not a per-version proof',
    capturedAt: captured,
    identity,
    itemCount: normalized.length,
    astSha256: digestOf(payload),
    file: FULL_FILE,
  };
  return { payload, descriptor };
}

/** 完整版快照的内容摘要：对 {itemId, itemType, text} 三元组做稳定序列化后 sha256。 */
export function digestOf(payload) {
  const items = payload && Array.isArray(payload.items) ? payload.items : [];
  return createHash('sha256').update(stableStringify(items)).digest('hex');
}

/**
 * 从一份 ReportFullExportVO 里挑出「有正文、值得抓完整版」的节点 id。
 *
 * 只取有 itemContent 的节点：没有 itemContent 的节点（目录、占位符之类）在
 * content/batch 里也没有正文可抓。附件类（itemType 1）跳过——它的正文是二进制，
 * 抓回来也不能用来写回。
 *
 * 纯函数，不碰网络，方便单测。
 */
export function collectContentItemIds(document) {
  const ids = [];
  const seen = new Set();
  if (!document || typeof document !== 'object') return ids;
  const stack = Array.isArray(document.itemList) ? [...document.itemList] : [];
  let guard = 0;
  while (stack.length) {
    if ((guard += 1) > MAX_FULL_ITEMS) throw new Error('节点数量超过上限，完整版快照未保存');
    const item = stack.pop();
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item.subItemList) && item.subItemList.length) stack.push(...item.subItemList);
    const itemType = Number(item.itemType);
    if (itemType === 1) continue;
    const content = item.itemContent;
    if (!content || typeof content !== 'object') continue;
    // 内层 itemId 与外层 id 不一致时不可信（同 report-node-mapper 的判定）。
    if (content.itemId !== null && content.itemId !== undefined && String(content.itemId) !== String(item.id)) continue;
    const id = item.id === null || item.id === undefined ? '' : String(item.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** 校验一份已读出的完整版快照与其清单描述是否自洽。不自洽就抛错——宁拒绝，不猜。 */
export function verifyOnlineFull(payload, descriptor) {
  if (!descriptor || typeof descriptor !== 'object') throw new Error('完整版快照缺少清单描述');
  if (descriptor.file !== FULL_FILE) throw new Error('完整版快照清单文件名不匹配');
  if (typeof descriptor.astSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.astSha256)) throw new Error('完整版快照摘要非法');
  if (!Number.isSafeInteger(descriptor.itemCount) || descriptor.itemCount <= 0) throw new Error('完整版快照节点数非法');
  if (typeof descriptor.capturedAt !== 'string') throw new Error('完整版快照时间非法');
  if (!descriptor.identity || typeof descriptor.identity !== 'object') throw new Error('完整版快照身份非法');
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items)) throw new Error('完整版快照内容非法');
  if (payload.items.length !== descriptor.itemCount) throw new Error('完整版快照节点数与清单不一致');
  if (digestOf(payload) !== descriptor.astSha256) throw new Error('完整版快照摘要与清单不一致');
  const identity = identityOf(payload.identity);
  if (!identity) throw new Error('完整版快照内容缺少身份信息');
  for (const key of ['projectId', 'companyId', 'reportType']) {
    if (identity[key] !== String(descriptor.identity[key])) throw new Error('完整版快照身份与清单不一致：' + key);
  }
  return payload;
}

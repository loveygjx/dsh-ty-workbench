/**
 * 报告节点候选定位（纯离线、只读、极保守）。
 *
 * 本模块不访问网络、不注册任何 HTTP 路由、不实现回写。它只回答一个问题：
 * 「这段改了字的正文段落，在天源报告 JSON 的快照里，最可能是哪一个节点？」
 * 即使回答成功，也只是**给人复核的候选线索**，绝不构成写回许可。
 *
 * 设计原则（每条都由测试锁定）：
 * 1. 默认拒绝：没有可信来源显式提供「版本匹配 + 快照完整」证据时，一律 refused。
 *    evidence 由调用方在可信边界内构造；本模块无法防伪，因此结果不得被当作授权。
 * 2. 身份必须对上：项目/公司/报告类型三者与快照身份完全一致，否则 refused。
 * 3. AST 必须对上：重算快照原始 AST 的 SHA-256，与 evidence.astSha256 不符即 refused。
 *    这能挡住「快照和基线不是同一次导出」的情况。
 * 4. 只认纯文本段落：段落内只要出现 fieldValue / tableValue / table / image /
 *    formula / textStyle 等任意非 text 子节点，整段不可定位——变量、表格、图片、
 *    公式、内联样式都不能靠整段字符串覆盖，否则会破坏原有语义。
 * 5. 全局唯一：待定位文本必须在**整份快照**的合格段落里只出现一次；出现 0 次或
 *    多次一律 refused，不做「取第一个」「最相似」之类的猜测。
 * 6. 附件是独立 item（itemType=1，text 为 null），永远不参与正文定位。
 *
 * 因此本模块的输出字段里恒有 writebackAllowed: false。
 */

import { createHash } from 'node:crypto';

/** 段落内容里允许出现、且不影响安全定位的子节点类型。 */
const SAFE_CHILD_TYPES = new Set(['text']);

/** 永远不参与正文定位的 item 类型（1 = 附件/Word 文件）。 */
const NON_BODY_ITEM_TYPES = new Set([1]);

/**
 * 稳定序列化：对象键按字典序递归排序，便于重算 AST 摘要。
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/**
 * 重算整份快照原始 AST 的摘要。
 * @param {unknown} itemList
 * @returns {string} 64 位小写十六进制
 */
export function astDigest(itemList) {
  return createHash('sha256').update(stableStringify(itemList), 'utf8').digest('hex');
}

/**
 * 深度优先展开 item 树，带上从根到当前节点的路径。
 * @param {any[]} items
 * @param {number[]} path
 * @returns {Array<{ item: any, path: number[] }>}
 */
function flattenItems(items, path = []) {
  const out = [];
  if (!Array.isArray(items)) return out;
  items.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const here = [...path, index];
    out.push({ item, path: here });
    const sub = item.subItemList;
    if (Array.isArray(sub) && sub.length) out.push(...flattenItems(sub, here));
  });
  return out;
}

/**
 * 取段落节点的纯文本；只要混入任何非 text 子节点就返回 null（不可定位）。
 * @param {any} block
 * @returns {string|null}
 */
export function safeParagraphText(block) {
  if (!block || typeof block !== 'object' || block.type !== 'paragraph') return null;
  const content = block.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const parts = [];
  for (const child of content) {
    if (!child || typeof child !== 'object') return null;
    if (!SAFE_CHILD_TYPES.has(child.type)) return null;
    if (typeof child.text !== 'string') return null;
    parts.push(child.text);
  }
  const text = parts.join('');
  // 空段落与纯空白段落没有区分度，不参与定位。
  return text.trim() ? text : null;
}

/**
 * 收集快照里所有可安全定位的段落。
 * @param {unknown} itemList
 * @returns {Array<{ itemId: any, itemIndex: number[], blockIndex: number, text: string }>}
 */
export function collectLocatableBlocks(itemList) {
  const blocks = [];
  for (const { item, path } of flattenItems(itemList)) {
    if (NON_BODY_ITEM_TYPES.has(item.itemType)) continue;
    const content = item.itemContent;
    if (!content || typeof content !== 'object') continue;
    // itemContent.itemId 必须与外层 id 一致，否则节点自描述不可信。
    if (content.itemId !== undefined && content.itemId !== item.id) continue;
    const doc = content.text;
    if (!doc || typeof doc !== 'object' || doc.type !== 'doc') continue;
    const docBlocks = Array.isArray(doc.content) ? doc.content : [];
    docBlocks.forEach((block, blockIndex) => {
      const text = safeParagraphText(block);
      if (text === null) return;
      blocks.push({ itemId: item.id, itemIndex: path, blockIndex, text });
    });
  }
  return blocks;
}

/**
 * 校验调用方提供的证据与快照是否匹配。任何一项不满足都返回原因字符串。
 * @param {{ itemList: unknown, identity?: any }} snapshot
 * @param {any} evidence
 * @returns {string|null} null 表示通过
 */
export function checkEvidence(snapshot, evidence) {
  if (!snapshot || typeof snapshot !== 'object') return 'missing snapshot';
  if (!Array.isArray(snapshot.itemList)) return 'missing snapshot itemList';
  if (!evidence || typeof evidence !== 'object') return 'missing version evidence';
  if (evidence.versionMatched !== true) return 'snapshot version is not proven to match the baseline';
  if (evidence.complete !== true) return 'snapshot is not proven complete';
  if (evidence.capturedAt !== undefined && typeof evidence.capturedAt !== 'string') {
    return 'invalid evidence capturedAt';
  }
  const identity = snapshot.identity;
  if (!identity || typeof identity !== 'object') return 'missing snapshot identity';
  for (const key of ['projectId', 'companyId', 'reportType']) {
    if (String(identity[key] ?? '') === '') return 'missing snapshot identity ' + key;
    if (String(evidence[key] ?? '') !== String(identity[key])) {
      return 'evidence ' + key + ' does not match the snapshot';
    }
  }
  if (typeof evidence.astSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.astSha256)) {
    return 'missing or invalid evidence astSha256';
  }
  const actual = astDigest(snapshot.itemList);
  if (actual !== evidence.astSha256) return 'snapshot AST does not match the recorded digest';
  return null;
}

/**
 * 去掉段首的编号前缀。
 *
 * 天源生成 DOCX 时会把章节序号写进正文（「五、本资产评估机构…」），而线上节点
 * 的正文里没有这个序号（「本资产评估机构…」）——序号由生成器按节点顺序加。
 * 因此 Word 与线上节点直接比文本必然对不上，定位前要先把序号剥掉。
 *
 * 只剥**开头一处**，并且要求后面紧跟文字，避免把「一、」当正文内容误删。
 */
const NUMBERING_PREFIX = new RegExp(
  '^\\s*(?:' +
    '[一二三四五六七八九十百零〇]{1,4}\\s*[、.．]' + // 一、 二.
    '|[(（]\\s*[一二三四五六七八九十百零〇]{1,4}\\s*[)）]' + // (一) （一）
    '|[(（]\\s*\\d{1,3}\\s*[)）]' + // (1) （1）
    '|\\d{1,3}\\s*[、.．](?!\\d)' + // 1、 1. （不能把 1.5 的整数部分当序号）
    '|第[一二三四五六七八九十百零〇\\d]{1,4}[章节条]' + // 第一章 第3条
    ')\\s*',
);

export function stripNumberingPrefix(text) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  const out = trimmed.replace(NUMBERING_PREFIX, '').trim();
  // 剥完不能为空，否则宁可当作「没有前缀」，不要凭空造出一个空文本去匹配。
  return out || trimmed;
}

/**
 * 定位一处正文修改对应的候选节点。
 *
 * @param {{
 *   snapshot?: { itemList?: unknown, identity?: any },
 *   evidence?: any,
 *   change?: { baseline?: unknown, modified?: unknown }
 * }} input
 * @returns {{
 *   status: 'located'|'refused',
 *   reason?: string,
 *   candidate?: { itemId: any, itemIndex: number[], blockIndex: number, text: string },
 *   writebackAllowed: false,
 *   requiresHumanReview: true
 * }}
 */
export function locateCandidate({ snapshot, evidence, change } = {}) {
  const refused = (reason) => ({ status: 'refused', reason, writebackAllowed: false, requiresHumanReview: true });

  if (!change || typeof change !== 'object') return refused('missing change');
  const baselineText = typeof change.baseline === 'string' ? change.baseline.trim() : '';
  const modifiedText = typeof change.modified === 'string' ? change.modified.trim() : '';
  if (!baselineText) return refused('missing baseline text');
  if (baselineText === modifiedText) return refused('baseline and modified text are identical');

  const problem = checkEvidence(snapshot, evidence);
  if (problem) return refused(problem);

  const blocks = collectLocatableBlocks(snapshot.itemList);

  // 先按原文精确匹配；对不上再把 Word 侧的章节序号剥掉重试。
  let hits = blocks.filter((b) => b.text.trim() === baselineText);
  let matchedBy = 'exact';
  if (hits.length === 0) {
    const stripped = stripNumberingPrefix(baselineText);
    if (stripped && stripped !== baselineText) {
      hits = blocks.filter((b) => b.text.trim() === stripped);
      matchedBy = 'stripped numbering prefix';
    }
  }
  if (hits.length === 0) return refused('baseline text not found among locatable paragraphs');
  if (hits.length > 1) return refused('baseline text appears more than once; cannot locate uniquely');

  const only = hits[0];
  const existsElsewhere = blocks.some((b) => b !== only && (
    b.text.trim() === modifiedText || b.text.trim() === stripNumberingPrefix(modifiedText)
  ));
  if (existsElsewhere) return refused('modified text already exists elsewhere in the snapshot');

  return {
    status: 'located',
    candidate: {
      itemId: only.itemId,
      itemIndex: only.itemIndex,
      blockIndex: only.blockIndex,
      text: only.text,
    },
    matchedBy,
    // 恒为 false：定位成功也不代表可以写回。
    writebackAllowed: false,
    requiresHumanReview: true,
  };
}

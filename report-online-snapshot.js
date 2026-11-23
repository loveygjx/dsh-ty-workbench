// 线上节点树快照：把「导出这份 Word 时线上是什么样」固化成可复核的证据。
//
// 证据边界（重要，不要对外说成"证明同版"）：
// - 本模块能确认的是 **同批次导出**：同一 project/company/reportType，紧跟在
//   该份 DOCX 下载之后抓取的线上节点树；身份四项来自 basicInfo 自述。
// - 本模块**不能**证明节点树内容与该版本 DOCX 逐字节对应。天源没有提供
//   "某个 report version 对应的节点树" 接口，所以 versionMatched 只是
//   「同批次声明」，不是密码学证据。写回前仍必须做三方比较（基线快照 /
//   当前线上 / 用户改动），这一点由调用侧的 locate 层继续约束。
import { astDigest } from './report-node-mapper.js';

const MAX_ITEM_LIST = 200000;
const MAX_DEPTH = 200;

/** 只从 basicInfo 取身份字段，别的字段一概不信。 */
function identityOf(basicInfo) {
  if (!basicInfo || typeof basicInfo !== 'object' || Array.isArray(basicInfo)) return null;
  const identity = {
    projectId: basicInfo.projectId,
    companyId: basicInfo.companyId,
    reportType: basicInfo.reportType,
  };
  for (const [key, value] of Object.entries(identity)) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    identity[key] = String(value);
  }
  return identity;
}

function countItems(list) {
  // 迭代遍历：真实数据里节点树可能有几万层嵌套的恶意或异常结构，
  // 递归会直接爆栈（RangeError 不是我们能给的错误语义）。
  let total = 0;
  const stack = [{ nodes: list, depth: 0 }];
  while (stack.length) {
    const { nodes, depth } = stack.pop();
    if (!Array.isArray(nodes)) continue;
    if (depth > MAX_DEPTH) throw new Error('节点树层级过深，快照未保存');
    for (const node of nodes) {
      total += 1;
      if (total > MAX_ITEM_LIST) throw new Error('节点树超过上限，快照未保存');
      if (node && Array.isArray(node.subItemList) && node.subItemList.length) {
        stack.push({ nodes: node.subItemList, depth: depth + 1 });
      }
    }
  }
  return total;
}

/**
 * 用一个 ReportFullExportVO 构造快照与同批次证据。
 *
 * @param {{
 *   document?: unknown,
 *   expected?: { projectId?: unknown, companyId?: unknown, reportType?: unknown },
 *   capturedAt?: string
 * }} input
 * @returns {{ snapshot: { identity: any, itemList: any[], headerFooter?: unknown },
 *             evidence: { versionMatched: boolean, complete: boolean, capturedAt: string,
 *                         projectId: string, companyId: string, reportType: string,
 *                         astSha256: string, itemCount: number, versionClaim: string,
 *                         versionProof: 'same-batch' } }}
 */
export function buildOnlineSnapshot({ document, expected = {}, capturedAt } = {}) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('线上导出不是对象');
  const identity = identityOf(document.basicInfo);
  if (!identity) throw new Error('线上导出缺少身份字段（projectId/companyId/reportType）');
  for (const key of ['projectId', 'companyId', 'reportType']) {
    const want = expected[key];
    if (want === null || want === undefined || want === '') continue;
    if (String(want) !== identity[key]) throw new Error('线上导出的 ' + key + ' 与本次导出不一致');
  }
  const itemList = document.itemList;
  if (!Array.isArray(itemList) || itemList.length === 0) throw new Error('线上导出没有节点树');
  const itemCount = countItems(itemList);
  const warnings = Array.isArray(document.warnings) ? document.warnings : [];
  const at = capturedAt || new Date().toISOString();
  const snapshot = { identity, itemList };
  if (document.headerFooter && typeof document.headerFooter === 'object') snapshot.headerFooter = document.headerFooter;
  const evidence = {
    // 同批次声明：DOCX 下载与本快照抓取是同一次导出操作，身份一致。
    versionMatched: true,
    // 有 warnings 就说明节点树不完整，任何定位都必须拒绝。
    complete: warnings.length === 0,
    capturedAt: at,
    projectId: identity.projectId,
    companyId: identity.companyId,
    reportType: identity.reportType,
    astSha256: astDigest(itemList),
    itemCount,
    versionClaim: 'same-batch',
    versionProof: 'same-batch',
  };
  if (!evidence.complete) snapshot.warnings = warnings.slice(0, 50);
  return { snapshot, evidence };
}

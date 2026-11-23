/**
 * 天源「报告说明 / 评估报告」节点写回通道：接口事实与安全边界
 *
 * 本文件不是执行代码，是**已在前端产物中逐字核对过**的接口契约，供后续实现
 * 「按节点写回」时引用。所有路径都相对 https://ty.zhrdc.net。
 *
 * ── 证据来源（可复核）────────────────────────────────────────────
 * 前端 SPA 静态资源并不都走 /dist/js/（那条路径被网关拦成
 *   {"code":500,"msg":"系统异常"}，108 字节）。真正的入口是 /ty/assets/：
 *   主包   GET /ty/assets/index-8c0328d8.js            1,159,842 B
 *   页面块 GET /ty/assets/index-4fa9f996.js            88,344 B   ← 报告节点编辑面板
 *   页面块 GET /ty/assets/index-33b07bba.js            770,893 B  ← 报告说明整体页
 *   锁模块 GET /ty/assets/lock-03029b62.js             1,468 B
 * 下面每个接口都可以用 grep 在这些文件里原文找到。
 *
 * ── 读（只读，已在浏览器实测跑通）────────────────────────────────
 *  GET  /ty/api/report/project?pageNum&limit&projectId&reportType&companyId
 *       报告列表。每项含 id/companyId/companyName/reportType/version/
 *       createUserName/createTime/attachId。
 *  GET  /ty/api/report/config/item/detail?projectId&reportType&companyId
 *       节点树（itemName/itemType/condItemList/outlineLevel/prohibitEdit/seq/subItemList）。
 *  POST /ty/api/report/config/item/content/batch   body {projectId, companyId, itemIdList[]}
 *       节点正文。返回每项 {itemId, itemType, quoteItem, quoteModule, text, attachId,
 *       fileName, uri, fileKey, quoteItemId, name}。
 *       text 是 JSON **字符串**，形如
 *         {"type":"doc","content":[{"type":"paragraph","attrs":{...},"content":[...]}]}
 *       与 MCP export_report_full_json 的 itemContent.text 同构，itemId 完全一致。
 *  POST /ty/api/report/config/item/variable     变量字典
 *  GET  /ty/api/permission_lock/... （见下）
 *
 * ── 写（已确认存在，本工作台当前**不调用**）──────────────────────
 *  POST /ty/api/report/config/item/content/save   body = moduleContent 对象
 *       前端构造方式（index-4fa9f996.js 内 `q=` 函数，逐字）：
 *         const w = JSON.stringify(u.moduleContent.rtfContent);   // 富文本转字符串
 *         const g = { ...u.moduleContent, text: w,
 *                     companyId: l.companyId, projectId: l.projectId };
 *         delete g.rtfContent;                                    // 只发 text
 *         if (!await Vt(g)) return false;                         // Vt = content/save
 *       即 payload = 该节点 content/batch 返回项 + text 换成本地改后的 doc JSON 字符串。
 *       成功判据 code === 200 且 data 非空。
 *  POST /ty/api/report/config/item/update（经 module_item/update、module_item/single/update）
 *  POST /ty/api/report/config/update、/header_footer/save、/template/save_as、/template/quote
 *  POST /ty/api/report/build/{projectId}/{companyId}/{reportType}   触发生成
 *  POST /ty/api/report/delete、/recovery/{pid}/{jobId}
 *
 * ── 并发控制：编辑锁（真实存在，网页端进入编辑就 acquire）──────────
 *  lock-03029b62.js 导出的 report_config 锁：
 *    POST /ty/api/permission_lock/report_config/acquire/{projectId}/{companyId}/{reportType}
 *    POST /ty/api/permission_lock/report_config/release/{projectId}/{companyId}/{reportType}
 *  单节点锁：
 *    POST /ty/api/permission_lock/report_config_item/acquire/{projectId}/{companyId}/{reportConfigItemId}
 *    POST /ty/api/permission_lock/report_config_item/release/{projectId}/{companyId}/{reportConfigItemId}
 *  acquire 返回 data；编辑面板代码里检查 `acquired`，不成立则提示
 *  「<lockHolderFullName> 正在编辑中...」。release 返回 code===200 即成功。
 *  → 结论：平台**有**并发控制，写回前必须先 acquire 该节点锁，写完 release。
 *    未持锁直接写是绕过平台机制，不允许。
 *
 * ── 为什么本工作台仍然恒 writebackAllowed:false ────────────────────
 * 1) 没有「这份 DOCX 对应线上哪个版本」的密码学证据。线上已有 V18 而本地样本是 V17，
 *    错版写回会把别人的改动覆盖掉。仅在导出同批次抓到节点树时可证明「同批次」，
 *    不能证明「同版本逐字节对应」。
 * 2) content/save 是整节点覆盖，没有字段级 patch、没有 ETag/If-Match。
 *    定位不到唯一节点或节点在导入后被别人改过，都会静默覆盖。
 * 3) 变量节点（fieldValue）与附件节点（itemType===1）不能按文本写回，
 *    文本节点里也可能夹 fieldValue/image，替换整段会丢结构。
 * 因此：先只读比对 + 给人看的定位建议，写回必须由人确认后另开一次显式操作。
 */

/** 写回通道事实表；供测试与文档校验，不参与运行时决策。 */
export const WRITE_CHANNELS = Object.freeze({
  readContents: { method: 'POST', path: '/ty/api/report/config/item/content/batch' },
  saveContents: { method: 'POST', path: '/ty/api/report/config/item/content/save' },
  itemTree: { method: 'GET', path: '/ty/api/report/config/item/detail' },
  reportList: { method: 'GET', path: '/ty/api/report/project' },
  lockAcquire: {
    method: 'POST',
    path: '/ty/api/permission_lock/report_config_item/acquire/{projectId}/{companyId}/{itemId}',
  },
  lockRelease: {
    method: 'POST',
    path: '/ty/api/permission_lock/report_config_item/release/{projectId}/{companyId}/{itemId}',
  },
});

/** 写回 payload 的构造规则（与前端 content/save 一致）。 */
export function buildSavePayload({ content, text, projectId, companyId }) {
  if (!content || typeof content !== 'object') throw new Error('缺少节点原始内容');
  if (typeof text !== 'string') throw new Error('text 必须是 JSON 字符串');
  if (projectId == null || companyId == null) throw new Error('缺少 projectId/companyId');
  const payload = { ...content };
  delete payload.rtfContent;
  payload.text = text;
  payload.projectId = String(projectId);
  payload.companyId = String(companyId);
  return payload;
}

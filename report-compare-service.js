import { constants } from 'node:fs';
import { lstat, realpath, readdir, open, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isAbsolute, join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOnlineSnapshot } from './report-online-snapshot.js';
import { verifyOnlineFull, FULL_FILE } from './report-online-full.js';
import { locateCandidate, collectLocatableBlocks, stripNumberingPrefix } from './report-node-mapper.js';

const MAX_DOCUMENT = 32 * 1024 * 1024;
const MAX_MANIFEST = 64 * 1024;
const MAX_ONLINE_SNAPSHOT = 64 * 1024 * 1024;
const MAX_OUTPUT = 8 * 1024 * 1024;
const TIMEOUT_MS = 30000;
const ENGINE = fileURLToPath(new URL('./report-diff.py', import.meta.url));
const ID = /^baseline-[A-Za-z0-9]{6}$/;

async function privateDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('unsafe private directory');
}
async function archiveRoot(rootDir) {
  if (typeof rootDir !== 'string' || !isAbsolute(rootDir)) throw new TypeError('rootDir must be absolute');
  const rootInfo = await lstat(rootDir);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('unsafe root directory');
  const root = join(await realpath(rootDir), '.report-baselines');
  await privateDirectory(root);
  return root;
}

/**
 * 临时比对文件放哪里。
 *
 * 为什么不用系统 tmpdir：报告正文是未公开内容，散落到共享临时区不合适。
 * 归档根权限 0700 且已确认属于当前用户，是这里唯一合适的落点。
 * 但"现场比对"这条通道可能发生在用户从没归档过基线的时候——那时
 * .report-baselines 还不存在，所以按需创建（0o700），已存在则沿用。
 */
async function tempRoot(rootDir) {
  if (typeof rootDir !== 'string' || !isAbsolute(rootDir)) throw new TypeError('rootDir must be absolute');
  const rootInfo = await lstat(rootDir);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('unsafe root directory');
  const root = join(await realpath(rootDir), '.report-baselines');
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  await privateDirectory(root);
  return root;
}
async function readPrivateFile(path, max) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o077) || (typeof process.getuid === 'function' && st.uid !== process.getuid()) || st.size > max) throw new Error('unsafe archive file');
    const data = await handle.readFile();
    const after = await handle.stat();
    if (data.length !== st.size || st.size !== after.size || st.mtimeMs !== after.mtimeMs || st.ctimeMs !== after.ctimeMs) throw new Error('archive file changed while reading');
    return data;
  } finally { await handle.close(); }
}
async function readBaseline(root, id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('invalid baselineId');
  const batch = join(root, id), snapshot = join(batch, 'snapshot');
  await privateDirectory(batch);
  await privateDirectory(snapshot);
  const manifest = JSON.parse((await readPrivateFile(join(snapshot, 'manifest.json'), MAX_MANIFEST)).toString('utf8'));
  if (manifest?.schemaVersion !== 1 || manifest?.document?.file !== 'report.docx' || !/^[a-f0-9]{64}$/.test(manifest?.document?.sha256 || '') || !Number.isSafeInteger(manifest.document.size) || manifest.document.size < 0 || !manifest.metadata || typeof manifest.metadata !== 'object' || Array.isArray(manifest.metadata) || typeof manifest.createdAt !== 'string' || !manifest.onlineSnapshot || typeof manifest.onlineSnapshot !== 'object') throw new Error('invalid baseline manifest');
  const bytes = await readPrivateFile(join(snapshot, 'report.docx'), MAX_DOCUMENT);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== manifest.document.sha256 || bytes.length !== manifest.document.size) throw new Error('baseline integrity check failed');
  const metadata = {};
  for (const key of ['projectId', 'projectName', 'companyId', 'companyName', 'reportType', 'version']) {
    const value = manifest.metadata[key];
    if (value !== undefined) {
      if (typeof value !== 'string' || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('invalid baseline metadata');
      metadata[key] = value;
    }
  }
  // 两种状态都合法：老基线（未抓线上快照）仍可比对，只是不能做线上定位。
  let online = null;
  let summaryOnline;
  if (manifest.onlineSnapshot.status === 'not_captured') {
    if (manifest.onlineSnapshot.reason !== 'not_requested') throw new Error('unsupported online snapshot status');
    summaryOnline = { status: 'not_captured', reason: 'not_requested' };
  } else if (manifest.onlineSnapshot.status === 'same_batch') {
    online = await readOnlineSnapshot(snapshot, manifest.onlineSnapshot, sha256);
    summaryOnline = {
      status: 'same_batch',
      claim: 'captured in the same export run as report.docx; not a per-version proof',
      capturedAt: online.evidence.capturedAt,
      itemCount: online.evidence.itemCount,
      complete: online.evidence.complete,
    };
  } else {
    throw new Error('unsupported online snapshot status');
  }
  // 完整版快照（content/batch）是可选的，老基线没有这个键。
  // 有就必须自洽，否则按「基线损坏」处理——不能拿一份被改过的完整版去回溯。
  let summaryFull = null;
  if (manifest.onlineFull != null) {
    const parsedFull = await readOnlineFull(snapshot, manifest.onlineFull, summaryOnline.identity || null);
    summaryFull = {
      status: 'same_batch',
      capturedAt: parsedFull.descriptor.capturedAt,
      itemCount: parsedFull.descriptor.itemCount,
      sha256: parsedFull.descriptor.astSha256,
    };
  }
  return {
    bytes, online, manifest,
    summary: { id, metadata, createdAt: manifest.createdAt, sha256, size: manifest.document.size, onlineSnapshot: summaryOnline, onlineFull: summaryFull },
  };
}

/** 读出并复核基线里的完整版节点内容（content/batch 抓的那份）。 */
async function readOnlineFull(snapshot, descriptor) {
  const raw = await readPrivateFile(join(snapshot, FULL_FILE), MAX_ONLINE_SNAPSHOT);
  let parsed;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new Error('invalid online full json'); }
  verifyOnlineFull(parsed, descriptor);
  return { payload: parsed, descriptor };
}

/**
 * 读取并复核基线里的线上节点树快照。
 * 只认 `same_batch` 且四项自洽，任何不符都视为基线无效——宁可拒绝，不要拿
 * 一份来路不明的节点树去定位。
 */
async function readOnlineSnapshot(snapshot, descriptor, baselineSha256) {
  if (descriptor.file !== 'online-snapshot.json') throw new Error('unsupported online snapshot descriptor');
  if (typeof descriptor.astSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.astSha256)) throw new Error('invalid online snapshot digest');
  if (!Number.isSafeInteger(descriptor.itemCount) || descriptor.itemCount <= 0) throw new Error('invalid online snapshot item count');
  if (typeof descriptor.capturedAt !== 'string') throw new Error('invalid online snapshot time');
  if (typeof descriptor.complete !== 'boolean') throw new Error('invalid online snapshot completeness');
  if (!descriptor.identity || typeof descriptor.identity !== 'object') throw new Error('invalid online snapshot identity');
  const raw = await readPrivateFile(join(snapshot, 'online-snapshot.json'), MAX_ONLINE_SNAPSHOT);
  let parsed;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch (e) { throw new Error('invalid online snapshot json'); }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.itemList)) throw new Error('invalid online snapshot json');
  const { snapshot: rebuilt, evidence } = buildOnlineSnapshot({
    document: { basicInfo: parsed.identity, itemList: parsed.itemList, headerFooter: parsed.headerFooter, warnings: parsed.warnings },
    capturedAt: descriptor.capturedAt,
  });
  // 摘要与计数必须与清单一致，否则快照被改过。
  if (evidence.astSha256 !== descriptor.astSha256 || evidence.itemCount !== descriptor.itemCount) throw new Error('online snapshot integrity check failed');
  if (evidence.complete !== descriptor.complete) throw new Error('online snapshot integrity check failed');
  return { snapshot: rebuilt, evidence: { ...evidence, baselineSha256 } };
}

/** Return verified, completed baselines for a project. Corrupt entries are omitted. */
export async function listBaselines({ rootDir, projectId } = {}) {
  if (projectId != null && typeof projectId !== 'string' && !(typeof projectId === 'number' && Number.isSafeInteger(projectId))) throw new TypeError('invalid projectId');
  let root;
  try { root = await archiveRoot(rootDir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const entries = await readdir(root);
  const items = [];
  for (const id of entries) {
    if (!ID.test(id)) continue;
    try {
      const { summary } = await readBaseline(root, id);
      if (projectId == null || summary.metadata.projectId === String(projectId)) items.push(summary);
    } catch { /* Incomplete, corrupt or unsafe entries are never exposed. */ }
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

function runDiff(baseline, modified) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [ENGINE], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = [], size = 0, errorSize = 0, failure;
    const fail = message => { if (!failure) { failure = new Error(message); child.kill('SIGKILL'); } };
    const timer = setTimeout(() => fail('comparison timed out'), TIMEOUT_MS);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > MAX_OUTPUT) fail('comparison output exceeds limit'); else output.push(chunk); });
    child.stderr.on('data', chunk => { errorSize += chunk.length; if (errorSize > MAX_OUTPUT) fail('comparison output exceeds limit'); });
    child.on('error', () => { clearTimeout(timer); reject(new Error('comparison engine failed to start')); });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      let result;
      try { result = JSON.parse(Buffer.concat(output).toString('utf8')); } catch { return reject(new Error('invalid comparison engine output')); }
      if (code !== 0 || !result || result.ok !== true) return reject(new Error('comparison failed: invalid or unsupported DOCX'));
      resolve(result);
    });
    child.stdin.end(JSON.stringify({ baseline, modified }));
  });
}

/** Compare a validated archived DOCX to a bounded base64 upload; performs no network access. */
/** 供写回使用：读出基线的 manifest（含 onlineSnapshot.astSha256）并复核完整性。 */
export async function readManifestForWriteback({ rootDir, baselineId } = {}) {
  const root = await archiveRoot(rootDir);
  const { manifest } = await readBaseline(root, baselineId);
  return manifest;
}

function checkUploadFilename(filename) {
  if (typeof filename !== 'string' || filename.length > 255 || filename !== basename(filename) || /[\\/\x00-\x1f\x7f]/.test(filename) || extname(filename).toLowerCase() !== '.docx') throw new Error('invalid upload filename');
}

function decodeUploadBase64(base64) {
  if (typeof base64 !== 'string' || base64.length === 0 || base64.length > Math.ceil(MAX_DOCUMENT / 3) * 4 || base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(base64) || /=/.test(base64.slice(0, -2))) throw new Error('invalid or oversized base64 upload');
  const upload = Buffer.from(base64, 'base64');
  if (upload.length > MAX_DOCUMENT || upload.toString('base64') !== base64) throw new Error('invalid or oversized base64 upload');
  return upload;
}

/**
 * 把两份 DOCX 字节落到临时目录跑 diff，跑完即删。
 * 调用方负责 temp 目录的生命周期（compareUpload / compareLive 各建一次）。
 */
async function diffBytes(temp, baselineBytes, uploadBytes) {
  for (const [name, data] of [['baseline.docx', baselineBytes], ['upload.docx', uploadBytes]]) {
    const file = await open(join(temp, name), 'wx', 0o600);
    try { await file.writeFile(data); } finally { await file.close(); }
  }
  return runDiff(join(temp, 'baseline.docx'), join(temp, 'upload.docx'));
}

export async function compareUpload({ rootDir, baselineId, filename, base64 } = {}) {
  if (typeof baselineId !== 'string' || !ID.test(baselineId)) throw new Error('invalid baselineId');
  checkUploadFilename(filename);
  const upload = decodeUploadBase64(base64);
  const root = await archiveRoot(rootDir);
  const { bytes, online } = await readBaseline(root, baselineId);
  const temp = await mkdtemp(join(root, '.compare-'));
  try {
    const result = await diffBytes(temp, bytes, upload);
    // 定位是可选的第二段：没有线上快照的老基线照样能比对，只是给不出节点位置。
    return { ...result, locate: locateChanges(result, online) };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

/**
 * 不依赖本地归档基线：拿"当场从线上取回的 DOCX"当原版，比对一份上传改稿。
 *
 * 这是默认路径——用户改完稿只想上传一次，不该被迫先去导出。
 * baselineBytes 由宿主侧现场下载（最新已生成版本，或用户在下拉里选的旧版），
 * online 由宿主侧同批抓取（节点树 + 完整版正文），两者都不落盘、不进 manifest。
 *
 * 返回形状与 compareUpload 完全一致，前端不需要分辨两条通道。
 */
export async function compareAgainstLive({ rootDir, baselineBytes, online, filename, base64 } = {}) {
  checkUploadFilename(filename);
  if (!Buffer.isBuffer(baselineBytes) || baselineBytes.length === 0) throw new Error('missing live baseline document');
  if (baselineBytes.length > MAX_DOCUMENT) throw new Error('live baseline document exceeds limit');
  const upload = decodeUploadBase64(base64);
  // 临时目录仍建在归档根下：那里权限 0700 且已确认属于当前用户，
  // 用系统 tmpdir 会把未公开的报告正文散落到共享临时区。
  // 这条通道可能在没有归档基线的机器上跑，所以允许按需创建该目录。
  const root = await tempRoot(rootDir);
  const temp = await mkdtemp(join(root, '.compare-'));
  try {
    const result = await diffBytes(temp, baselineBytes, upload);
    return { ...result, locate: locateChanges(result, online) };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

/**
 * 把差异清单里能唯一确定的改动映射到线上节点。
 * 定位失败不影响比对结果本身；这里只补一列"能不能落到某一节某一段"。
 */
function locateChanges(result, online) {
  if (!online) {
    return { available: false, reason: 'baseline has no online snapshot', located: [], refused: [] };
  }
  if (!Array.isArray(result?.changes)) {
    return { available: false, reason: 'comparison result has no changes', located: [], refused: [] };
  }
  const report = { available: true, located: [], refused: [], counts: { located: 0, refused: 0 } };
  // 重复段落的按序配对表。
  //
  // 单看一处改动，线上同一句话出现两次确实"无法唯一定位"。但整批改动一起看，
  // 常常是有确定答案的：用户把两处都改了，线上也正好有两处，且改后文本一致，
  // 那就按文档顺序一一对应。实测浙江交投金属 V4 就是这样——「截至评估基准日，
  // 纳入评估范围的6项房屋建筑物尚未取得不动产权证」在摘要和正文各有一份，
  // 用户把两处都改成了"不动产权证书"，结果两处都被判"出现多次"。
  //
  // 只处理这种严格形状：同一段原文出现 N 次、改后文本也出现 N 次、且都唯一可认，
  // 才按顺序配。任何一侧数量不符就仍然拒绝——那才是真的说不准。
  const orderedPairs = buildOrderedPairs(result.changes, online.snapshot);
  // 附件节点（itemType===1，用户上传的 Word）的正文根本不在节点里：content/batch 对它
  // 返回 text:null，文字是渲染时才从 docx 抽出来塞进报告的。所以这类内容必然走到
  // unpaired，而「重复或结构变化」这个说法会把人带偏——真实原因是"这段文字属于一个
  // 上传的 Word 附件，线上只能替换文件，不能改字"。
  // 这里做两件事实判断：① 线上节点里到底有没有这段文字；② 这份报告里有没有附件节点。
  // 两者合起来才能说「这段是上传的 Word 附件渲染出来的」而不是瞎猜。
  const nodeTexts = collectNodeTexts(online.snapshot);
  const attachmentNodes = listAttachmentNodes(online.snapshot);
  const hasAttachmentNodes = attachmentNodes.length > 0;
  // 节点里的表格是 tableValue 变量引用（形如 ${…}），不是字面单元格。
  // 有这个信号，表格类未配对才能正确解释成「去数据源改」而不是「来自附件」。
  const hasTableValues = hasTableValueBlocks(online.snapshot?.itemList);
  // index 是变化组在原 changes 数组里的位置，前端勾选/回显都靠它对齐，
  // 不能靠文本 join 去匹配——重复段落会把两行串成一行。
  for (let index = 0; index < result.changes.length; index += 1) {
    const change = result.changes[index];
    const hasUnsupported = item => !!(item && typeof item === 'object' && item.unsupported === true);
    if (change?.type === 'candidate_change') {
      const paired = orderedPairs.get(index);
      const out = paired
        ? { status: 'located', candidate: paired.candidate, matchedBy: 'ordered duplicate pairing',
            writebackAllowed: false, requiresHumanReview: true }
        : locateCandidate({
          snapshot: online.snapshot,
          evidence: online.evidence,
          change: { baseline: change.baseline?.text, modified: change.modified?.text },
        });
      if (out.status === 'located') {
        report.located.push({
          index,
          baselineText: change.baseline?.text ?? '',
          modifiedText: change.modified?.text ?? '',
          candidate: out.candidate,
          // 定位方式要带出来：前端靠它提示「去序号匹配」「重复段落按序配对」，
          // 用户在勾选前有权知道这一条是靠什么对上号的。
          matchedBy: out.matchedBy || 'exact',
          writebackAllowed: out.writebackAllowed,
          requiresHumanReview: out.requiresHumanReview,
          unsupported: hasUnsupported(change.baseline) || hasUnsupported(change.modified),
        });
      } else {
        report.refused.push({
          index,
          baselineText: change.baseline?.text ?? '',
          modifiedText: change.modified?.text ?? '',
          reason: out.reason,
          unsupported: hasUnsupported(change.baseline) || hasUnsupported(change.modified),
          // 「线上找不到这段文字」有两种完全不同的原因：一种是真的被删了/改成了别的，
          // 另一种是这段文字本来就是上传的 Word 附件渲染出来的，节点里根本没有它。
          // 后者的正确处置是去替换附件文件，不是继续在这里调定位。
          ...describeUnpairedOrigin([change.baseline?.text ?? ''], nodeTexts, {
            leftCount: 1, rightCount: 1, kind: String(change.baseline?.kind || ''), hasAttachmentNodes, hasTableValues,
          }),
        });
      }
    } else if (change?.type === 'insertion' || change?.type === 'deletion') {
      // 增删段落不新建/删除节点：节点本身就是 [段落, 段落, …] 的数组，
      // 插一段是往数组里 splice 一项，删一段是摘掉一项（已实测服务端接受长度变化）。
      // 所以这里要给出"插到哪个节点、锚在哪个段落旁边"，写回时才有着落点。
      const isIns = change.type === 'insertion';
      const paras = isIns
        ? (Array.isArray(change.modified) ? change.modified : [])
        : (Array.isArray(change.baseline) ? change.baseline : []);
      const texts = paras.map(x => String(x?.text ?? '')).filter(t => t.trim() !== '');
      // 删除的锚点就是被删的那几段自己：它们本来就在线上，直接定位到自己身上最准
      // （实测"删掉文首一段"时，前一段锚点根本不在线上，后一段又不够稳）。
      // 插入才需要邻居当锚点：先找前面的段落（"插到它后面"），文首场景退回后面的
      // 段落（"插到它前面"）。两头都没有就拒绝——不猜。
      const afterText = String(change.after?.text ?? '');
      const beforeText = String(change.before?.text ?? '');
      const useBefore = !afterText && !!beforeText;
      const anchorText = isIns ? (useBefore ? beforeText : afterText) : texts[0] || '';
      // 锚点必须是唯一且可定位的段落，否则不知道该插进哪个节点——
      // 宁可让用户手动处理，也不要猜错节点把内容插到别人家去。
      const anchorHit = anchorText && nodeTexts.has(anchorText)
        ? locateCandidate({
          snapshot: online.snapshot,
          evidence: online.evidence,
          change: { baseline: anchorText, modified: anchorText + '\u0000__anchor__' },
        })
        : { status: 'refused', reason: anchorText ? 'insert anchor not found' : 'no anchor before this block' };

      if (anchorHit.status === 'located') {
        // 写回动作：在锚点那一段的前/后插入、或删掉锚点后紧跟的这几段
        report.located.push({
          index,
          kind: isIns ? 'insertion' : 'deletion',
          baselineText: isIns ? '' : texts.join(' / ').slice(0, 500),
          modifiedText: isIns ? texts.join(' / ').slice(0, 500) : '',
          candidate: anchorHit.candidate,
          matchedBy: 'anchor ' + (anchorHit.matchedBy || 'exact'),
          // 插到锚点段之后（默认），或锚点段之前（文首场景，anchorFrom='before'）。
          anchorFrom: isIns ? (useBefore ? 'before' : 'after') : 'self',
          insertAfter: !isIns ? undefined : true,
          deleteTexts: isIns ? undefined : texts,
          writebackAllowed: false,
          requiresHumanReview: true,
          unsupported: paras.some(x => x && x.unsupported === true),
        });
      } else {
        report.refused.push({
          index,
          baselineText: isIns ? '' : texts.join(' / ').slice(0, 500),
          modifiedText: isIns ? texts.join(' / ').slice(0, 500) : '',
          reason: isIns ? 'insertion anchor is not uniquely locatable' : 'deletion anchor is not uniquely locatable',
          unsupported: paras.some(x => x && x.unsupported === true),
          ...(isIns
            ? { added: true, deleted: false, table: false, attachment: false, inline: false,
                note: '这段是你在线下新加的，但紧挨着它前面的那段在线上找不到唯一位置，所以不知道插进哪个节点——请到天源网页手动插入。' }
            : { added: false, deleted: true, table: false, attachment: false, inline: false,
                note: '这段在线下被删掉了，但找不到唯一位置来定位它——请到天源网页手动删除。' }),
        });
      }
    } else if (change?.type === 'unpaired') {
      const baselineList = Array.isArray(change.baseline) ? change.baseline : [];
      const modifiedList = Array.isArray(change.modified) ? change.modified : [];
      const left = baselineList.map(x => String(x?.text ?? '')).filter(Boolean);
      const right = modifiedList.map(x => String(x?.text ?? '')).filter(Boolean);
      report.refused.push({
        index,
        baselineText: left.join(' / ').slice(0, 500),
        modifiedText: right.join(' / ').slice(0, 500),
        reason: 'unpaired block is not uniquely locatable',
        unsupported: baselineList.some(hasUnsupported) || modifiedList.some(hasUnsupported),
        // 这段文字在线上节点里根本不存在？那它就不是「改哪一段」的问题，
        // 而是它压根不属于任何可编辑节点（典型：上传的 Word 附件渲染进来的内容）。
        // inline 表示有节点持有这段文字，只是这次没配上；note 是给人看的原因。
        ...describeUnpairedOrigin(left, nodeTexts, {
          leftCount: left.length, rightCount: right.length,
          kind: String(baselineList[0]?.kind || ''),
          hasAttachmentNodes, hasTableValues,
        }),
      });
    }
  }
  // 附件清单给到前端一次就够：让用户知道这份报告里有哪些上传的 Word，
  // 未配对里标了 attachment 的那些内容就该去这些文件里改。
  report.attachments = attachmentNodes;
  report.counts.located = report.located.length;
  report.counts.refused = report.refused.length;
  // 恒为 false：整个比对链路都不具备写回能力。
  report.writebackAllowed = false;
  report.writeChannel = describeWriteChannel(report.counts.located);
  return report;
}

/**
 * 为「同一段原文在线上出现多次」的情况建立按序配对。
 *
 * 背景：单看一处改动，"这句话线上出现两次"确实无法定位。但整批一起看通常有答案——
 * 用户把重复的那几处都改了，线上也正好有同样多份，改法还都一样，那就按文档顺序配。
 *
 * 只接受严格形状，任何一处对不上就整组放弃（返回空表）：
 *   - 同一段原文在线上出现 N 次（N >= 2）
 *   - 该原文对应 N 处改动，且改后文本全都相同
 *   - 这些改动在 changes 里是按顺序出现的（保证"第 k 处改的"= "第 k 份原文"）
 *   - 定位块不是 unsupported（含变量/图片的不参与）
 *
 * 宁可不配也不要错配：写回是整节点覆盖，配错就是覆盖错的段落。
 *
 * @returns {Map<number, {candidate: {itemId, itemIndex, blockIndex, text}}>}
 *   key 是 changes 里的下标，只包含成功配对的项
 */
/**
 * 把线上快照里所有可编辑节点的纯文本收集成一个可检索的集合。
 *
 * 只收「正文段落能取出文字」的那些（复用 node-mapper 的同一套判据），
 * 目的是回答一个很朴素的问题：改稿里这段话，线上到底有没有对应的段落？
 * 答"没有"的时候才敢跟用户说「这不是改哪一段的问题」。
 */
function collectNodeTexts(snapshot) {
  const blocks = collectLocatableBlocks(snapshot?.itemList || []);
  return new Set(blocks.map(b => b.text));
}

/**
 * 列出节点树里的附件节点（itemType===1，用户上传的 Word）。
 *
 * 这些节点的正文不在节点里（content/batch 返回 text:null），改字是不可能的；
 * 但天源网页上它们可以打开在线编辑（前端走 OnlyOffice），也可以整份替换文件。
 * 所以不能只说"改不了"，得指名到具体哪个文件，用户才知道去哪儿改。
 */
/**
 * 节点里有没有表格变量块（type==='tableValue'）。
 *
 * 实测天源的表格节点不是字面单元格，而是：
 *   {type:'tableValue', attrs:{content:'project_info...valuationSummaryStatement',
 *                              text:'${项目信息.资产基础法-评估结论.评估结果汇总表}'}}
 * 报告 DOCX 里那些数字是渲染时从数据源算出来的，节点正文里一个字都没有。
 * 所以要区分「表格内容改不了」和「附件内容改不了」——处置方式完全不同。
 */
function hasTableValueBlocks(itemList) {
  let found = false;
  const walk = list => {
    for (const it of list || []) {
      if (found) return;
      const blocks = it?.itemContent?.text?.content;
      if (Array.isArray(blocks) && blocks.some(b => b?.type === 'tableValue')) { found = true; return; }
      walk(it?.subItemList);
    }
  };
  walk(itemList || []);
  return found;
}

function listAttachmentNodes(snapshot) {
  const out = [];
  const walk = list => {
    for (const it of list || []) {
      if (Number(it?.itemType) === 1) {
        out.push({
          itemId: String(it.id ?? ''),
          fileName: String(it?.itemContent?.fileName || ''),
          attachId: it?.itemContent?.attachId == null ? '' : String(it.itemContent.attachId),
          itemName: String(it?.itemName || ''),
        });
      }
      walk(it?.subItemList);
    }
  };
  walk(snapshot?.itemList || []);
  return out;
}

/**
 * 给一条「未配对」改动补上它到底为什么没配上。
 *
 * 两种完全不同的情况过去被塞进同一句 reason，用户看不出区别：
 *  - inline: true  —— 线上有这段文字，只是这次没法唯一对上（重复/结构变化），
 *                     这是「多改几次也许能配上」。
 *  - attachment: true —— 线上根本没有这段文字，而报告里有上传的 Word 附件，
 *                     那它几乎必然来自附件渲染。附件内容在节点里是 text:null，
 *                     线上只能整体替换文件（/attach/upload/or/update），
 *                     改字是做不到的。这种情况重试多少次都不会成功。
 */
function describeUnpairedOrigin(texts, nodeTexts, ctx) {
  const c = ctx || {};
  const list = (texts || []).filter(t => String(t).trim() !== '');
  const leftCount = Number.isFinite(c.leftCount) ? c.leftCount : list.length;
  const rightCount = Number.isFinite(c.rightCount) ? c.rightCount : list.length;
  const kind = String(c.kind || '');

  // 新增内容：原稿没有、改稿有。这是线下最常见的动作之一，必须给明确答复，
  // 否则用户只会看到一行空白和「找不到」。
  if (!leftCount && rightCount) {
    return {
      inline: false, attachment: false, added: true, deleted: false, table: false,
      note: '这段是你在线下新加的。写回的模型是「整节点覆盖已有段落」，不会新建节点，所以新增内容目前写不回去——需要到天源网页手动插入，或者把内容并进相邻的已有段落再比对一次。',
    };
  }

  // 删除内容：原稿有、改稿没有。写回只能替换文字，不能删除节点。
  if (leftCount && !rightCount) {
    return {
      inline: false, attachment: false, added: false, deleted: true, table: false,
      note: '这段在线下被删掉了。写回只能改文字、不能删除节点段落，所以这条不会执行——需要到天源网页手动删。',
    };
  }

  if (!list.length) return { inline: false, attachment: false, added: false, deleted: false, table: false, note: '' };

  const inline = list.some(t => nodeTexts.has(String(t)));
  if (inline) {
    return {
      inline: true, attachment: false, added: false, deleted: false, table: false,
      note: '线上有这段文字，但这次无法唯一对上（重复或结构变化）',
    };
  }

  // 表格单元格：实测节点里的表格不是字面单元格，而是 tableValue 变量引用
  // （attrs.text 形如 ${项目信息.资产基础法-评估结论.评估结果汇总表}）。
  // 报告 docx 里那些数字是渲染时从数据源生成的，节点正文里一个字都没有，
  // 所以这里既不是附件、也不是「被删了」——要去数据源/明细表改。
  if (kind === 'table_cell_paragraph') {
    return {
      inline: false, attachment: false, added: false, deleted: false, table: true,
      note: c.hasTableValues
        ? '这段在表格里。报告里的表格是变量引用（${…}），数字由数据源渲染生成，节点正文里没有这些字——要改数字请去明细表/数据源改，改完重新生成报告。'
        : '这段在表格里，表格内容不在可编辑的节点正文中，改字写回做不到。',
    };
  }

  if (c.hasAttachmentNodes) {
    return {
      inline: false, attachment: true, added: false, deleted: false, table: false,
      note: '这段文字不在任何可编辑节点里，来自上传的 Word 附件；线上只能替换整个文件，不能改字',
    };
  }

  return {
    inline: false, attachment: false, added: false, deleted: false, table: false,
    note: '线上找不到这段文字对应的可编辑段落',
  };
}

function buildOrderedPairs(changes, snapshot) {
  const out = new Map();
  if (!Array.isArray(changes) || !snapshot || !Array.isArray(snapshot.itemList)) return out;

  // 归一化：剥掉章节序号再比对。
  // 关键：同一句话在 Word 里可能带不同序号（摘要里是「(二)」，正文里是「1.」），
  // 但线上两处存的是同一个去掉序号的文本。按原文分组会把它们拆成两组各 1 项，
  // 永远达不到"重复"的判定，所以这里必须按剥完序号的文本分组。
  const norm = t => String(stripNumberingPrefix(String(t ?? '').trim())).trim();

  // 归一化原文 → 该原文对应的所有改动下标
  const groups = new Map();
  for (let i = 0; i < changes.length; i += 1) {
    const c = changes[i];
    if (c?.type !== 'candidate_change') continue;
    if (c.baseline?.unsupported === true || c.modified?.unsupported === true) continue;
    const b = norm(c.baseline?.text);
    const m = norm(c.modified?.text);
    if (!b || !m || b === m) continue;
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push({ index: i, modified: m });
  }

  const blocks = collectLocatableBlocks(snapshot.itemList);
  for (const [baselineKey, group] of groups) {
    // 只有一处：交给常规 locateCandidate，这里不插手
    if (group.length < 2) continue;
    // 改后文本必须完全一致（剥序号后）。不一致说明用户把它们改成了不同内容，
    // 那"按顺序配对"就不再是确定答案了——整组放弃。
    const wanted = group[0].modified;
    if (!group.every(g => g.modified === wanted)) continue;
    // 改动必须按顺序出现（changes 本身就按文档顺序产出，这里再挡一遍乱序输入）
    const indices = group.map(g => g.index);
    let ordered = true;
    for (let k = 1; k < indices.length; k += 1) {
      if (indices[k] <= indices[k - 1]) { ordered = false; break; }
    }
    if (!ordered) continue;

    // 线上同归一化文本的段落，数量必须与改动数完全相等。
    // 不等就说明还有我们没看见的重复，配下去可能覆盖错段落。
    const hits = blocks.filter(b => norm(b.text) === baselineKey);
    if (hits.length !== group.length) continue;

    for (let k = 0; k < group.length; k += 1) {
      const h = hits[k];
      out.set(group[k].index, {
        candidate: { itemId: h.itemId, itemIndex: h.itemIndex, blockIndex: h.blockIndex, text: h.text },
      });
    }
  }
  return out;
}

/**
 * 告诉使用者"这条路技术上通到哪里、还差什么"，而不是简单说"不支持"。
 * 通道事实见 report-write-channel.js（从前端产物逐字核对）。
 */
function describeWriteChannel(locatedCount) {
  if (!locatedCount) {
    return {
      available: false,
      reason: '没有任何改动能唯一定位到线上节点，无从写回',
    };
  }
  return {
    available: true,
    endpoint: 'POST /ty/api/report/config/item/content/save',
    locking: '写前 acquire 该节点编辑锁，写后 release',
    blocking: [
      '写回是整节点覆盖：这一处改动会连带把该节点其余段落重写一次（文字不变，但确实被重写过）。',
      '写前会重新抓线上节点树核对哈希；期间有人改过就中止，不会覆盖别人的改动。',
      '含变量、图片或附件的节点不写；这类节点替换整段会丢结构。',
    ],
    requiresHumanReview: true,
  };
}

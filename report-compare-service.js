import { constants } from 'node:fs';
import { lstat, realpath, readdir, open, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isAbsolute, join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOnlineSnapshot } from './report-online-snapshot.js';
import { verifyOnlineFull, FULL_FILE } from './report-online-full.js';
import { locateCandidate } from './report-node-mapper.js';

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
  // index 是变化组在原 changes 数组里的位置，前端勾选/回显都靠它对齐，
  // 不能靠文本 join 去匹配——重复段落会把两行串成一行。
  for (let index = 0; index < result.changes.length; index += 1) {
    const change = result.changes[index];
    const hasUnsupported = item => !!(item && typeof item === 'object' && item.unsupported === true);
    if (change?.type === 'candidate_change') {
      const out = locateCandidate({
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
      });
    }
  }
  report.counts.located = report.located.length;
  report.counts.refused = report.refused.length;
  // 恒为 false：整个比对链路都不具备写回能力。
  report.writebackAllowed = false;
  report.writeChannel = describeWriteChannel(report.counts.located);
  return report;
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

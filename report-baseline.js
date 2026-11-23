import { constants } from 'node:fs';
import { open, lstat, realpath, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, extname } from 'node:path';
import { buildOnlineSnapshot } from './report-online-snapshot.js';
import { buildOnlineFull, FULL_FILE } from './report-online-full.js';

const FIELDS = ['projectId', 'projectName', 'companyId', 'companyName', 'reportType', 'version'];

function metadataForArchive(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('metadata must be an object');
  const result = {};
  for (const key of FIELDS) {
    const value = input[key];
    if (value == null || value === '') continue;
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) throw new TypeError(`invalid metadata: ${key}`);
    const text = String(value);
    if (text.length > 200 || /[\x00-\x1f\x7f]/.test(text) || /(?:https?:\/\/|bearer\s|cookie\s*[:=]|(?:token|password|secret|authorization)\s*[:=])/i.test(text)) throw new TypeError(`unsafe metadata: ${key}`);
    result[key] = text;
  }
  return result;
}

/** Archive the final, already-exported DOCX. No network is performed here.
 * rootDir: existing absolute directory; sourcePath: absolute .docx file.
 * metadata: optional whitelist {projectId, projectName, companyId, companyName, reportType, version}.
 * online: optional { document, capturedAt } — the ReportFullExportVO captured right after
 *   this DOCX was downloaded. Passing it upgrades the manifest from `not_captured` to
 *   `same_batch`; it is the caller's job to make sure the download and the capture belong
 *   to the same export run (see report-online-snapshot.js for the exact claim being made).
 * onlineFull: optional { items, capturedAt } — 用网页 content/batch 抓回来的**完整版**
 *   节点正文（含 attrs/marks）。与 online 互不依赖：MCP 精简版只能用来定位，
 *   完整版才能用来写回/回溯（见 report-online-full.js）。抓不到就不传，基线降级，
 *   绝不拿精简版冒充完整版。
 * Returns {archiveDir, docxPath, manifestPath, sha256, snapshotStatus, fullStatus, evidence?}.
 * A completed archive is the atomically published `snapshot` subdirectory.
 */
export async function archiveReportBaseline({ rootDir, sourcePath, metadata, online, onlineFull } = {}) {
  if (typeof rootDir !== 'string' || !isAbsolute(rootDir) || typeof sourcePath !== 'string' || !isAbsolute(sourcePath) || extname(sourcePath).toLowerCase() !== '.docx') throw new TypeError('rootDir and .docx sourcePath must be absolute');
  const safeMetadata = metadataForArchive(metadata);
  // 先算快照与证据：身份不符要在这里就失败，不能等文件写完再回滚。
  let onlineSnapshot = { status: 'not_captured', reason: 'not_requested' };
  let evidence = null;
  let onlinePayload = null;
  if (online != null) {
    if (typeof online !== 'object' || Array.isArray(online)) throw new TypeError('online must be an object');
    const built = buildOnlineSnapshot({
      document: online.document,
      expected: { projectId: safeMetadata.projectId, companyId: safeMetadata.companyId, reportType: safeMetadata.reportType },
      capturedAt: online.capturedAt,
    });
    evidence = built.evidence;
    onlineSnapshot = {
      status: 'same_batch',
      // 只声明"同批次"，不声明密码学意义上的同版本。
      claim: 'captured in the same export run as report.docx; not a per-version proof',
      capturedAt: built.evidence.capturedAt,
      identity: built.snapshot.identity,
      astSha256: built.evidence.astSha256,
      itemCount: built.evidence.itemCount,
      complete: built.evidence.complete,
      file: 'online-snapshot.json',
    };
    onlinePayload = Buffer.from(JSON.stringify(built.snapshot), 'utf8');
  }
  // 完整版（content/batch）：与精简版快照彼此独立，抓不到就是没有，不编造。
  let onlineFullDescriptor = null;
  let onlineFullPayload = null;
  if (onlineFull != null) {
    if (typeof onlineFull !== 'object' || Array.isArray(onlineFull)) throw new TypeError('onlineFull must be an object');
    const builtFull = buildOnlineFull({
      items: onlineFull.items,
      expected: { projectId: safeMetadata.projectId, companyId: safeMetadata.companyId, reportType: safeMetadata.reportType },
      capturedAt: onlineFull.capturedAt,
    });
    onlineFullDescriptor = builtFull.descriptor;
    onlineFullPayload = Buffer.from(JSON.stringify(builtFull.payload), 'utf8');
  }
  const rootInfo = await lstat(rootDir);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('rootDir must be a real directory');
  const root = await realpath(rootDir);
  const privateDir = join(root, '.report-baselines');
  try { await mkdir(privateDir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const privateInfo = await lstat(privateDir);
  if (!privateInfo.isDirectory() || privateInfo.isSymbolicLink() || (privateInfo.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && privateInfo.uid !== process.getuid())) throw new Error('archive directory must be private and owned by current user');
  let source;
  let batch;
  try {
    source = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const before = await source.stat();
    if (!before.isFile()) throw new Error('source must be a regular file');
    if (before.size > 32 * 1024 * 1024) throw new Error('报告超过 32 MiB，比对基线未保存');
    const bytes = await source.readFile();
    const after = await source.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) throw new Error('source changed during archive');
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) throw new Error('source is not a DOCX ZIP file');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    batch = await mkdtemp(join(privateDir, 'baseline-'));
    const staging = join(batch, '.staging');
    await mkdir(staging, { mode: 0o700 });
    const manifest = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      document: { file: 'report.docx', sha256, size: bytes.length },
      metadata: safeMetadata,
      onlineSnapshot,
      // 只有真抓到完整版才写这个键；老基线没有这个键，读侧按「没有完整版」处理。
      ...(onlineFullDescriptor ? { onlineFull: onlineFullDescriptor } : {}),
    };
    const entries = [['report.docx', bytes], ['manifest.json', JSON.stringify(manifest, null, 2) + '\n']];
    if (onlinePayload) entries.push(['online-snapshot.json', onlinePayload]);
    if (onlineFullPayload) entries.push([FULL_FILE, onlineFullPayload]);
    for (const [name, data] of entries) {
      const file = await open(join(staging, name), 'wx', 0o600);
      try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    }
    const stageHandle = await open(staging, 'r');
    try { await stageHandle.sync(); } finally { await stageHandle.close(); }
    const archiveDir = join(batch, 'snapshot');
    await rename(staging, archiveDir);
    return {
      archiveDir, docxPath: join(archiveDir, 'report.docx'), manifestPath: join(archiveDir, 'manifest.json'),
      sha256, snapshotStatus: onlineSnapshot.status,
      fullStatus: onlineFullDescriptor ? 'same_batch' : 'not_captured',
      ...(evidence ? { evidence } : {}),
    };
  } catch (error) {
    if (batch) await rm(batch, { recursive: true, force: true });
    throw error;
  } finally {
    if (source) await source.close();
  }
}

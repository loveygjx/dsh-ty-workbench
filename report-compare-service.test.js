import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, symlink, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { archiveReportBaseline } from './report-baseline.js';
import { listBaselines, compareUpload } from './report-compare-service.js';
import { buildOnlineSnapshot } from './report-online-snapshot.js';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'compare-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const make = (filename, text) => {
    const py = "import sys,zipfile\np=sys.argv[1]; text=sys.argv[2]\nxml='<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>'+text+'</w:t></w:r></w:p></w:body></w:document>'\nwith zipfile.ZipFile(p,'w') as z: z.writestr('word/document.xml',xml)";
    const r = spawnSync('python3', ['-c', py, filename, text]);
    assert.equal(r.status, 0);
  };
  const a = join(root, 'a.docx'), b = join(root, 'b.docx');
  make(a, 'old'); make(b, 'new');
  const archive = await archiveReportBaseline({ rootDir: root, sourcePath: a, metadata: { projectId: '123', reportType: 'report' } });
  const baselineId = basename(dirname(archive.archiveDir));
  return { root, a, b, archive, baselineId, base64: (await readFile(b)).toString('base64') };
}

test('verified listing and local comparison', async t => {
  const f = await setup(t);
  const list = await listBaselines({ rootDir: f.root, projectId: '123' });
  assert.equal(list.length, 1); assert.equal(list[0].id, f.baselineId);
  assert.equal(list[0].sha256, f.archive.sha256); assert.equal(list[0].onlineSnapshot.status, 'not_captured');
  assert.deepEqual(await listBaselines({ rootDir: f.root, projectId: 'other' }), []);
  const result = await compareUpload({ rootDir: f.root, baselineId: f.baselineId, filename: 'review.docx', base64: f.base64 });
  assert.equal(result.ok, true); assert.equal(result.readOnly, true); assert.equal(result.writebackSupported, false);
  assert.equal(result.changes.length, 1);
  assert.ok(!(await readdir(join(f.root, '.report-baselines'))).some(x => x.startsWith('.compare-')));
});

test('rejects traversal and upload file limits', async t => {
  const f = await setup(t); const args = { rootDir: f.root, baselineId: f.baselineId, filename: 'a.docx', base64: f.base64 };
  for (const id of ['../other', f.baselineId + '/snapshot', '/tmp/x']) await assert.rejects(compareUpload({ ...args, baselineId: id }), /baselineId/);
  for (const filename of ['../a.docx', 'x\\a.docx', 'x.txt']) await assert.rejects(compareUpload({ ...args, filename }), /filename/);
  for (const data of ['bad!', 'AAAA='.repeat(3), 'A'.repeat(44_739_248)]) await assert.rejects(compareUpload({ ...args, base64: data }), /base64/);
});

test('corrupt and symbolic-link archives are never exposed or compared', async t => {
  const f = await setup(t); const args = { rootDir: f.root, baselineId: f.baselineId, filename: 'a.docx', base64: f.base64 };
  await writeFile(f.archive.docxPath, 'corrupted');
  assert.deepEqual(await listBaselines({ rootDir: f.root }), []);
  await assert.rejects(compareUpload(args), /integrity/);
  await unlink(f.archive.docxPath); await symlink(f.a, f.archive.docxPath);
  assert.deepEqual(await listBaselines({ rootDir: f.root }), []);
  await assert.rejects(compareUpload(args));
});

test('failed comparison removes temporary documents', async t => {
  const f = await setup(t);
  await assert.rejects(compareUpload({ rootDir: f.root, baselineId: f.baselineId, filename: 'bad.docx', base64: Buffer.from('not a zip').toString('base64') }), /comparison failed/);
  assert.ok(!(await readdir(join(f.root, '.report-baselines'))).some(x => x.startsWith('.compare-')));
});

/** 带线上快照的基线：DOCX 与 itemList 成对归档。 */
async function setupOnline(t) {
  const root = await mkdtemp(join(tmpdir(), 'compare-online-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mk = (filename, text) => {
    const py = "import sys,zipfile\np=sys.argv[1]; text=sys.argv[2]\nxml='<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>'+text+'</w:t></w:r></w:p></w:body></w:document>'\nwith zipfile.ZipFile(p,'w') as z: z.writestr('word/document.xml',xml)";
    assert.equal(spawnSync('python3', ['-c', py, filename, text]).status, 0);
  };
  // 基线 DOCX 只有一段正文；上传件改了这一段的文字。
  const a = join(root, 'a.docx'), b = join(root, 'b.docx');
  mk(a, '原句：本报告仅供委托人使用。');
  mk(b, '改句：本报告仅供委托人与监管机构使用。');
  const itemList = [{
    id: '900000000000004', itemType: 4, itemName: '声明',
    itemContent: { itemId: '900000000000004', itemType: 4, text: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: '原句：本报告仅供委托人使用。' }] },
    ] } },
    subItemList: [],
  }];
  const archive = await archiveReportBaseline({
    rootDir: root, sourcePath: a,
    metadata: { projectId: '110804796309505', companyId: '110804796309543', reportType: '2' },
    online: {
      capturedAt: '2026-11-22T15:40:00.000Z',
      document: { basicInfo: { projectId: 110804796309505, companyId: 110804796309543, reportType: 2 }, itemList, warnings: [] },
    },
  });
  return { root, archive, baselineId: basename(dirname(archive.archiveDir)), base64: (await readFile(b)).toString('base64') };
}

test('baseline with an online snapshot lists as same_batch and locates the changed paragraph', async t => {
  const f = await setupOnline(t);
  const list = await listBaselines({ rootDir: f.root, projectId: '110804796309505' });
  assert.equal(list.length, 1);
  assert.equal(list[0].onlineSnapshot.status, 'same_batch');
  assert.equal(list[0].onlineSnapshot.itemCount, 1);
  assert.equal(list[0].onlineSnapshot.complete, true);

  const result = await compareUpload({ rootDir: f.root, baselineId: f.baselineId, filename: 'review.docx', base64: f.base64 });
  assert.equal(result.ok, true);
  assert.equal(result.locate.available, true);
  assert.equal(result.locate.writebackAllowed, false, '定位成功也不允许写回');
  assert.equal(result.locate.counts.located, 1);
  const hit = result.locate.located[0];
  assert.equal(hit.candidate.itemId, '900000000000004');
  assert.equal(hit.candidate.blockIndex, 0);
  assert.equal(hit.writebackAllowed, false);
  assert.equal(hit.requiresHumanReview, true);
});

test('baseline without an online snapshot still compares, but reports locating unavailable', async t => {
  const f = await setup(t);
  const result = await compareUpload({ rootDir: f.root, baselineId: f.baselineId, filename: 'review.docx', base64: f.base64 });
  assert.equal(result.ok, true);
  assert.equal(result.locate.available, false);
  assert.match(result.locate.reason, /no online snapshot/);
});

test('tampered online snapshot is rejected instead of used for locating', async t => {
  const f = await setupOnline(t);
  const file = join(f.archive.archiveDir, 'online-snapshot.json');
  const data = JSON.parse(await readFile(file, 'utf8'));
  data.itemList[0].itemContent.text.content[0].content[0].text = '被篡改的句子';
  await writeFile(file, JSON.stringify(data));
  assert.deepEqual(await listBaselines({ rootDir: f.root }), []);
  await assert.rejects(compareUpload({ rootDir: f.root, baselineId: f.baselineId, filename: 'review.docx', base64: f.base64 }), /integrity/);
});

// ---------- 现场比对通道（不依赖归档基线） ----------
//
// 用户要求"只上传改稿，自动跟线上比"，所以比对入口必须能接受
// 「宿主当场下载的 DOCX 字节 + 当场抓的节点树」，而完全不碰 .report-baselines。

test('compareAgainstLive：用宿主给的 DOCX 与节点树定位，不需要归档基线', async t => {
  const root = await mkdtemp(join(tmpdir(), 'compare-live-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mk = (filename, text) => {
    const py = "import sys,zipfile\np=sys.argv[1]; text=sys.argv[2]\nxml='<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>'+text+'</w:t></w:r></w:p></w:body></w:document>'\nwith zipfile.ZipFile(p,'w') as z: z.writestr('word/document.xml',xml)";
    assert.equal(spawnSync('python3', ['-c', py, filename, text]).status, 0);
  };
  const a = join(root, 'live.docx'), b = join(root, 'edited.docx');
  mk(a, '原句：本报告仅供委托人使用。');
  mk(b, '改句：本报告仅供委托人与监管机构使用。');
  const baselineBytes = await readFile(a);

  const itemList = [{
    id: '900000000000005', itemType: 4, itemName: '声明',
    itemContent: { itemId: '900000000000005', itemType: 4, text: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: '原句：本报告仅供委托人使用。' }] },
    ] } },
    subItemList: [],
  }];
  const document = { basicInfo: { projectId: 110804796309505, companyId: 110804796309543, reportType: 2 }, itemList, warnings: [] };

  // 归档基线目录根本不存在 —— 证明这条通道完全不依赖它。
  const { compareAgainstLive } = await import('./report-compare-service.js');
  // 与宿主 captureLiveSnapshot 同一套：定位器要的是 {snapshot:{identity,itemList}, evidence}。
  const online = buildOnlineSnapshot({
    document,
    expected: { projectId: '110804796309505', companyId: '110804796309543', reportType: '2' },
    capturedAt: '2026-11-23T01:00:00.000Z',
  });
  const result = await compareAgainstLive({
    rootDir: root,
    baselineBytes,
    online,
    filename: 'edited.docx',
    base64: (await readFile(b)).toString('base64'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.locate.available, true, '有节点树就必须能定位');
  assert.equal(result.locate.counts.located, 1);
  assert.equal(result.locate.located[0].candidate.itemId, '900000000000005');
  assert.equal(result.locate.located[0].candidate.blockIndex, 0);
  assert.equal(result.locate.located[0].writebackAllowed, false, '定位成功也不允许写回');
  // 临时文件必须清掉：报告正文不能留在磁盘上。
  assert.ok(!(await readdir(join(root, '.report-baselines'))).some(x => x.startsWith('.compare-')));
});

test('compareAgainstLive：缺 DOCX 字节或超过体积上限都拒绝', async t => {
  const root = await mkdtemp(join(tmpdir(), 'compare-live-bad-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { compareAgainstLive } = await import('./report-compare-service.js');
  const online = { snapshot: { itemList: [] }, evidence: {} };
  await assert.rejects(compareAgainstLive({ rootDir: root, filename: 'a.docx', base64: 'QUJD', online }), /missing live baseline document/);
  await assert.rejects(
    compareAgainstLive({ rootDir: root, baselineBytes: Buffer.alloc(0), filename: 'a.docx', base64: 'QUJD', online }),
    /missing live baseline document/,
  );
  await assert.rejects(
    compareAgainstLive({ rootDir: root, baselineBytes: Buffer.alloc(33 * 1024 * 1024), filename: 'a.docx', base64: 'QUJD', online }),
    /exceeds limit/,
  );
  // 上传件的文件名/base64 校验与归档通道共用同一套
  await assert.rejects(compareAgainstLive({ rootDir: root, baselineBytes: Buffer.from('x'), filename: '../a.docx', base64: 'QUJD', online }), /filename/);
  await assert.rejects(compareAgainstLive({ rootDir: root, baselineBytes: Buffer.from('x'), filename: 'a.docx', base64: 'bad!', online }), /base64/);
});

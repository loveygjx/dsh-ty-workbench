import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, symlink, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { archiveReportBaseline } from './report-baseline.js';
import { listBaselines, compareUpload, compareAgainstLive } from './report-compare-service.js';
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

test('重复段落按序配对：同一句话线上两份、用户两份都改，必须全部定位', async t => {
  // 真实场景（浙江交投金属 V4）：「截至评估基准日，纳入评估范围的6项房屋建筑物
  // 尚未取得不动产权证…」在摘要里是「(二) …」、正文里是「1. …」，线上存的是
  // 去掉序号后完全相同的一句话。用户两处都改成了"不动产权证书"。
  // 单看一处是"出现多次无法定位"，但整批看是确定的：2 处改动 ↔ 线上 2 份，
  // 改法一致，按文档顺序一一对应即可。以前这种会被全部拒绝。
  const root = await mkdtemp(join(tmpdir(), 'compare-dup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const mkDoc = (filename, paras) => {
    const body = paras.map(p => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
    const xml = `<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`;
    const py = "import sys,zipfile\np=sys.argv[1]; x=sys.argv[2]\nwith zipfile.ZipFile(p,'w') as z: z.writestr('word/document.xml',x)";
    assert.equal(spawnSync('python3', ['-c', py, filename, xml]).status, 0);
  };
  const OLD = '截至评估基准日，纳入评估范围的6项房屋建筑物尚未取得不动产权证，具体如下：';
  const NEW = '截至评估基准日，纳入评估范围的6项房屋建筑物尚未取得不动产权证书，具体如下：';
  const a = join(root, 'live.docx'), b = join(root, 'edited.docx');
  mkDoc(a, ['开头', `(二) ${OLD}`, '中间', `1. ${OLD}`, '结尾']);
  mkDoc(b, ['开头', `(二) ${NEW}`, '中间', `1. ${NEW}`, '结尾']);

  const itemList = [
    { id: '900000000000011', itemType: 4, itemName: '摘要', subItemList: [],
      itemContent: { itemId: '900000000000011', itemType: 4, text: { type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: `(二) ${OLD}` }] }] } } },
    { id: '900000000000012', itemType: 4, itemName: '正文', subItemList: [],
      itemContent: { itemId: '900000000000012', itemType: 4, text: { type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: `1. ${OLD}` }] }] } } },
  ];
  const document = { basicInfo: { projectId: 110804796309505, companyId: 110804796309543, reportType: 2 }, itemList, warnings: [] };
  const { compareAgainstLive } = await import('./report-compare-service.js');
  const online = buildOnlineSnapshot({
    document,
    expected: { projectId: '110804796309505', companyId: '110804796309543', reportType: '2' },
    capturedAt: '2026-11-23T02:00:00.000Z',
  });
  const result = await compareAgainstLive({
    rootDir: root, baselineBytes: await readFile(a), online,
    filename: 'edited.docx', base64: (await readFile(b)).toString('base64'),
  });

  assert.equal(result.locate.counts.refused, 0, '两处都必须定位，不能因为重复而拒绝');
  assert.equal(result.locate.counts.located, 2);
  const ids = result.locate.located.map(x => x.candidate.itemId).sort();
  assert.deepEqual(ids, ['900000000000011', '900000000000012'], '两处分别落到摘要节点与正文节点');
});

test('重复段落按序配对：线上份数与改动数不等时必须放弃，宁可不配也不错配', async t => {
  // 边界：线上有 2 份相同段落，用户只改了 1 处 —— 这时无法确定改的是哪一份，
  // 必须仍然拒绝。写回是整节点覆盖，配错就是覆盖错的段落。
  const root = await mkdtemp(join(tmpdir(), 'compare-dup2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const mkDoc = (filename, paras) => {
    const body = paras.map(p => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
    const xml = `<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`;
    const py = "import sys,zipfile\np=sys.argv[1]; x=sys.argv[2]\nwith zipfile.ZipFile(p,'w') as z: z.writestr('word/document.xml',x)";
    assert.equal(spawnSync('python3', ['-c', py, filename, xml]).status, 0);
  };
  const OLD = '这句话在报告里出现了两次，不得靠顺序猜。';
  const NEW = '这句话在报告里出现了两次，已改成新的说法。';
  const a = join(root, 'live.docx'), b = join(root, 'edited.docx');
  // 线上 2 份；改稿只改其中 1 份（另一份原样保留）
  mkDoc(a, [OLD, '中间', OLD]);
  mkDoc(b, [NEW, '中间', OLD]);

  const mkItem = (id, name, text) => ({
    id, itemType: 4, itemName: name, subItemList: [],
    itemContent: { itemId: id, itemType: 4, text: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text }] }] } },
  });
  const itemList = [mkItem('900000000000021', '甲', OLD), mkItem('900000000000022', '乙', OLD)];
  const document = { basicInfo: { projectId: 110804796309505, companyId: 110804796309543, reportType: 2 }, itemList, warnings: [] };
  const { compareAgainstLive } = await import('./report-compare-service.js');
  const online = buildOnlineSnapshot({
    document,
    expected: { projectId: '110804796309505', companyId: '110804796309543', reportType: '2' },
    capturedAt: '2026-11-23T03:00:00.000Z',
  });
  const result = await compareAgainstLive({
    rootDir: root, baselineBytes: await readFile(a), online,
    filename: 'edited.docx', base64: (await readFile(b)).toString('base64'),
  });
  assert.equal(result.locate.counts.located, 0, '只有一处改动但线上有两份，必须拒绝');
  assert.ok(result.locate.counts.refused >= 1);
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

// ---------- 未配对内容：区分「线上有但没配上」与「线上根本没有（附件渲染）」 ----------
//
// 血泪教训（实测浙江交投金属 type=1）：报告里有 3 个 itemType===1 的上传 Word 附件节点，
// 它们的 itemContent.text 是 null —— 正文根本不在节点里，是渲染时才从 docx 抽出来塞进
// 报告的。用户改到这些内容，比对出来必然 unpaired。过去界面统一标「重复或结构变化」，
// 让人以为是定位算法不行、再多试几次就好；真实答案是这个内容线上改不了字，只能整份
// 替换附件文件。这两件事必须分开说。

test('未配对内容来自上传的 Word 附件时，必须如实标注 attachment，不能笼统说"重复或结构变化"', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rc-att-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const mkDoc = (filename, paras) => {
    const body = paras.map(p => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
    const xml = `<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`;
    const py = "import sys,zipfile\np=sys.argv[1]; x=sys.argv[2]\nwith zipfile.ZipFile(p,'w') as z: z.writestr('word/document.xml',x)";
    assert.equal(spawnSync('python3', ['-c', py, filename, xml]).status, 0);
  };
  const plain = '这是普通正文段落，线上有对应节点。';
  // 真实形状：这句话是附件渲染进报告 docx 的，所以 baseline docx 里有；
  // 但线上节点里没有（content/batch 对附件返回 text:null）。
  const attOld = '这段文字只存在于上传的 Word 附件里，节点正文是空的。';
  const attNew = '这段文字只存在于上传的 Word 附件里，节点正文更本没有。';
  const basePath = join(dir, 'b.docx');
  const modPath = join(dir, 'm.docx');
  mkDoc(basePath, [plain, attOld]);
  mkDoc(modPath, [plain, attNew]);
  const online = {
    document: {
      basicInfo: { projectId: 1, companyId: 2, reportType: 1 },
      itemList: [
        {
          id: '900000000000101',
          itemType: 4,
          itemName: '正文',
          itemContent: {
            itemId: '900000000000101',
            itemType: 4,
            text: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: plain }] }] },
          },
          subItemList: [],
        },
        // 附件节点：有 itemType=1，但 text 为 null（线上就是这个形状）
        {
          id: '900000000000102',
          itemType: 1,
          itemName: 'word文件-说明',
          itemContent: { itemId: '900000000000102', itemType: 1, text: null, fileName: 'x.docx', attachId: '900000000000199' },
          subItemList: [],
        },
      ],
      warnings: [],
    },
    expected: { projectId: 1, companyId: 2, reportType: 1 },
    capturedAt: new Date().toISOString(),
  };
  const built = buildOnlineSnapshot(online);
  const result = await compareAgainstLive({
    rootDir: dir,
    baselineBytes: await readFile(basePath),
    online: built,
    filename: 'm.docx',
    base64: (await readFile(modPath)).toString('base64'),
  });
  const refused = result.locate.refused;
  assert.ok(refused.length >= 1, '新增的附件内容应当进入未配对');
  const att = refused.find(x => /上传的 Word 附件/.test(String(x.note)));
  assert.ok(att, '必须有一条被标注为附件渲染');
  assert.equal(att.attachment, true);
  assert.equal(att.inline, false);
});

test('未配对内容线上确实有这段文字时，标 inline（重复/结构变化），不能说成附件', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rc-inl-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const mkDoc = (filename, paras) => {
    const body = paras.map(p => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
    const xml = `<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`;
    const py = "import sys,zipfile\np=sys.argv[1]; x=sys.argv[2]\nwith zipfile.ZipFile(p,'w') as z: z.writestr('word/document.xml',x)";
    assert.equal(spawnSync('python3', ['-c', py, filename, xml]).status, 0);
  };
  // 同一段文字线上两份，改稿把两份改成不同内容 → 按序配对也救不了，只能未配对
  const a = '同一句话在线上出现了两次。';
  const basePath = join(dir, 'b.docx');
  const modPath = join(dir, 'm.docx');
  mkDoc(basePath, [a, a]);
  mkDoc(modPath, ['同一句话改成甲了。', '同一句话改成乙了。']);
  const online = {
    document: {
      basicInfo: { projectId: 1, companyId: 2, reportType: 1 },
      itemList: [
        {
          id: '900000000000201',
          itemType: 4,
          itemName: '正文',
          itemContent: {
            itemId: '900000000000201',
            itemType: 4,
            text: {
              type: 'doc',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: a }] },
                { type: 'paragraph', content: [{ type: 'text', text: a }] },
              ],
            },
          },
          subItemList: [],
        },
      ],
      warnings: [],
    },
    expected: { projectId: 1, companyId: 2, reportType: 1 },
    capturedAt: new Date().toISOString(),
  };
  const built = buildOnlineSnapshot(online);
  const result = await compareAgainstLive({
    rootDir: dir,
    baselineBytes: await readFile(basePath),
    online: built,
    filename: 'm.docx',
    base64: (await readFile(modPath)).toString('base64'),
  });
  const refused = result.locate.refused;
  assert.ok(refused.length >= 1);
  const inl = refused.find(x => x.note && /无法唯一对上|重复或结构变化/.test(String(x.note)));
  assert.ok(inl, '线上确实有的文字，应当标 inline 而不是附件');
  assert.equal(inl.attachment, false);
  assert.equal(inl.inline, true);
});

test('locate 必须带回附件清单，让用户知道该去哪个文件改', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rc-attlist-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const mkDoc = (filename, paras) => {
    const body = paras.map(p => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
    const xml = `<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`;
    const py = "import sys,zipfile\np=sys.argv[1]; x=sys.argv[2]\nwith zipfile.ZipFile(p,'w') as z: z.writestr('word/document.xml',x)";
    assert.equal(spawnSync('python3', ['-c', py, filename, xml]).status, 0);
  };
  const basePath = join(dir, 'b.docx');
  const modPath = join(dir, 'm.docx');
  mkDoc(basePath, ['正文一段。']);
  mkDoc(modPath, ['正文一段改过。']);
  const built = buildOnlineSnapshot({
    document: {
      basicInfo: { projectId: 1, companyId: 2, reportType: 1 },
      itemList: [
        { id: '900000000000301', itemType: 4, itemName: '正文', subItemList: [],
          itemContent: { itemId: '900000000000301', itemType: 4, text: { type: 'doc', content: [
            { type: 'paragraph', content: [{ type: 'text', text: '正文一段。' }] }] } } },
        { id: '900000000000302', itemType: 1, itemName: 'word文件-说明', subItemList: [],
          itemContent: { itemId: '900000000000302', itemType: 1, text: null, fileName: '未办权证说明.docx', attachId: '900000000000399' } },
      ],
      warnings: [],
    },
    expected: { projectId: 1, companyId: 2, reportType: 1 },
    capturedAt: new Date().toISOString(),
  });
  const result = await compareAgainstLive({
    rootDir: dir,
    baselineBytes: await readFile(basePath),
    online: built,
    filename: 'm.docx',
    base64: (await readFile(modPath)).toString('base64'),
  });
  assert.ok(Array.isArray(result.locate.attachments), 'locate 必须带 attachments 数组');
  assert.equal(result.locate.attachments.length, 1);
  const a = result.locate.attachments[0];
  assert.equal(a.itemId, '900000000000302');
  assert.equal(a.fileName, '未办权证说明.docx');
  assert.equal(a.attachId, '900000000000399');
});

// ── 未配对原因的五种判定（线下新增 / 线下删除 / 表格变量 / 上传附件 / 重复）──
// 这五种处置方式完全不同，标错标签会让用户去错地方改。用真实形状的节点树守住。
test('未配对原因：线下新增的段落必须说清楚写回不会新建节点', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rc-add-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await runCase(dir, {
    nodeTexts: ['第一段。', '第二段。'],
    baseParas: ['第一段。', '第二段。'],
    modParas: ['第一段。', '第二段。', '这是线下新加的一段说明。'],
  });
  // 新增段落现在是独立的 change 类型（挂锚点写回），不再走 unpaired。
  const ins = r.changes.find(c => c.type === 'insertion');
  assert.ok(ins, '新增段落必须识别成 insertion');
  assert.match(ins.modified[0].text, /新加/);
  if (!r.locate.counts.located) {
    const hit = r.locate.refused.find(x => x.added === true);
    assert.ok(hit);
    assert.match(hit.note, /新加|新建节点/);
  }
});

test('未配对原因：线下删掉的段落必须说清楚写回不会删除节点', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rc-del-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await runCase(dir, {
    nodeTexts: ['第一段。', '第二段。', '第三段。'],
    baseParas: ['第一段。', '第二段。', '第三段。'],
    modParas: ['第一段。', '第三段。'],
  });
  const del = r.changes.find(c => c.type === 'deletion');
  assert.ok(del, '删除段落必须识别成 deletion');
  assert.match(del.baseline[0].text, /第二段/);
  if (!r.locate.counts.located) {
    const hit = r.locate.refused.find(x => x.deleted === true);
    assert.ok(hit);
    assert.match(hit.note, /删/);
  }
});

test('未配对原因：表格单元格要指向数据源，不能误报成附件', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rc-tbl-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // 节点里有 tableValue 变量块，同时也有附件节点——这正是最容易误判的组合。
  const r = await runCase(dir, {
    nodeTexts: ['正文一段。'],
    baseParas: ['正文一段。'],
    modParas: ['正文一段。'],
    tableCell: ['33,368.14'],
    modTableCell: ['33,400.00'],
    extraItems: [
      { id: '900000000000401', itemType: 4, itemName: '表格', subItemList: [],
        itemContent: { itemId: '900000000000401', itemType: 4, text: { type: 'doc', content: [
          { type: 'tableValue', attrs: { content: 'project_info.x.valuationSummaryStatement',
                                          text: '${项目信息.资产基础法-评估结论.评估结果汇总表}' } }] } } },
      { id: '900000000000402', itemType: 1, itemName: 'word文件', subItemList: [],
        itemContent: { itemId: '900000000000402', itemType: 1, text: null,
                       fileName: '说明.docx', attachId: '900000000000499' } },
    ],
  });
  const hit = r.locate.refused.find(x => x.table === true);
  assert.ok(hit, '表格单元格必须标 table=true');
  assert.equal(hit.attachment, false, '表格不能误报成附件');
  assert.match(hit.note, /数据源|明细表/);
});

// 造一对 docx 并跑一次 locate。tableCell/modTableCell 给定时插一张单格表。
async function runCase(dir, opts) {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const mk = (filename, paras, cells) => {
    const body = paras.map(t => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('');
    const tbl = cells && cells.length
      ? `<w:tbl><w:tr>${cells.map(c => `<w:tc><w:p><w:r><w:t>${c}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr></w:tbl>`
      : '';
    const xml = `<w:document xmlns:w="${W}"><w:body>${body}${tbl}</w:body></w:document>`;
    const py = "import sys,zipfile\np=sys.argv[1]; x=sys.argv[2]\nwith zipfile.ZipFile(p,'w') as z: z.writestr('word/document.xml',x)";
    assert.equal(spawnSync('python3', ['-c', py, filename, xml]).status, 0);
  };
  const basePath = join(dir, 'b.docx');
  const modPath = join(dir, 'm.docx');
  mk(basePath, opts.baseParas, opts.tableCell);
  mk(modPath, opts.modParas, opts.modTableCell);
  const items = (opts.nodeTexts || []).map((t, i) => ({
    id: '90000000000050' + i, itemType: 4, itemName: 'n' + i, subItemList: [],
    itemContent: { itemId: '90000000000050' + i, itemType: 4,
      text: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] } },
  })).concat(opts.extraItems || []);
  const built = buildOnlineSnapshot({
    document: { basicInfo: { projectId: 1, companyId: 2, reportType: 1 }, itemList: items, warnings: [] },
    expected: { projectId: 1, companyId: 2, reportType: 1 },
    capturedAt: new Date().toISOString(),
  });
  return compareAgainstLive({
    rootDir: dir, baselineBytes: await readFile(basePath), online: built,
    filename: 'm.docx', base64: (await readFile(modPath)).toString('base64'),
  });
}

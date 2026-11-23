import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archiveReportBaseline } from './report-baseline.js';
import { buildOnlineFull, verifyOnlineFull, digestOf, MAX_FULL_ITEMS, FULL_FILE } from './report-online-full.js';

const fakeDocx = Buffer.from('504b030466616b652d7a6970', 'hex');
const META = { projectId: '110804796309505', companyId: '110804796309543', reportType: '2', companyName: '测试公司', version: '5' };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'report-online-full-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, 'final.docx');
  await writeFile(sourcePath, fakeDocx);
  return { root, sourcePath };
}

// 完整版的最小可信形状：段落带 attrs，文字 run 带 marks。
const fullParagraph = { type: 'paragraph', attrs: { textAlign: 'justify', indent: 1, lineHeight: '150%' }, content: [{ type: 'text', marks: [{ type: 'textStyle', attrs: { fontFamily: '宋体', fontSize: 12 } }], text: '原句：本报告仅供委托人使用。' }] };
const fullItems = [{ itemId: '900000000000004', itemType: 4, text: JSON.stringify({ type: 'doc', content: [fullParagraph] }) }];

test('buildOnlineFull keeps attrs and marks verbatim and digests stably', () => {
  const { payload, descriptor } = buildOnlineFull({ items: fullItems, expected: META, capturedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(descriptor.itemCount, 1);
  assert.equal(descriptor.file, FULL_FILE);
  assert.equal(descriptor.status, 'same_batch');
  // 完整版的核心：attrs 与 marks 必须原样保留，否则写回会让天源报 content.attrs is null。
  const parsed = JSON.parse(payload.items[0].text);
  assert.deepEqual(parsed.content[0].attrs, { textAlign: 'justify', indent: 1, lineHeight: '150%' });
  assert.deepEqual(parsed.content[0].content[0].marks, [{ type: 'textStyle', attrs: { fontFamily: '宋体', fontSize: 12 } }]);
  // 抓取顺序不影响摘要。
  const reversed = buildOnlineFull({ items: [...fullItems, { itemId: '2', itemType: 4, text: '{"type":"doc","content":[]}' }], expected: META, capturedAt: 'x' });
  const shuffled = buildOnlineFull({ items: [{ itemId: '2', itemType: 4, text: '{"type":"doc","content":[]}' }, ...fullItems], expected: META, capturedAt: 'x' });
  assert.equal(reversed.descriptor.astSha256, shuffled.descriptor.astSha256);
});

test('buildOnlineFull rejects missing identity, duplicates, empty text and oversized text', () => {
  assert.throws(() => buildOnlineFull({ items: fullItems, expected: {} }), /身份/);
  assert.throws(() => buildOnlineFull({ items: null, expected: META }), /节点内容/);
  assert.throws(() => buildOnlineFull({ items: [], expected: META }), /为空/);
  assert.throws(() => buildOnlineFull({ items: [{ itemId: '', text: '{}' }], expected: META }), /itemId/);
  assert.throws(() => buildOnlineFull({ items: [fullItems[0], fullItems[0]], expected: META }), /重复/);
  assert.throws(() => buildOnlineFull({ items: [{ itemId: '1' }], expected: META }), /正文/);
  // 单节点正文超过 4 MiB 必须拒绝，不能让它悄悄进快照。
  assert.throws(() => buildOnlineFull({ items: [{ itemId: '1', text: 'x'.repeat(4 * 1024 * 1024 + 1) }], expected: META }), /超过上限/);
});

test('verifyOnlineFull rejects tampered payloads and mismatched identity', () => {
  const { payload, descriptor } = buildOnlineFull({ items: fullItems, expected: META, capturedAt: '2026-01-01T00:00:00.000Z' });
  assert.ok(verifyOnlineFull(payload, descriptor));
  const tampered = JSON.parse(JSON.stringify(payload));
  tampered.items[0].text = tampered.items[0].text.replace('委托人使用', '委托人及监管机构使用');
  assert.throws(() => verifyOnlineFull(tampered, descriptor), /摘要/);
  assert.throws(() => verifyOnlineFull(payload, { ...descriptor, itemCount: 2 }), /节点数/);
  assert.throws(() => verifyOnlineFull(payload, { ...descriptor, file: 'other.json' }), /文件名/);
  assert.throws(() => verifyOnlineFull(payload, { ...descriptor, astSha256: 'zz' }), /摘要非法/);
  const otherIdentity = JSON.parse(JSON.stringify(payload));
  otherIdentity.identity.companyId = '999';
  assert.throws(() => verifyOnlineFull(otherIdentity, descriptor), /身份/);
});

test('archive without onlineFull keeps the old shape (no extra file, no onlineFull key)', async t => {
  const { root, sourcePath } = await fixture(t);
  const out = await archiveReportBaseline({ rootDir: root, sourcePath, metadata: META });
  assert.equal(out.fullStatus, 'not_captured');
  assert.deepEqual((await readdir(out.archiveDir)).sort(), ['manifest.json', 'report.docx']);
  const manifest = JSON.parse(await readFile(out.manifestPath, 'utf8'));
  assert.equal(manifest.onlineFull, undefined);
});

test('archive with onlineFull writes a verifiable online-full.json next to the docx', async t => {
  const { root, sourcePath } = await fixture(t);
  const out = await archiveReportBaseline({ rootDir: root, sourcePath, metadata: META, onlineFull: { items: fullItems, capturedAt: '2026-01-01T00:00:00.000Z' } });
  assert.equal(out.fullStatus, 'same_batch');
  assert.deepEqual((await readdir(out.archiveDir)).sort(), ['manifest.json', 'online-full.json', 'report.docx']);
  const manifest = JSON.parse(await readFile(out.manifestPath, 'utf8'));
  assert.equal(manifest.onlineFull.file, FULL_FILE);
  assert.equal(manifest.onlineFull.itemCount, 1);
  assert.equal((await stat(join(out.archiveDir, FULL_FILE))).mode & 0o777, 0o600);
  const stored = JSON.parse(await readFile(join(out.archiveDir, FULL_FILE), 'utf8'));
  assert.equal(digestOf(stored), manifest.onlineFull.astSha256);
  assert.ok(verifyOnlineFull(stored, manifest.onlineFull));
  // 完整版里必须有 attrs 和 marks，否则等于又存了一份精简版。
  const parsed = JSON.parse(stored.items[0].text);
  assert.ok(parsed.content[0].attrs, 'attrs 必须存在');
  assert.ok(parsed.content[0].content[0].marks, 'marks 必须存在');
});

test('archive rejects malformed onlineFull before touching the archive root', async t => {
  const { root, sourcePath } = await fixture(t);
  await assert.rejects(archiveReportBaseline({ rootDir: root, sourcePath, metadata: META, onlineFull: 'nope' }), /onlineFull must be an object/);
  await assert.rejects(archiveReportBaseline({ rootDir: root, sourcePath, metadata: META, onlineFull: { items: [] } }), /为空/);
  // 两个失败都发生在建目录之前：不留下半截批次，也不污染归档根。
  await assert.rejects(readdir(join(root, '.report-baselines')), { code: 'ENOENT' });
});

test('MAX_FULL_ITEMS is a documented numeric guard', () => {
  assert.equal(typeof MAX_FULL_ITEMS, 'number');
  assert.ok(MAX_FULL_ITEMS >= 1000);
});

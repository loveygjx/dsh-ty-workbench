import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { archiveReportBaseline } from './report-baseline.js';

const fakeDocx = Buffer.from('504b030466616b652d7a6970', 'hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'report-baseline-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, 'final.docx');
  await writeFile(sourcePath, fakeDocx);
  return { root, sourcePath };
}

test('archives exact final bytes, digest and allowlisted metadata without online snapshot', async t => {
  const { root, sourcePath } = await fixture(t);
  const out = await archiveReportBaseline({ rootDir: root, sourcePath, metadata: { projectId: 1, companyName: '测试公司', reportType: '报告', version: 2, token: 'never-save-this' } });
  const data = await readFile(out.docxPath);
  const text = await readFile(out.manifestPath, 'utf8');
  const manifest = JSON.parse(text);
  assert.deepEqual(data, fakeDocx);
  assert.equal(out.sha256, createHash('sha256').update(data).digest('hex'));
  assert.equal(manifest.document.sha256, out.sha256);
  assert.deepEqual(manifest.metadata, { projectId: '1', companyName: '测试公司', reportType: '报告', version: '2' });
  assert.deepEqual(manifest.onlineSnapshot, { status: 'not_captured', reason: 'not_requested' });
  assert.equal(out.snapshotStatus, 'not_captured');
  assert.ok(!text.includes('never-save-this') && !text.includes(sourcePath));
  assert.deepEqual(await readFile(sourcePath), fakeDocx);
  assert.equal((await lstat(join(root, '.report-baselines'))).mode & 0o777, 0o700);
  assert.equal((await lstat(out.docxPath)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(out.archiveDir)).sort(), ['manifest.json', 'report.docx']);
});

test('concurrent saves never overwrite prior archives', async t => {
  const { root, sourcePath } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => archiveReportBaseline({ rootDir: root, sourcePath })));
  assert.equal(new Set(results.map(x => x.archiveDir)).size, 8);
  for (const result of results) assert.deepEqual(await readFile(result.docxPath), fakeDocx);
});

test('rejects relative paths, non-DOCX, invalid data and sensitive metadata', async t => {
  const { root, sourcePath } = await fixture(t);
  await assert.rejects(archiveReportBaseline({ rootDir: '.', sourcePath }), /absolute/);
  await assert.rejects(archiveReportBaseline({ rootDir: root, sourcePath: join(root, 'x.txt') }), /absolute/);
  await assert.rejects(archiveReportBaseline({ rootDir: root, sourcePath, metadata: { projectName: 'token=secret' } }), /unsafe metadata/);
  await writeFile(sourcePath, 'not a zip');
  await assert.rejects(archiveReportBaseline({ rootDir: root, sourcePath }), /not a DOCX/);
  assert.deepEqual(await readdir(join(root, '.report-baselines')), []);
});

test('rejects symlink sources and archive directories, and insecure directory permissions', async t => {
  const { root, sourcePath } = await fixture(t);
  const link = join(root, 'link.docx');
  await symlink(sourcePath, link);
  await assert.rejects(archiveReportBaseline({ rootDir: root, sourcePath: link }));
  const root2 = join(root, 'second'); await mkdir(root2);
  await symlink(root, join(root2, '.report-baselines'));
  await assert.rejects(archiveReportBaseline({ rootDir: root2, sourcePath }), /private/);
  const root3 = join(root, 'third'); await mkdir(root3);
  await mkdir(join(root3, '.report-baselines'), { mode: 0o755 });
  await assert.rejects(archiveReportBaseline({ rootDir: root3, sourcePath }), /private/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const engine = path.join(path.dirname(fileURLToPath(import.meta.url)), 'report-diff.py');
const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const wrap = body => `<w:document xmlns:w="${ns}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>${body}</w:body></w:document>`;
const p = t => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
const table = t => `<w:tbl><w:tr><w:tc>${p(t)}</w:tc></w:tr></w:tbl>`;
function fixture(xml, extras = [], stored = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-diff-'));
  const file = path.join(dir, 'input.docx');
  const script = `import sys,json,zipfile\nf=sys.argv[1]\nx=json.loads(sys.stdin.read())\nwith zipfile.ZipFile(f,'w',zipfile.ZIP_STORED if sys.argv[2]=='stored' else zipfile.ZIP_DEFLATED) as z:\n for name,data in x: z.writestr(name,data)\n`;
  const r = spawnSync('python3', ['-c', script, file, stored ? 'stored' : 'deflated'], { input: JSON.stringify([['word/document.xml', xml], ...extras]), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { dir, file };
}
function run(a, b, request) {
  const r = spawnSync('python3', [engine], { input: request ?? JSON.stringify({ baseline: a, modified: b }), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return { status: r.status, result: JSON.parse(r.stdout) };
}
function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function withDocs(xml1, xml2, fn, extras = []) {
  const a = fixture(xml1, extras), b = fixture(xml2);
  try { fn(a.file, b.file); } finally { fs.rmSync(a.dir, { recursive: true, force: true }); fs.rmSync(b.dir, { recursive: true, force: true }); }
}
test('paragraph and table cell edits are separated and originals unchanged', () => {
  withDocs(wrap(p('anchor') + p('old') + table('cell old') + p('end')), wrap(p('anchor') + p('new') + table('cell new') + p('end')), (a, b) => {
    const before = [digest(a), digest(b)];
    const { status, result } = run(a, b);
    assert.equal(status, 0); assert.equal(result.readOnly, true); assert.equal(result.writebackSupported, false);
    // 段数与类型逐位对齐时按位置配对：正文改动和表格单元格改动各自独立成条，
    // 而不是被并成一组"未配对"让用户找不到改在哪。
    assert.equal(result.changes.length, 2);
    assert.deepEqual(result.changes.map(x => x.type), ['candidate_change', 'candidate_change']);
    assert.equal(result.changes[0].baseline.kind, 'paragraph');
    assert.equal(result.changes[0].baseline.text, 'old');
    assert.equal(result.changes[1].baseline.kind, 'table_cell_paragraph');
    assert.equal(result.changes[1].baseline.text, 'cell old');
    assert.deepEqual([digest(a), digest(b)], before);
  });
});
test('unique one-to-one change is only a candidate', () => {
  withDocs(wrap(p('before') + p('old') + p('after')), wrap(p('before') + p('new') + p('after')), (a, b) => {
    const { result } = run(a, b); assert.equal(result.changes[0].type, 'candidate_change');
    assert.equal(result.changes[0].baseline.text, 'old'); assert.equal(result.changes[0].modified.text, 'new');
  });
});
test('identical revision and formula paragraphs are not reported as changes, but are counted as unchecked', () => {
  const complex = `<w:p><w:ins><w:r><w:t>repeat</w:t></w:r></w:ins><m:oMath/></w:p>`;
  withDocs(wrap(p('repeat') + complex + p('repeat')), wrap(p('repeat') + complex + p('repeat')), (a, b) => {
    const { result } = run(a, b);
    // 左右一模一样就不是改动——以前这里会报一组假的"未配对内容"。
    assert.deepEqual(result.changes, []);
    assert.ok(result.baseline.warnings.some(x => x.includes('revisions')));
    assert.ok(result.baseline.warnings.some(x => x.includes('formulas')));
    // 但公式/修订里的内容我们看不见，必须如实告诉用户有 1 处没做逐字节比较。
    assert.equal(result.unsupportedUnchanged, 1);
  }, [['word/media/image.png', 'fake']]);
});
test('identical repeated and empty paragraphs produce no false differences', () => {
  const xml = wrap(p('same') + p('same') + p('') + p('same'));
  withDocs(xml, xml, (a, b) => assert.deepEqual(run(a, b).result.changes, []));
});
test('ambiguous insertion among repeated paragraphs remains unpaired', () => {
  withDocs(wrap(p('anchor') + p('same') + p('same') + p('end')), wrap(p('anchor') + p('same') + p('same') + p('same') + p('end')), (a, b) => {
    const { result } = run(a, b); assert.equal(result.changes.length, 1); assert.equal(result.changes[0].type, 'unpaired');
    assert.equal(result.changes[0].baseline.length, 2); assert.equal(result.changes[0].modified.length, 3);
  });
});
test('20,000 repeated and unique blocks compare without quadratic alignment', { timeout: 15000 }, () => {
  const body = Array.from({ length: 20000 }, (_, i) => p(i % 2 ? '重复' : `unique-${i}`)).join('');
  const xml = wrap(body);
  withDocs(xml, xml, (a, b) => {
    const { status, result } = run(a, b); assert.equal(status, 0); assert.equal(result.baseline.blocks, 20000); assert.deepEqual(result.changes, []);
  });
});
test('accepts a 17 MiB stored XML part within bounded limits', { timeout: 15000 }, () => {
  const a = fixture(wrap(' '.repeat(17 * 1024 * 1024) + p('small text')), [], true);
  try {
    const { status, result } = run(a.file, a.file);
    assert.equal(status, 0); assert.equal(result.baseline.blocks, 1); assert.deepEqual(result.changes, []);
  } finally { fs.rmSync(a.dir, { recursive: true, force: true }); }
});
test('rejects DTD, duplicate entries, malformed XML, and invalid input', () => {
  for (const xml of [`<!DOCTYPE x [<!ENTITY e 'attack'>]>${wrap(p('&e;'))}`, '<bad>']) {
    withDocs(xml, wrap(p('ok')), (a, b) => { const r = run(a, b); assert.equal(r.status, 1); assert.equal(r.result.ok, false); });
  }
  withDocs(wrap(p('ok')), wrap(p('ok')), (a, b) => {
    assert.equal(run(a, b, '{}').status, 1);
  }, [['word/document.xml', wrap(p('duplicate'))]]);
});
test('rejects excessive expansion and traversal names', () => {
  for (const extra of [[['../evil', 'x']], [['big.txt', 'a'.repeat(1024 * 1024 + 1)]]]) {
    withDocs(wrap(p('ok')), wrap(p('ok')), (a, b) => { const r = run(a, b); assert.equal(r.status, 1); assert.equal(r.result.ok, false); }, extra);
  }
});

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
test('修订模式下的改动必须仍能被识别为候选修改（按"接受修订"处理）', () => {
  // 用户在 Word 里开着修订改稿是最典型的做法。以前一见到 <w:ins> 就把整段
  // 标成 unsupported，导致每处真实改动都变成"含变量/图片"、不可写回——
  // 等于功能对最典型的用法直接失效。
  const ins = `<w:p><w:r><w:t>截至评估基准日，尚未取得不动产权</w:t></w:r><w:ins w:id="9" w:author="张三" w:date="2026-11-23T10:00:00Z"><w:r><w:t>证书</w:t></w:r></w:ins><w:r><w:t>，具体如下：</w:t></w:r></w:p>`;
  withDocs(wrap(p('anchor') + p('截至评估基准日，尚未取得不动产权证，具体如下：')), wrap(p('anchor') + ins), (a, b) => {
    const { result } = run(a, b);
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].type, 'candidate_change', '修订里的插入应算作改动内容');
    // 文本必须等于"接受全部修订后"的样子——那才是要写回线上的内容。
    assert.equal(result.changes[0].modified.text, '截至评估基准日，尚未取得不动产权证书，具体如下：');
    assert.equal(result.changes[0].modified.unsupported, false, '修订不再是不可比较对象');
    // 但要如实告知用户：修订是按"接受"解释的，不是逐字解释。
    assert.ok(result.modified.warnings.some(x => x.includes('accepted')));
  });
});

test('修订模式下被删除的文字不计入改后文本（del 不算数）', () => {
  // 接受修订后 w:del 里的文字就没了；如果把它拼进来，
  // 改后文本会同时含新旧两版文字，写回线上就是错的。
  const withDel = `<w:p><w:r><w:t>尚未取得不动产权</w:t></w:r><w:del w:id="8" w:author="张三" w:date="2026-11-23T10:00:00Z"><w:r><w:delText>证</w:delText></w:r></w:del><w:r><w:t>书，具体如下：</w:t></w:r></w:p>`;
  withDocs(wrap(p('anchor') + p('尚未取得不动产权证书，具体如下：')), wrap(p('anchor') + withDel), (a, b) => {
    const { result } = run(a, b);
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].type, 'candidate_change');
    // delText 本来就不是 w:t，天然被跳过；这里锁定"不会再拼进来"。
    assert.equal(result.changes[0].modified.text, '尚未取得不动产权书，具体如下：');
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
test('导出占位符 0.00 被抹平成空单元格时不算改动', () => {
  // 天源导出/重新出稿会把表格里的 0.00 占位符清空，用户在 Word 里另存后
  // 这些单元格就真的空了。这是导出噪声，不是用户改的内容。
  const cell = v => `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>${v}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
  withDocs(wrap(p('anchor') + cell('0.00') + cell('0.00') + p('end')),
           wrap(p('anchor') + cell('') + cell('') + p('end')), (a, b) => {
    assert.deepEqual(run(a, b).result.changes, [], '表格里的 0.00 → 空 应被当作导出噪声跳过');
  });
});

test('占位符规则只对表格单元格生效，正文的 0.00 不会被它吞掉', () => {
  // 边界：正文里 0.00 → 另一个非空数字时，必须照常报改动。
  // （0.00 → 空 的情况由既有的"空白段落不算改动"规则覆盖，不是占位符规则。）
  withDocs(wrap(p('anchor') + p('0.00') + p('end')), wrap(p('anchor') + p('0.05') + p('end')), (a, b) => {
    const changes = run(a, b).result.changes;
    assert.equal(changes.length, 1, '正文数字改动必须报出来');
    assert.equal(changes[0].type, 'candidate_change');
    assert.equal(changes[0].baseline.text, '0.00');
    assert.equal(changes[0].modified.text, '0.05');
  });
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

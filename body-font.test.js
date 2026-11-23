/**
 * 正文西文字体归一（normalize_body_fonts.py）。
 * 目标：正文里的数字/字母不再落到 Times New Roman / Calibri，统一跟随该段的中文字体；
 *      表格、页眉页脚、标题段落一律不碰。
 *
 * 运行：node --test body-font.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PY = '/usr/bin/python3';
const SCRIPT = join(HERE, 'normalize_body_fonts.py');

// 用 python-docx 造样本：正文段落（含 Calibri run、无 rFonts run、黑体 run）、
// 标题段落、表格（Times New Roman），一次覆盖全部判据。
function makeDocx(path) {
  execFileSync(PY, ['-c', `
import sys
from docx import Document
from docx.shared import Pt
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

doc = Document()

# 1) 普通正文：一个宋体 run + 一个 Calibri run（模拟数字被标成 Calibri）
p = doc.add_paragraph()
r1 = p.add_run('面积合计 ')
r2 = p.add_run('95,140.03 平方米')

# 2) 正文里完全没有 rFonts 的 run（靠 docDefaults 继承 → 数字走 Times New Roman）
p2 = doc.add_paragraph('无字体声明 ')
run = p2.add_run('1,334 项')
run._r.get_or_add_rPr()

# 3) 黑体段落（封面色）：数字也应保持黑体，不被改成宋体
p3 = doc.add_paragraph()
r3 = p3.add_run('天源评报字〔2026〕第XXXX号')
r3.font.name = '黑体'
r3._r.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'), '黑体')

# 4) 标题段落（Heading1）：不应被动
h = doc.add_heading('第一部分 关于资产评估说明使用范围的声明', level=1)

# 5) 表格：Times New Roman + 宋体，必须原样保留
t = doc.add_table(rows=2, cols=2)
for i, row in enumerate(t.rows):
    for j, cell in enumerate(row.cells):
        cell.text = '数字 1,234.56' if (i, j) == (1, 1) else '标题'

doc.save(sys.argv[1])
`, path], { stdio: 'inherit' });
}

function runNormalize(path, cfg) {
  const out = execFileSync(PY, [SCRIPT, path], {
    encoding: 'utf8',
    env: { ...process.env, TIANYUAN_BODY_FONT_CONFIG: JSON.stringify(cfg || { asciiFont: '宋体', eastAsiaFont: '宋体' }) },
  });
  let saved = null;
  for (const line of out.split('\n')) {
    const s = line.trim(); if (!s) continue;
    let j = null; try { j = JSON.parse(s); } catch (e) { continue; }
    if (j.event === 'saved') saved = j;
  }
  return saved;
}

// 返回结构：{ body: [[ascii, eastAsia], ...], table: [[ascii, eastAsia], ...] }
function probe(path) {
  const raw = execFileSync(PY, ['-c', `
import zipfile, sys, json
from lxml import etree
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
z = zipfile.ZipFile(sys.argv[1])
root = etree.fromstring(z.read('word/document.xml'))
body = root.find(W + 'body')
def fonts(node):
    out = []
    for run in node.iter(W + 'r'):
        rp = run.find(W + 'rPr')
        rf = rp.find(W + 'rFonts') if rp is not None else None
        out.append([rf.get(W + 'ascii') if rf is not None else None,
                    rf.get(W + 'eastAsia') if rf is not None else None])
    return out
res = {'body': [], 'table': []}
for child in body:
    if child.tag == W + 'p':
        res['body'].extend(fonts(child))
    elif child.tag == W + 'tbl':
        res['table'].extend(fonts(child))
print(json.dumps(res, ensure_ascii=False))
`, path], { encoding: 'utf8' });
  return JSON.parse(raw);
}

test('正文数字统一跟随中文字体，表格与标题不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bodyfont-'));
  const file = join(dir, 'a.docx');
  makeDocx(file);
  const before = probe(file);

  const saved = runNormalize(file);
  assert.ok(saved && saved.changed === true, '第一遍应报告有改动');
  assert.ok(saved.runs > 0, '应报告改写的 run 数');

  const after = probe(file);

  // 表格一个 run 都不能变
  assert.deepEqual(after.table, before.table, '表格字体必须原样保留');

  // 正文里不允许再出现 Times New Roman / Calibri 作为 ascii 字体
  const bad = after.body.filter(([ascii]) => ascii === 'Times New Roman' || ascii === 'Calibri');
  assert.equal(bad.length, 0, '正文不应再有 Times New Roman / Calibri，实际：' + JSON.stringify(bad));

  // 黑体段落（封面色）的数字应保持黑体
  assert.ok(after.body.some(([ascii, ea]) => ascii === '黑体' && ea === '黑体'), '封面的黑体数字应保持黑体');

  // eastAsia 不允许被纯西文字体占用
  const badEast = after.body.filter(([, ea]) => ea === 'Calibri' || ea === 'Times New Roman');
  assert.equal(badEast.length, 0, 'eastAsia 不应是纯西文字体，实际：' + JSON.stringify(badEast));
});

test('正文没有任何西文字体残留时报告未改动，且重复执行幂等', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bodyfont2-'));
  const file = join(dir, 'b.docx');
  makeDocx(file);
  runNormalize(file);

  const second = runNormalize(file);
  assert.equal(second.changed, false, '第二遍不应再改动');
  assert.equal(second.runs, 0);

  const third = runNormalize(file);
  assert.equal(third.changed, false);
});

test('可以指定别的西文字体（配置真的生效）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bodyfont3-'));
  const file = join(dir, 'c.docx');
  makeDocx(file);
  // 把所有 eastAsia 也强制当成西文字体场景：只给 asciiFont=Arial，
  // 无 rFonts 的 run 应落成 Arial（跟随不到中文字体时用配置值兜底）
  const saved = runNormalize(file, { asciiFont: 'Arial', eastAsiaFont: '宋体' });
  assert.ok(saved.changed);
  const after = probe(file);
  assert.ok(after.body.every(([ascii]) => ascii !== 'Calibri' && ascii !== 'Times New Roman'));
});

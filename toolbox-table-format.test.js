/**
 * 表格格式处理走「评估工具箱」的 format_word_tables.py。
 * 这里验证两件事：
 * 1) 报告格式页的 table 参数能正确翻译成脚本认的 FORMAT_RULES 键；
 * 2) 注入的配置真的改变了输出（否则等于没接）。
 *
 * 运行：node --test toolbox-table-format.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PY = '/usr/bin/python3';
const SCRIPT = join(homedir(),
  '.tianyuan-workbench/projects/天源评估系统/skills/table-format/scripts/format_word_tables.py');

// 与 index.js 的 toolboxRulesFromReportFormat 保持一致
function rules(cfg) {
  const out = {};
  const t = (cfg && cfg.table) || {};
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const sz = num(t.size_half_points);
  if (sz && sz > 0) out.fontSizePt = sz / 2;
  if (typeof t.font === 'string' && t.font.trim()) out.fontEastAsia = t.font.trim();
  if (typeof t.ascii_font === 'string' && t.ascii_font.trim()) out.fontLatin = t.ascii_font.trim();
  const minRow = num(t.min_row_height_twips);
  if (minRow && minRow > 0) out.minimumRowHeightCm = +(minRow / 567).toFixed(3);
  if (typeof t.repeat_header === 'boolean') out.repeatHeader = t.repeat_header;
  if (typeof t.numeric_align_right === 'boolean') out.numericAlignment = t.numeric_align_right ? 'right' : 'left';
  if (typeof t.autofit === 'boolean') out.fitToWindow = t.autofit;
  if (typeof t.single_line === 'boolean') out.lineSpacing = t.single_line ? 1.0 : 1.5;
  if (typeof t.clear_shading === 'boolean') out.clearShading = t.clear_shading;
  const b = t.border || {};
  const pt = (edge) => { const s = num((b[edge] || {}).size); return s && s > 0 ? s / 8 : null; };
  const topPt = pt('top'), botPt = pt('bottom');
  if (topPt || botPt) out.topBottomBorderPt = Math.max(topPt || 0, botPt || 0);
  const inHPt = pt('insideH'), inVPt = pt('insideV');
  if (inHPt || inVPt) out.insideBorderPt = Math.max(inHPt || 0, inVPt || 0);
  const side = b.left || b.right;
  if (side && String(side.style || '').toLowerCase() === 'nil') out.leftRightBorder = 'none';
  return out;
}

const SAMPLE = {
  table: {
    font: '宋体', ascii_font: 'Times New Roman', size_half_points: 21,
    min_row_height_twips: 340, repeat_header: true, numeric_align_right: true,
    autofit: true, single_line: true,
    border: {
      top: { style: 'single', size: 12, space: 12, color: 'auto' },
      bottom: { style: 'single', size: 12, space: 12, color: 'auto' },
      insideH: { style: 'single', size: 4, space: 4, color: 'auto' },
      insideV: { style: 'single', size: 4, space: 4, color: 'auto' },
    },
  },
};

test('报告格式表格参数 → 工具箱 FORMAT_RULES', () => {
  const r = rules(SAMPLE);
  assert.equal(r.fontSizePt, 10.5, 'sz 21 半磅 = 10.5 磅');
  assert.equal(r.fontEastAsia, '宋体');
  assert.equal(r.fontLatin, 'Times New Roman');
  assert.equal(r.topBottomBorderPt, 1.5, 'sz 12 → 1.5 磅');
  assert.equal(r.insideBorderPt, 0.5, 'sz 4 → 0.5 磅');
  assert.equal(r.minimumRowHeightCm, 0.6, '340 twips ≈ 0.6 厘米');
  assert.equal(r.repeatHeader, true);
  assert.equal(r.numericAlignment, 'right');
  assert.equal(r.fitToWindow, true);
});

test('缺省字段不臆造：空配置不产生任何覆盖键', () => {
  assert.deepEqual(rules({}), {});
  assert.deepEqual(rules(null), {});
});

function makeDocx(path, szHalfPoints) {
  // 交给 python-docx 打包，手写 OOXML 包容易漏 _rels/.rels 之类的必需成员
  const docxPath = path + '.docx';
  const py = `
import sys
from docx import Document
from docx.shared import Twips
d = Document()
t = d.add_table(rows=3, cols=2)
for r, row in enumerate([["序号", "名称"], ["1", "甲"], ["2", "乙"]]):
    for c, text in enumerate(row):
        cell = t.cell(r, c)
        cell.text = text
        for p in cell.paragraphs:
            for run in p.runs:
                run.font.size = Twips(int(sys.argv[2]) * 10)
d.save(sys.argv[1])
`;
  execFileSync(PY, ['-c', py, docxPath, String(szHalfPoints)]);
  return docxPath;
}

function tableSizes(docxPath) {
  const out = execFileSync(PY, ['-c', `
import zipfile,sys
from collections import Counter
from lxml import etree
W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
r=etree.fromstring(zipfile.ZipFile(sys.argv[1]).read('word/document.xml'))
c=Counter()
for t in r.iter(W+'tbl'):
    for x in t.iter(W+'sz'): c[x.get(W+'val')]+=1
print(' '.join(f'{k}={v}' for k,v in sorted(c.items())))
`, docxPath], { encoding: 'utf8' });
  return out.trim();
}

test('注入的配置真的生效：字号按配置改写', { skip: !existsSync(SCRIPT) && '本机未安装评估工具箱' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbx-'));
  const a = makeDocx(join(dir, 'a'), 24); // 12 磅
  const b = makeDocx(join(dir, 'b'), 24);
  execFileSync(PY, [SCRIPT, a], { encoding: 'utf8' });
  execFileSync(PY, [SCRIPT, b], {
    encoding: 'utf8',
    env: { ...process.env, TIANYUAN_TABLE_FORMAT_CONFIG: JSON.stringify({ fontSizePt: 10.5 }) },
  });
  assert.equal(tableSizes(a), '20=6', '默认预设统一成 10 磅 sz=20（6 个单元格各 1 个 run）');
  assert.equal(tableSizes(b), '21=6', '注入 10.5 磅后应是 sz=21');
});

/** 跑脚本，返回最后一条 saved 事件。 */
function runScript(docxPath, extraEnv) {
  const out = execFileSync(PY, [SCRIPT, docxPath], {
    encoding: 'utf8',
    env: { ...process.env, ...(extraEnv || {}) },
  });
  let saved = null;
  for (const line of out.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let j = null;
    try { j = JSON.parse(s); } catch (e) { continue; }
    if (j.event === 'saved') saved = j;
  }
  return saved;
}

function documentXml(path) {
  return execFileSync(PY, ['-c', `
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1])
sys.stdout.buffer.write(z.read('word/document.xml'))
`, path], { maxBuffer: 64 * 1024 * 1024 });
}

test('已经排好的表格整张跳过，不做任何改动', { skip: !existsSync(SCRIPT) && '本机未安装评估工具箱' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbx-skip-'));
  const a = makeDocx(join(dir, 'a'), 24);
  const full = {
    fontSizePt: 10.5, fontEastAsia: '宋体', fontLatin: 'Times New Roman',
    minimumRowHeightCm: 0.6, repeatHeader: true, numericAlignment: 'right',
    fitToWindow: true, lineSpacing: 1, topBottomBorderPt: 1.5, insideBorderPt: 0.5,
  };
  // 第一遍：让脚本把这张表排成目标格式
  const first = runScript(a, { TIANYUAN_TABLE_FORMAT_CONFIG: JSON.stringify(full) });
  assert.ok(first.tableCount > 0, '第一遍应该真的处理了表格');
  const afterFirst = documentXml(a);

  // 第二遍：再跑一次，应当识别为「已经排好」并整张跳过
  const second = runScript(a, { TIANYUAN_TABLE_FORMAT_CONFIG: JSON.stringify(full) });
  assert.equal(second.tableCount, 0, '第二遍不应再处理任何表格');
  assert.equal(second.skippedFormattedTables, 1, '应报告跳过 1 张已排好的表');
  assert.ok(documentXml(a).equals(afterFirst), 'document.xml 必须逐字节不变');

  // 关掉跳过开关就应重新处理，证明跳过与否由开关决定而非偶然
  const third = runScript(a, {
    TIANYUAN_TABLE_FORMAT_CONFIG: JSON.stringify({ ...full, skipAlreadyFormatted: false }),
  });
  assert.equal(third.tableCount, 1, '关掉 skipAlreadyFormatted 后应重新处理');
  assert.equal(third.skippedFormattedTables, 0);
});

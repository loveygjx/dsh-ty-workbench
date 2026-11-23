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

/** 造一张「评估结果汇总表」：5 列 17 行，长投行硬写 0.00（天源的真实输出形态）。 */
function makeSummaryDocx(path, longTermValues) {
  const docxPath = path + '.docx';
  const py = `
import sys, json
from docx import Document
from docx.shared import Twips
d = Document()
rows = [
    ["项目", "账面价值", "评估价值", "增值额", "增值率%"],
    ["流动资产", "3,737.96", "3,737.96", "0.00", "0.00"],
    ["非流动资产", "43,091.41", "47,339.24", "4,247.83", "9.86"],
    ["其中：长期股权投资"] + json.loads(sys.argv[2]),
    ["投资性房地产", "43,091.41", "47,339.24", "4,247.83", "9.86"],
    ["固定资产", "", "", "", ""],
    ["资产总计", "46,829.38", "51,077.20", "4,247.83", "9.07"],
    ["负债合计", "46,830.04", "46,830.04", "0.00", "0.00"],
    ["所有者权益", "-0.66", "4,247.17", "4,247.83", "639,784.35"],
]
t = d.add_table(rows=len(rows), cols=5)
for r, row in enumerate(rows):
    for c, text in enumerate(row):
        cell = t.cell(r, c)
        cell.text = text
        for p in cell.paragraphs:
            for run in p.runs:
                run.font.size = Twips(21 * 10)
d.save(sys.argv[1])
`;
  execFileSync(PY, ['-c', py, docxPath, JSON.stringify(longTermValues)]);
  return docxPath;
}

/** 读汇总表信息：grid 列宽 + 长投行文本。 */
function summaryInfo(docxPath) {
  const out = execFileSync(PY, ['-c', `
import zipfile,sys,json
from lxml import etree
W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
r=etree.fromstring(zipfile.ZipFile(sys.argv[1]).read('word/document.xml'))
tbl=r.find('.//'+W+'tbl')
grid=[int(c.get(W+'w')) for c in tbl.find(W+'tblGrid').findall(W+'gridCol')]
long_term=None
for tr in tbl.findall(W+'tr'):
    cells=tr.findall(W+'tc')
    text=''.join(n.text or '' for n in cells[0].iter(W+'t'))
    if '长期股权' in text:
        long_term=[''.join(n.text or '' for n in c.iter(W+'t')) for c in cells]
        break
print(json.dumps({'grid':grid,'sum':sum(grid),'longTerm':long_term}, ensure_ascii=False))
`, docxPath], { encoding: 'utf8' });
  return JSON.parse(out);
}

test('评估结果汇总表：长投行 0.00 清掉，首列放宽到 2112、其余均分版心', { skip: !existsSync(SCRIPT) && '本机未安装评估工具箱' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbx-sum-'));
  const full = {
    fontSizePt: 10.5, fontEastAsia: '宋体', fontLatin: 'Times New Roman',
    minimumRowHeightCm: 0.6, repeatHeader: true, numericAlignment: 'right',
    fitToWindow: true, lineSpacing: 1, topBottomBorderPt: 1.5, insideBorderPt: 0.5,
  };
  const env = { TIANYUAN_TABLE_FORMAT_CONFIG: JSON.stringify(full) };

  // 场景一：没有长投科目，天源默认填 0.00 —— 这三个 0 应当被清掉
  const zero = makeSummaryDocx(join(dir, 'zero'), ['0.00', '0.00', '0.00', '']);
  const first = runScript(zero, env);
  assert.equal(first.clearedSummaryValues, 3, '三个 0.00 应被清掉');
  const info = summaryInfo(zero);
  // 首列固定 2112（够「其中：长期股权投资」单行），其余列均分，合计必须正好等于本表可用版心。
  // 合成文档是 Letter 纸（版心 8640），不是真实报告的 A4（8879），所以这里只断言结构与恒等式。
  assert.equal(info.grid[0], 2112, '首列固定 2112');
  const rest = info.grid.slice(1);
  assert.equal(new Set(rest).size <= 1 || (Math.max(...rest) - Math.min(...rest) <= 1), true,
    '其余各列必须等宽（除不尽的 1 twips 才允许差 1）');
  assert.equal(info.sum, 8640, 'grid 合计必须正好等于本文档版心，不能差几 twips');
  assert.deepEqual(info.longTerm.slice(1), ['', '', '', ''], '数值列应清空但仍保留四列');

  // 场景二：长投有真实数据 —— 一个数字都不能动
  const real = makeSummaryDocx(join(dir, 'real'),
    ['62,896.24', '342,667.67', '279,771.43', '444.81']);
  const second = runScript(real, env);
  assert.equal(second.clearedSummaryValues, 0, '有真实数据时不得清值');
  assert.deepEqual(summaryInfo(real).longTerm.slice(1),
    ['62,896.24', '342,667.67', '279,771.43', '444.81'], '真实数字必须原样保留');

  // 场景三：再跑一遍不应有任何改动（列宽与清零都要幂等）
  const third = runScript(zero, env);
  assert.equal(third.tableCount, 0, '第二遍应整表跳过');
  assert.equal(third.clearedSummaryValues, 0, '第二遍不应再清零');
});

/** 造一份 7 列等宽（天源默认输出）的表，表头文字长度不均。 */
function makeUniformGridDocx(path) {
  const docxPath = path + '.docx';
  const py = `
import sys
from docx import Document
from docx.shared import Twips
from docx.oxml.ns import qn
d = Document()
t = d.add_table(rows=3, cols=7)
rows = [
    ["序号", "建筑物名称", "用途", "结构", "建成年月", "所在楼层", "建筑面积(㎡)"],
    ["1", "1幢其他商业", "商业", "钢混", "2021年6月", "1层", "3,973.83"],
    ["2", "地下非机动车库", "非机动车库", "钢混", "2022年6月", "地下1层夹层", "190.60"],
]
for r, row in enumerate(rows):
    for c, text in enumerate(row):
        t.cell(r, c).text = text
# 天源默认：完全等宽的网格
grid = t._tbl.tblGrid
for col in grid.iterchildren(qn("w:gridCol")):
    col.set(qn("w:w"), "1268")
d.save(sys.argv[1])
`;
  execFileSync(PY, ['-c', py, docxPath]);
  return docxPath;
}

function gridOf(docxPath) {
  const out = execFileSync(PY, ['-c', `
import zipfile,sys,json
from lxml import etree
W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
r=etree.fromstring(zipfile.ZipFile(sys.argv[1]).read('word/document.xml'))
body=r.find(W+'body')
res=[]
for t in body.findall(W+'tbl'):
    g=t.find(W+'tblGrid')
    res.append([int(c.get(W+'w')) for c in g.findall(W+'gridCol')] if g is not None else [])
print(json.dumps(res))
`, docxPath], { encoding: 'utf8' });
  return JSON.parse(out);
}

function bodyWidth(docxPath) {
  const out = execFileSync(PY, ['-c', `
import zipfile,sys
from lxml import etree
W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
r=etree.fromstring(zipfile.ZipFile(sys.argv[1]).read('word/document.xml'))
sect=r.find(W+'body').find(W+'sectPr')
size=sect.find(W+'pgSz'); mar=sect.find(W+'pgMar')
print(int(size.get(W+'w')) - int(mar.get(W+'left')) - int(mar.get(W+'right')))
`, docxPath], { encoding: 'utf8' });
  return Number(out.trim());
}

test('等宽网格才按内容重排，手工调过的列宽一律不动', { skip: !existsSync(SCRIPT) && '本机未安装评估工具箱' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbx-grid-'));
  const env = { TIANYUAN_TABLE_FORMAT_CONFIG: JSON.stringify({ ...rules(SAMPLE), fontSizePt: 10.5 }) };

  // 等宽网格 + 表头装不下 → 按内容重排，合计正好版心
  const uniform = makeUniformGridDocx(join(dir, 'uniform'));
  const before = gridOf(uniform)[0];
  assert.equal(new Set(before).size, 1, 'fixture 必须是等宽的');
  const r1 = runScript(uniform, env);
  assert.equal(r1.reflowedUniformGrids, 1, '等宽网格应被重排');
  const after = gridOf(uniform)[0];
  assert.ok(new Set(after).size > 1, '重排后列宽不应再等宽');
  assert.equal(after.reduce((a, b) => a + b, 0), bodyWidth(uniform),
    '重排后合计必须正好等于本文档版心（天源等宽网格常比版心宽 1~3 twips）');
  assert.ok(after[1] > before[1], '「建筑物名称」列应被放宽（原等宽装不下表头）');

  // 手工分栏过的网格（不等宽）→ 一列都不许动
  const manual = makeUniformGridDocx(join(dir, 'manual'));
  execFileSync(PY, ['-c', `
import sys,zipfile,shutil
from docx import Document
from docx.oxml.ns import qn
d = Document(sys.argv[1])
t = d.tables[0]
for col, w in zip(t._tbl.tblGrid.iterchildren(qn("w:gridCol")), [600, 1800, 1300, 700, 1300, 1400, 1779]):
    col.set(qn("w:w"), str(w))
d.save(sys.argv[1])
`, manual]);
  const manualBefore = gridOf(manual)[0];
  const r2 = runScript(manual, env);
  assert.equal(r2.reflowedUniformGrids, 0, '不等宽网格不得重排');
  assert.deepEqual(gridOf(manual)[0], manualBefore, '手工列宽必须逐值保留');
});

/**
 * 造一份带「附件」区的文档：
 *   - 第一张表在附件标题之前（正文表）
 *   - 第二张表在附件标题之后，但没写 tblCellMar（天源自己生成的表）
 *   - 第三张表在附件标题之后，写了 tblCellMar（外部 Word 粘进来的表）
 * 期望：只有第三张被跳过。
 */
function makeAttachmentDocx(path) {
  const docxPath = path + '.docx';
  const py = `
import sys
from docx import Document
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

def table(doc, tag):
    t = doc.add_table(rows=2, cols=2)
    for r, row in enumerate([["项目名称", "2026年1-11月"], ["资产总计", "468,293,755.53"]]):
        for c, text in enumerate(row):
            t.cell(r, c).text = text + tag
    return t

d = Document()
table(d, "-正文")
d.add_paragraph("附件：企业关于进行资产评估有关事项的说明")
table(d, "-天源")          # 附件区里天源自己生成的表，不该跳过

external = table(d, "-外部")  # 附件区里外部 Word 表，应跳过
# Word 存盘必写 tblCellMar（天源不写）——保留它更贴近真实
mar = OxmlElement("w:tblCellMar")
for side, w in (("left", 108), ("right", 108)):
    el = OxmlElement("w:" + side)
    el.set(qn("w:w"), str(w)); el.set(qn("w:type"), "dxa")
    mar.append(el)
external._tbl.tblPr.append(mar)
# 判据信号：Word 的 tblLook 是 6 个具名属性、没有 w:val；
# 天源（以及 python-docx 默认）写的是 <w:tblLook w:val="04A0"/>。
# python-docx 建表自带一个带 val 的 tblLook，要先删掉再换成 Word 那种。
for old in external._tbl.tblPr.findall(qn("w:tblLook")):
    external._tbl.tblPr.remove(old)
look = OxmlElement("w:tblLook")
for name, val in (("firstRow", "0"), ("lastRow", "0"), ("firstColumn", "0"),
                  ("lastColumn", "0"), ("noHBand", "1"), ("noVBand", "1")):
    look.set(qn("w:" + name), val)
external._tbl.tblPr.append(look)

d.save(sys.argv[1])
`;
  execFileSync(PY, ['-c', py, docxPath]);
  return docxPath;
}

test('附件区只跳过外部 Word 表，天源自己生成的照样处理', { skip: !existsSync(SCRIPT) && '本机未安装评估工具箱' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbx-att-'));
  const doc = makeAttachmentDocx(join(dir, 'att'));
  const env = { TIANYUAN_TABLE_FORMAT_CONFIG: JSON.stringify({ ...rules(SAMPLE), fontSizePt: 10.5 }) };
  const r = runScript(doc, env);
  assert.equal(r.attachmentFound, true, 'fixture 必须能识别出附件标题');
  assert.equal(r.skippedAttachmentTables, 1, '附件区里只有外部 Word 表被跳过');
  assert.equal(r.tableCount, 2, '正文表 + 附件区里的天源表都要处理');

  // 三张表里，只有外面那张没被套上格式
  const out = execFileSync(PY, ['-c', `
import zipfile,sys,json
from lxml import etree
W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
r=etree.fromstring(zipfile.ZipFile(sys.argv[1]).read('word/document.xml'))
res=[]
for t in r.find(W+'body').findall(W+'tbl'):
    sizes={x.get(W+'val') for x in t.iter(W+'sz')}
    res.append(sorted(sizes))
print(json.dumps(res))
`, doc], { encoding: 'utf8' });
  const sizes = JSON.parse(out);
  assert.deepEqual(sizes[0], ['21'], '正文表已套用 10.5 磅');
  assert.deepEqual(sizes[1], ['21'], '附件区的天源表也已套用 10.5 磅');
  assert.notDeepEqual(sizes[2], ['21'], '外部 Word 表保持原样（未套用字号）');
});

function makeDualTableDocx(path) {
  const docxPath = path + '.docx';
  const py = `
import sys
from docx import Document

d = Document()
t = d.add_table(rows=9, cols=3)
rows = [
    ["项目名称", "2025年度", "2026年1-10月"],
    ["营业收入", "", "1,559,712.25"],
    ["营业成本", "", "5,077,093.87"],
    ["利润总额", "", "-3,997,901.43"],
    ["净利润", "", "-3,997,901.43"],
    ["项目名称", "2025年12月31日", "2026年10月31日"],
    ["资产总计", "31,681,240.37", "783,473,355.88"],
    ["负债合计", "31,681,626.00", "814,080,919.69"],
    ["所有者权益合计", "-385.63", "-30,607,563.81"],
]
for r, row in enumerate(rows):
    for c, text in enumerate(row):
        t.cell(r, c).text = text
d.save(sys.argv[1])
`;
  execFileSync(PY, ['-c', py, docxPath]);
  return docxPath;
}

/* 返回每行的对齐方式、加粗状态、是否带 tblHeader。 */
function rowStates(docxPath) {
  const out = execFileSync(PY, ['-c', `
import zipfile,sys,json
from lxml import etree
W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
r=etree.fromstring(zipfile.ZipFile(sys.argv[1]).read('word/document.xml'))
tbl=r.find(W+'body').find(W+'tbl')
res=[]
for tr in tbl.findall(W+'tr'):
    jc=set(); bold=set()
    for p in tr.iter(W+'p'):
        pr=p.find(W+'pPr')
        j=pr.find(W+'jc') if pr is not None else None
        jc.add(j.get(W+'val') if j is not None else None)
    for run in tr.iter(W+'r'):
        rp=run.find(W+'rPr')
        b=rp.find(W+'b') if rp is not None else None
        # <w:b/> 或 <w:b w:val="1"/> 才是粗体；<w:b w:val="0"/> 是显式取消。
        bold.add(b is not None and b.get(W+'val') not in ('0', 'false'))
    trpr=tr.find(W+'trPr')
    hdr = trpr is not None and trpr.find(W+'tblHeader') is not None
    res.append({"jc": sorted(x for x in jc if x), "bold": sorted(bold), "tblHeader": hdr})
print(json.dumps(res))
`, docxPath], { encoding: 'utf8' });
  return JSON.parse(out);
}

test('双表结构的第二段表头行也居中加粗，但不设成重复表头', { skip: !existsSync(SCRIPT) && '本机未安装评估工具箱' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbx-dual-'));
  const doc = makeDualTableDocx(join(dir, 'dual'));
  const env = { TIANYUAN_TABLE_FORMAT_CONFIG: JSON.stringify({ ...rules(SAMPLE), fontSizePt: 10.5 }) };
  runScript(doc, env);

  const states = rowStates(doc);
  assert.deepEqual(states[0].jc, ['center'], '第 0 行是真表头，居中');
  assert.deepEqual(states[0].bold, [true], '第 0 行加粗');
  assert.equal(states[0].tblHeader, true, '第 0 行应带 tblHeader（分页重复）');

  assert.deepEqual(states[5].jc, ['center'], '第 5 行是第二段表头，也要居中');
  assert.deepEqual(states[5].bold, [true], '第 5 行要加粗');
  assert.equal(states[5].tblHeader, false, '第 5 行不在表格顶端，不能设为重复表头');

  // 数据行不带样式：文字格左对齐、数字格右对齐，且都不加粗
  assert.deepEqual(states[1].jc, ['left', 'right'], '数据行文字左对齐、数字右对齐');
  assert.deepEqual(states[1].bold, [false], '数据行不加粗');

  // 幂等：第二遍必须认得出已经排好
  const again = runScript(doc, env);
  assert.equal(again.tableCount, 0, '第二遍不应再处理任何表格');
  assert.equal(again.skippedFormattedTables, 1);
});

/* 可比实例表：第 0 行「项目 / 评估对象 / 可比实例A…」不像表头，
   第 5 行「交易情况 / 正常 / 市场价格…」反倒命中表头词。 */
function makeComparableDocx(path) {
  const docxPath = path + '.docx';
  const py = `
import sys
from docx import Document

d = Document()
t = d.add_table(rows=9, cols=5)
rows = [
    ["项目", "评估对象", "可比实例A", "可比实例B", "可比实例C"],
    ["物业名称", "忆境府32-1701", "忆境府23-1603", "忆境府32-1604", "忆境府8-204"],
    ["利用类型", "住宅", "住宅", "住宅", "住宅"],
    ["建筑面积（㎡）", "129.49", "112.09", "129.49", "121.29"],
    ["交易价格(元/㎡)", "", "7,118", "7,066", "7,865"],
    ["交易情况", "正常", "市场价格", "市场价格", "市场价格"],
    ["交易时间", "2026年10月", "2026年8月", "2026年10月", "2026年3月"],
    ["区位状况调整", "居住集聚程度", "周边有金悦商业中心等", "周边有金悦商业中心等", "周边有金悦商业中心等"],
    ["区位状况调整", "交通便捷程度", "占据湖织大道与吴兴大道", "占据湖织大道与吴兴大道", "占据湖织大道与吴兴大道"],
]
for r, row in enumerate(rows):
    for c, text in enumerate(row):
        t.cell(r, c).text = text
d.save(sys.argv[1])
`;
  execFileSync(PY, ['-c', py, docxPath]);
  return docxPath;
}

test('可比实例表不会被当成双表：表头仍是第 0 行，交易情况行照常左对齐', { skip: !existsSync(SCRIPT) && '本机未安装评估工具箱' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbx-comp-'));
  const doc = makeComparableDocx(join(dir, 'comp'));
  const env = { TIANYUAN_TABLE_FORMAT_CONFIG: JSON.stringify({ ...rules(SAMPLE), fontSizePt: 10.5 }) };
  runScript(doc, env);

  const states = rowStates(doc);
  assert.deepEqual(states[0].jc, ['center'], '第 0 行才是真表头，必须居中');
  assert.deepEqual(states[0].bold, [true], '第 0 行加粗');
  assert.equal(states[0].tblHeader, true, '第 0 行应带 tblHeader');

  // 「交易情况」只是普通数据行：左对齐、不加粗、不带重复表头
  assert.deepEqual(states[5].jc, ['left'], '「交易情况」是数据行，不能居中');
  assert.deepEqual(states[5].bold, [false], '「交易情况」不能加粗');
  assert.equal(states[5].tblHeader, false, '「交易情况」不能设成重复表头');

  // 幂等
  const again = runScript(doc, env);
  assert.equal(again.tableCount, 0, '第二遍不应再处理');
});

/* 把某一行伪造成「旧版脚本误判成表头」的样子：居中 + 加粗 + tblHeader。 */
function markRowAsHeader(docxPath, rowIndex) {
  execFileSync(PY, ['-c', `
import sys
from docx import Document
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from docx.enum.text import WD_ALIGN_PARAGRAPH

d = Document(sys.argv[1])
t = d.tables[0]
row = t.rows[int(sys.argv[2])]
trPr = row._tr.get_or_add_trPr()
if trPr.find(qn('w:tblHeader')) is None:
    trPr.append(OxmlElement('w:tblHeader'))
for cell in row.cells:
    for p in cell.paragraphs:
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        for r in p.runs:
            r.bold = True
d.save(sys.argv[1])
`, docxPath, String(rowIndex)]);
}

test('旧版误标成表头的数据行会被修回来（居中/加粗/tblHeader 全部撤销）', { skip: !existsSync(SCRIPT) && '本机未安装评估工具箱' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbx-stray-'));
  const doc = makeComparableDocx(join(dir, 'stray'));
  const env = { TIANYUAN_TABLE_FORMAT_CONFIG: JSON.stringify({ ...rules(SAMPLE), fontSizePt: 10.5 }) };
  runScript(doc, env);           // 先按正常流程排好
  markRowAsHeader(doc, 5);       // 再把「交易情况」伪造成旧版残留

  const again = runScript(doc, env);
  assert.equal(again.tableCount, 1, '有残留的表格必须重做一次，不能当「已排好」跳过');
  assert.equal(again.repairedHeaderRows, 1, '应报告修复了 1 行误标表头');

  const states = rowStates(doc);
  assert.deepEqual(states[5].jc, ['left'], '「交易情况」恢复左对齐');
  assert.deepEqual(states[5].bold, [false], '「交易情况」取消加粗');
  assert.equal(states[5].tblHeader, false, '「交易情况」不再重复打印');
  assert.equal(states[0].tblHeader, true, '真表头仍保留 tblHeader');

  // 修完之后再跑一遍应当认可「已排好」，不再重做
  const third = runScript(doc, env);
  assert.equal(third.tableCount, 0, '修好后第二遍应判定已完成');
  assert.equal(third.repairedHeaderRows, 0);
});

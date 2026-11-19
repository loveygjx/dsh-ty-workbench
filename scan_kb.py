# -*- coding: utf-8 -*-
"""归档库增量扫描：抽取文本 -> 知识库索引；可选 OCR；导出 Excel 索引。

由个人工作台插件宿主以子进程方式调用（见 library.js 的 startScan）：

    python scan_kb.py --root "D:\\天源评估\\已归档" --mode quick [--ocr] [--ocr-limit 20]

stdout 每行一条 JSON 进度事件（UTF-8，逐行 flush）：
    {"ev":"start","root":"...","mode":"quick"}
    {"ev":"walk","total":1158,"added":3,"changed":0,"removed":0,"same":1155}
    {"ev":"extract","done":1,"total":3,"ok":1,"skip":0,"fail":0,"file":"..."}
    {"ev":"ocr","done":1,"total":5,"ok":1,"fail":0,"file":"..."}
    {"ev":"xlsx","ok":true,"path":"..."}
    {"ev":"done","stats":{...}}
    {"ev":"error","message":"..."}

设计要点：
- 增量：按 rel + size + mtime 判定，未变化的条目沿用旧记录（保留 OCR 结果）；
- 原子：先写 kb_index.jsonl.tmp，全部完成后 os.replace，避免中断留下半截索引；
- 可续跑：任何时刻中断，下次扫描重新比对，未抽完的文件下次继续；
- 记录清理：磁盘上已删除的文件不再出现在索引里。
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
import traceback
import warnings

warnings.filterwarnings('ignore')

MAX_CHARS = 400_000            # 单文件正文上限
SHEET_MAX_ROWS = 4000          # 每个工作表最多取的行
PDF_MAX_PAGES = 200
MAX_BYTES = 300 * 1024 * 1024  # 超过这个体积不做文本抽取（记 oversized）

TEXT_EXT = {'.docx', '.docm', '.doc', '.xlsx', '.xlsm', '.xls', '.pdf', '.md', '.txt', '.csv'}
IMAGE_EXT = {'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff', '.webp'}
ARCHIVE_EXT = {'.zip', '.rar', '.7z'}

CAT_NAMES = [
    ('01', '取数表'), ('02', '电子底稿'), ('03', '纸质报告、合同扫描'), ('04', '装订版报告'),
]


def emit(ev, **kw):
    kw['ev'] = ev
    sys.stdout.write(json.dumps(kw, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def norm(s):
    s = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', ' ', str(s or ''))
    return re.sub(r'[ \t\u3000]+', ' ', s).strip()


def norm_lines(text):
    lines = [norm(l) for l in str(text).splitlines()]
    return '\n'.join(l for l in lines if l)


# ---------------------------------------------------------------- 文本抽取

def from_docx(path):
    import docx
    d = docx.Document(path)
    out = []
    for p in d.paragraphs:
        t = p.text.strip()
        if t:
            out.append(t)
    for ti, tb in enumerate(d.tables):
        out.append('[表%d]' % (ti + 1))
        for row in tb.rows:
            cells = [norm(c.text) for c in row.cells]
            if any(cells):
                out.append(' | '.join(cells))
    return '\n'.join(out)


def from_xlsx(path):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    out = []
    for ws in wb.worksheets:
        out.append('[工作表] %s' % ws.title)
        n = 0
        for row in ws.iter_rows(values_only=True):
            vals = [norm(v) for v in row if v is not None and str(v).strip()]
            if vals:
                out.append(' | '.join(vals))
                n += 1
                if n >= SHEET_MAX_ROWS:
                    out.append('…（该表行数超限，已截断）')
                    break
    wb.close()
    return '\n'.join(out)


def from_xls(path):
    import xlrd
    bk = xlrd.open_workbook(path, on_demand=True)
    out = []
    for sh in bk.sheets():
        out.append('[工作表] %s' % sh.name)
        n = 0
        for r in range(sh.nrows):
            vals = [norm(v) for v in sh.row_values(r) if norm(v)]
            if vals:
                out.append(' | '.join(vals))
                n += 1
                if n >= SHEET_MAX_ROWS:
                    out.append('…（该表行数超限，已截断）')
                    break
    bk.release_resources()
    return '\n'.join(out)


def from_pdf(path):
    """返回 (文本, 是否扫描件, 页数)"""
    import fitz
    try:
        fitz.TOOLS.mupdf_display_errors(False)
        fitz.TOOLS.mupdf_display_warnings(False)
    except Exception:
        pass
    doc = fitz.open(path)
    pages = min(len(doc), PDF_MAX_PAGES)
    parts = []
    chars = 0
    for i in range(pages):
        t = doc[i].get_text() or ''
        chars += len(t.strip())
        if t.strip():
            parts.append(t)
    total = len(doc)
    doc.close()
    text = '\n'.join(parts)
    scanned = chars < 40 * max(1, pages)   # 平均每页不足 40 字视为扫描件
    return text, scanned, total


def from_plain(path):
    with open(path, 'r', encoding='utf-8', errors='ignore') as f:
        return f.read(MAX_CHARS)


# ------------------------------------------------- OOXML 兜底（openpyxl/docx 打不开时）

def _ooxml_text(path):
    import zipfile
    import xml.etree.ElementTree as ET
    NSM = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    NSW = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    z = zipfile.ZipFile(path)
    try:
        if 'word/document.xml' in z.namelist():
            try:
                root = ET.fromstring(z.read('word/document.xml'))
            except Exception:
                return ''
            W = '{%s}' % NSW
            out = []
            for p in root.iter(W + 'p'):
                line = ''.join(t.text or '' for t in p.iter(W + 't')).strip()
                if line:
                    out.append(line)
            return '\n'.join(out)
        # xlsx
        sst = []
        try:
            root = ET.fromstring(z.read('xl/sharedStrings.xml'))
            for si in root.findall('{%s}si' % NSM):
                sst.append(''.join(t.text or '' for t in si.iter('{%s}t' % NSM)))
        except Exception:
            pass
        sheets = []
        try:
            wb = ET.fromstring(z.read('xl/workbook.xml'))
            sheets = [sh.get('name') or '' for sh in wb.findall('.//{%s}sheet' % NSM)]
        except Exception:
            pass
        names = [n for n in z.namelist() if re.match(r'xl/worksheets/sheet\d+\.xml$', n)]
        names.sort(key=lambda n: int(re.search(r'(\d+)', n).group(1)))
        out = []
        for i, n in enumerate(names):
            out.append('[工作表] %s' % (sheets[i] if i < len(sheets) else os.path.basename(n)))
            try:
                root = ET.fromstring(z.read(n))
            except Exception:
                continue
            rows = 0
            for row in root.findall('.//{%s}sheetData/{%s}row' % (NSM, NSM)):
                vals = []
                for c in row.findall('{%s}c' % NSM):
                    t = c.get('t')
                    v = c.find('{%s}v' % NSM)
                    if t == 's' and v is not None:
                        try:
                            vals.append(sst[int(v.text)])
                        except (ValueError, IndexError):
                            pass
                    elif t == 'inlineStr':
                        isx = c.find('{%s}is' % NSM)
                        if isx is not None:
                            vals.append(''.join(x.text or '' for x in isx.iter('{%s}t' % NSM)))
                    elif v is not None and (v.text or '').strip():
                        vals.append(v.text)
                clean = [re.sub(r'\s+', ' ', str(x)).strip() for x in vals if str(x).strip()]
                if clean:
                    out.append(' | '.join(clean))
                    rows += 1
                    if rows >= SHEET_MAX_ROWS:
                        out.append('…（该表行数超限，已截断）')
                        break
        return '\n'.join(out)
    finally:
        z.close()


def extract(path):
    ext = os.path.splitext(path)[1].lower()
    meta = {'pages': None, 'scanned': False}
    if ext in ('.docx', '.docm'):
        text = from_docx(path)
    elif ext in ('.xlsx', '.xlsm'):
        text = from_xlsx(path)
    elif ext == '.xls':
        text = from_xls(path)
    elif ext == '.pdf':
        text, meta['scanned'], meta['pages'] = from_pdf(path)
    elif ext in ('.md', '.txt', '.csv'):
        text = from_plain(path)
    elif ext == '.doc':
        # 老 doc 结构是 OLE 复合文档，没有轻量解析器；伪造成 docx 的少数可以救
        try:
            text = from_docx(path)
        except Exception:
            return None, {'scanned': False, 'pages': None, 'unsupported': 'doc'}
    else:
        return None, {'scanned': False, 'pages': None, 'unsupported': ext}
    return text[:MAX_CHARS], meta


def extract_any(path):
    """先走常规解析，失败再用 OOXML 直接解包兜底（WPS 产出的 #N/A 定义名常把 openpyxl 卡住）"""
    try:
        return extract(path)
    except Exception as e:
        try:
            fb = _ooxml_text(path)
        except Exception:
            fb = ''
        if fb and fb.strip():
            return fb[:MAX_CHARS], {'scanned': False, 'pages': None, 'fallback': 'ooxml'}
        raise e


# ---------------------------------------------------------------- 目录遍历

def is_hidden(name):
    return name.startswith('.') or name.startswith('~$') or name.lower() in ('thumbs.db', 'desktop.ini')


# ---------------------------------------------------------- Word 优先 / 重复副本
# 规则（用户口径）：报告与说明只要有 Word 版，就以 Word 版为准，不再解析对应 PDF；
# 没有对应 Word 版时，才去解析 PDF（扫描件该 OCR 还 OCR）。
# 命中后只「不入正文」——记录仍然留着，浏览页还能看到这个 PDF 存在，
# 记录里 shadow / dupOf 两个字段说明它被哪一份 Word 顶替了。
WORD_EXT = {'.docx', '.doc', '.docm'}
BOUND_DIR_RE = re.compile(r'装订[版本]')
# 文档类别：只有同类才互顶（报告 ↔ 报告，说明 ↔ 说明），报告不会被说明顶掉
KIND_WORDS = [
    ('资产评估说明', '说明'), ('评估说明', '说明'), ('说明书', '说明'), ('说明', '说明'),
    ('资产评估报告', '报告'), ('评估报告', '报告'), ('报告', '报告'),
    ('明细表', '明细表'), ('底稿', '底稿'), ('附件', '附件'),
]
NAME_NOISE_RE = re.compile(r'(扫描件|扫描版|签章版|已签章|盖章版|电子版|pdf版|正式版|定稿|终稿|初稿|副本|copy)+$', re.I)


def name_stem(fn):
    s = os.path.splitext(str(fn))[0].lower()
    return re.sub(r'[\s\u3000_\-—·．.,，、（）()\[\]【】〔〕]+', '', s)


def doc_kind(fn):
    s = name_stem(fn)
    for word, kind in KIND_WORDS:
        if word in s:
            return kind
    return ''


def name_core(fn):
    """去掉类别词、版本号、文号、签发标记后的「这份文档是谁」的核心名"""
    s = name_stem(fn)
    s = re.sub(r'^(签发复核\d*|三级复核\d*|定稿版?|终稿|初稿)', '', s)
    for word, _ in KIND_WORDS:
        s = s.replace(word, '')
    s = NAME_NOISE_RE.sub('', s)
    s = re.sub(r'v?\d+(\.\d+)+', '', s)
    s = re.sub(r'[（(][^）)]*[）)]', '', s)
    s = re.sub(r'(final|vfinal|clean)+$', '', s, flags=re.I)
    return s.strip('-_ ')


def _bigrams(s):
    return {s[i:i + 2] for i in range(len(s) - 1)}

def _contain(a, b):
    """a 的双字片段有多大比例出现在 b 里（同序包含直接给 1）"""
    if not a or not b:
        return 0.0
    if a in b:
        return 1.0
    ga, gb = _bigrams(a), _bigrams(b)
    return (len(ga & gb) / len(ga)) if ga else 0.0


def word_priority_shadow(files, min_score=0.8):
    """算「不该再解析」的文件 -> 顶替它的那一份。

    files: [(year, project, rel, abs, size, mtime)]
    返回 {'pdf_rel': {'shadow': 'pdf-word', 'dupOf': docx_rel, 'note': '...'},
          '04 装订版/...docx': {'shadow': 'bound-copy', 'dupOf': 02里的同名副本, ...}}
    """
    by_proj = {}
    for y, proj, rel, fp, size, mtime in files:
        base = os.path.basename(str(fp))
        e = os.path.splitext(base)[1].lower()
        slot = by_proj.setdefault(proj, {'w': [], 'p': [], 'all': []})
        slot['all'].append((rel, base, size))
        if e in WORD_EXT:
            slot['w'].append((rel, base))
        elif e == '.pdf':
            slot['p'].append((rel, base))

    out = {}
    for proj, slot in by_proj.items():
        # 1) PDF 让位给同项目的 Word 版
        for prel, pfp in slot['p']:
            pc, pk = name_core(pfp), doc_kind(pfp)
            if len(pc) < 2:
                continue
            best, bs = None, 0.0
            for wrel, wfp in slot['w']:
                wc, wk = name_core(wfp), doc_kind(wfp)
                if pk != wk or len(wc) < 2:
                    continue
                sc = _contain(pc, wc)
                if sc > bs:
                    bs, best = sc, (wrel, wfp)
            if best and bs >= min_score:
                out[prel] = {'shadow': 'pdf-word', 'dupOf': best[0],
                             'note': '已有 Word 版「%s」，按 Word 版解析，PDF 不重复入库' % best[1]}

        # 2) 「04 装订版」里与电子底稿同名同大小的副本
        bucket = {}
        for rel, fp, size in slot['all']:
            bucket.setdefault((str(fp).lower(), size), []).append(rel)
        for (fn, size), rels in bucket.items():
            if len(rels) < 2:
                continue
            bound = [r for r in rels if BOUND_DIR_RE.search(os.path.dirname(r) or '')]
            plain = [r for r in rels if not BOUND_DIR_RE.search(os.path.dirname(r) or '')]
            if not bound or not plain:
                continue
            keep = plain[0]
            for b in bound:
                if b in out:
                    continue
                out[b] = {'shadow': 'bound-copy', 'dupOf': keep,
                          'note': '装订版副本与「%s」同名同大小，只入库电子底稿那一份' % os.path.basename(keep)}
    return out


# ---------------------------------------------------------- Word 优先 第二遍（看内容）
# 文件名对不上的情况很常见：电子稿叫「杭州蔬菜、果品、水产市场价值咨询【定稿】.docx」，
# 而 03 里的扫描/打印件叫「天源咨报字〔2025〕第20238号 …房地产价值分析报告.pdf」。
# 这时靠两个信号补判：① 文号相同（天源评报字〔2021〕第0204号 这种）；② 正文重合度高。
# 两条都必须「同类」才顶：报告只被报告顶，说明只被说明顶——同一项目的报告和说明共用一个文号，
# 只看文号会把「有说明 Word 版」错当成「报告也有 Word 版」，把唯一的报告 PDF 也压掉。
WENHAO_RE = re.compile(r'[〔\[【(（]?(\d{4})[〕\]】)）]?\s*第?\s*(\d{3,6})\s*号')


def doc_wenhao(s):
    return {m.group(1) + '-' + m.group(2).lstrip('0') for m in WENHAO_RE.finditer(str(s or ''))}


def doc_kind_of(name):
    return doc_kind(name)


def kind_from_text(head):
    """文件名里没有类别词时，从正文开头（封面/标题）看出这是报告还是说明。

    封面通常就是「…房地产价值分析报告 + 文号 + 评估机构 + 日期」，
    所以只取前 400 字，先判「说明」再判「报告」，避免说明里的正文提到「报告」被误判。
    """
    h = str(head or '')[:400]
    for w in ('资产评估说明', '评估说明', '说明书', '分析说明', '说明'):
        if w in h:
            return '说明'
    for w in ('资产评估报告', '评估报告', '价值分析报告', '分析报告', '咨询报告', '报告'):
        if w in h:
            return '报告'
    return ''


def rec_head(rec, texts_dir, n=8000):
    tf = rec.get('textFile')
    if not tf:
        return ''
    try:
        with open(os.path.join(texts_dir, tf), encoding='utf-8', errors='replace') as f:
            return f.read(n)
    except OSError:
        return ''


def _shingles(s, k=5):
    return {s[i:i + k] for i in range(max(0, len(s) - k + 1))}


def content_word_shadow(records, texts_dir, min_overlap=0.6):
    """按「文号相同」或「正文重合 ≥ min_overlap」找同一份报告/说明的 Word 版。

    返回 {pdf_rel: {...}}，只统计「同项目 + 同类」的配对。
    """
    by_proj = {}
    for rel, rec in records.items():
        ext = (rec.get('ext') or '').lower()
        slot = by_proj.setdefault(rec.get('project') or '', {'w': [], 'p': []})
        if ext in WORD_EXT:
            slot['w'].append((rel, rec))
        elif ext == '.pdf' and rec.get('textFile'):
            slot['p'].append((rel, rec))

    out = {}
    for proj, slot in by_proj.items():
        if not slot['w'] or not slot['p']:
            continue
        word_info = []
        for wrel, wrec in slot['w']:
            wh_text = rec_head(wrec, texts_dir, 3000)
            kind = doc_kind_of(wrec.get('file') or '') or kind_from_text(wh_text[:600])
            word_info.append((wrel, wrec, kind,
                              doc_wenhao(wrec.get('file')) | doc_wenhao(wh_text),
                              _shingles(rec_head(wrec, texts_dir, 8000)), bool(wrec.get('shadow'))))
        for prel, prec in slot['p']:
            if prel in out:
                continue
            pkind = doc_kind_of(prec.get('file') or '')
            ptext = rec_head(prec, texts_dir, 8000)
            if not pkind:
                pkind = kind_from_text(ptext[:600])
            pwh = doc_wenhao(prec.get('file')) | doc_wenhao(rec_head(prec, texts_dir, 3000))
            # 候选：同类 Word 稿，且优先没被别的规则压过的
            cand = [x for x in word_info if pkind and x[2] == pkind]
            if not cand and not pkind:
                cand = [x for x in word_info if not x[2]]
            if not cand:
                continue
            cand.sort(key=lambda x: x[5])
            best, why = None, ''
            for wrel, wrec, wk, wh, ws, wshadow in cand:
                if pwh & wh:
                    best, why = (wrel, wrec, ws), '文号 %s' % '/'.join(sorted(pwh & wh))
                    break
            # 文号相同还不足以下结论：审计报告/长投附件里也会提到评估报告文号。
            # PDF 自己有足够正文的，必须再验一遍重合；正文很少（扫描件没文字层）才只看文号。
            if best and (prec.get('chars') or 0) >= 3000 and len(ptext) >= 400:
                ps = _shingles(ptext)
                hit = len(ps & best[2]) / len(ps) if ps else 0
                if hit < 0.15:
                    best, why = None, ''
                else:
                    why += '，正文重合 %.2f' % hit
            if not best and len(ptext) >= 400:
                ps = _shingles(ptext)
                if len(ps) >= 100:
                    for wrel, wrec, wk, wh, ws, wshadow in cand:
                        if len(ws) < 100:
                            continue
                        hit = len(ps & ws) / len(ps)
                        if hit >= min_overlap:
                            best, why = (wrel, wrec, ws), '正文重合 %.2f' % hit
                            break
            if best:
                out[prel] = {
                    'shadow': 'pdf-content',
                    'dupOf': best[0],
                    'dupWhy': why,
                    'note': '同项目「%s」已有 Word 版（%s），按 Word 版解析，PDF 不重复入库'
                            % (best[1].get('file') or '', why),
                }
    return out


def subdir_of(rel, year, project):
    """rel = 2025年\\{项目}\\{子目录}\\... -> 子目录（与项目根同级时返回 '.'）"""
    parts = rel.split(os.sep)
    # parts[0] = 年份，parts[1] = 项目目录，其余是子目录+文件名
    if len(parts) <= 3:
        return '.'
    return os.sep.join(parts[2:-1]) or '.'


def iter_projects(root):
    """产出 (year_folder, project_folder, abs_dir)"""
    try:
        years = sorted(os.listdir(root))
    except OSError as e:
        emit('error', message='归档根目录不可读：%s' % e)
        return
    for y in years:
        yp = os.path.join(root, y)
        if not os.path.isdir(yp) or is_hidden(y) or y.startswith('_'):
            continue
        try:
            projs = sorted(os.listdir(yp))
        except OSError:
            continue
        for p in projs:
            pp = os.path.join(yp, p)
            if not os.path.isdir(pp) or is_hidden(p):
                continue
            yield y, p, pp


def iter_files(root):
    """产出 (year_folder, project_folder, rel, abs, size, mtime)"""
    for y, proj, pp in iter_projects(root):
        for dirpath, dirnames, filenames in os.walk(pp):
            dirnames[:] = sorted(d for d in dirnames if not is_hidden(d))
            for f in sorted(filenames):
                if is_hidden(f):
                    continue
                fp = os.path.join(dirpath, f)
                try:
                    st = os.stat(fp)
                except OSError:
                    continue
                yield y, proj, os.path.relpath(fp, root), fp, st.st_size, int(st.st_mtime)


# ---------------------------------------------------------------- OCR（可选）

def mineru_script():
    cands = [os.environ.get('DSH_MINERU_SCRIPT') or '',
             os.path.expanduser(r'~\.codex\skills\mineru\scripts\mineru.py'),
             r'C:\Users\Administrator\.codex\skills\mineru\scripts\mineru.py',
             os.path.expanduser(r'~\.claude\skills\mineru\scripts\mineru.py')]
    for c in cands:
        if c and os.path.exists(c):
            return c
    return ''


def mineru_token():
    try:
        import yaml
        cfg = yaml.safe_load(open(os.path.expanduser(r'~\.mineru\config.yaml'), encoding='utf-8'))
        return (cfg or {}).get('token') or ''
    except Exception:
        return os.environ.get('MINERU_TOKEN', '')


def ocr_one(script, tok, rel, fp, md_dir):
    """调 MinerU 解析一个文件，返回 (ok, chars, err, md_path)"""
    import subprocess
    import shutil
    h = hashlib.md5(rel.encode('utf-8')).hexdigest()
    work = os.path.join(os.environ.get('TEMP', '.'), 'wb_scan_' + h)
    env = dict(os.environ)
    env['PYTHONIOENCODING'] = 'utf-8'
    env['MINERU_TOKEN'] = tok
    cmd = [sys.executable, script, fp, '--output', work, '--api', 'standard',
           '--model', 'vlm', '--split', '--ocr']
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=3600, env=env)
    except subprocess.TimeoutExpired:
        return False, 0, 'timeout', ''
    if p.returncode != 0:
        err = (p.stderr or p.stdout or b'').decode('utf-8', 'replace')[-300:].strip()
        return False, 0, err or ('exit %s' % p.returncode), ''
    mds = []
    for dirpath, _, filenames in os.walk(work):
        for f in filenames:
            if f.lower().endswith('.md'):
                mds.append(os.path.join(dirpath, f))
    if not mds:
        shutil.rmtree(work, ignore_errors=True)
        return False, 0, '未产出 Markdown', ''
    mds.sort(key=lambda p: os.path.getsize(p), reverse=True)
    text = ''
    for m in mds:
        text += open(m, encoding='utf-8', errors='replace').read() + '\n'
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(md_dir, exist_ok=True)
    dst = os.path.join(md_dir, h + '.md')
    with open(dst, 'w', encoding='utf-8') as f:
        f.write(text)
    return True, len(text), '', dst


# ---------------------------------------------------------------- Excel 导出

def write_xlsx(path, records, projects):
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font, PatternFill
        from openpyxl.utils import get_column_letter
    except Exception:
        emit('xlsx', ok=False, reason='openpyxl 不可用')
        return False

    def style(ws, widths):
        for i, w in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = w
        for c in ws[1]:
            c.font = Font(bold=True, color='FFFFFF')
            c.fill = PatternFill('solid', fgColor='4472C4')
            c.alignment = Alignment(horizontal='center', vertical='center')
        ws.freeze_panes = 'A2'
        ws.auto_filter.ref = ws.dimensions

    wb = Workbook()
    ws = wb.active
    ws.title = '项目索引'
    ws.append(['年份', '受理号', '项目名称', '本地文件', '体积(MB)', '最近修改', '本地目录',
               '项目状态', '委托方', '报告编号', '来源'])
    for p in sorted(projects, key=lambda x: (x.get('year') or '', x.get('name') or '')):
        ws.append([
            p.get('year', ''), p.get('acceptanceNo', ''), p.get('name', ''),
            p.get('localFiles') or 0, round((p.get('localBytes') or 0) / 1048576, 1),
            p.get('localMtimeText', ''), p.get('dir', ''),
            p.get('status', ''), p.get('client', ''), p.get('reportNo', ''),
            p.get('origin') or 'crawl',
        ])
    style(ws, [9, 14, 38, 10, 10, 12, 64, 12, 30, 28, 9])

    ws2 = wb.create_sheet('文件清单')
    ws2.append(['年份', '项目', '一级目录', '文件名', '扩展名', '字节', '修改时间', '可检索', '字数', 'OCR'])
    for r in records:
        ws2.append([
            r.get('year', ''), r.get('project', ''), (r.get('subdir') or '').split('\\')[0],
            r.get('file', ''), r.get('ext', ''), r.get('size') or 0,
            time.strftime('%Y-%m-%d %H:%M', time.localtime(r.get('mtime') or 0)),
            '是' if r.get('text') else '否', r.get('chars') or 0, r.get('ocr') or '',
        ])
    style(ws2, [9, 34, 22, 44, 8, 12, 17, 8, 9, 9])

    ws3 = wb.create_sheet('分类统计')
    ws3.append(['年份', '一级目录', '文件数', '体积(MB)'])
    agg = {}
    for r in records:
        key = (r.get('year', ''), (r.get('subdir') or '').split('\\')[0] or '(项目根目录)')
        a = agg.setdefault(key, [0, 0])
        a[0] += 1
        a[1] += r.get('size') or 0
    for (y, cat), (n, sz) in sorted(agg.items()):
        ws3.append([y, cat, n, round(sz / 1048576, 1)])
    ws3.append(['合计', '', sum(v[0] for v in agg.values()),
                round(sum(v[1] for v in agg.values()) / 1048576, 1)])
    style(ws3, [10, 26, 10, 12])

    tmp = path + '.tmp'
    wb.save(tmp)
    os.replace(tmp, path)
    return True


# ---------------------------------------------------------------- 主流程

def load_prev(idx_path):
    done = {}
    if not os.path.exists(idx_path):
        return done
    with open(idx_path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get('rel'):
                done[r['rel']] = r
    return done


def load_mineru(idx_dir):
    """已 OCR 成功的 rel 集合（MinerU 结果在 mineru/<md5>.md，比 texts 里的内容权威）"""
    out = {}
    if not os.path.exists(idx_dir):
        return out
    for line in open(idx_dir, encoding='utf-8'):
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get('ok') and r.get('chars') and r.get('rel'):
            out[r['rel']] = r
    return out


def load_crawl_meta(root):
    """读现有 projects_index.json，把爬取到的项目元数据按「年份+受理号」建索引，导出 Excel 时回填。"""
    p = os.path.join(root, '_索引库', 'projects_index.json')
    meta = {}
    if not os.path.exists(p):
        return meta
    try:
        d = json.load(open(p, encoding='utf-8'))
    except Exception:
        return meta
    for prj in d.get('projects') or []:
        key = (prj.get('year') or '', str(prj.get('acceptanceNo') or ''))
        meta[key] = prj
    return meta


def project_meta(records):
    """按项目聚合成项目列表（给 xlsx 用；JSON 索引由宿主用爬取元数据合并）。

    只收「磁盘上真的有文件」的项目。空目录不再出现在项目索引里：空目录既不能浏览
    也不能检索，列出来只会让项目数虚高（旧版把它标成「待归档」）。
    """
    agg = {}
    for r in records:
        key = (r.get('year', ''), r.get('project', ''))
        a = agg.setdefault(key, {'files': 0, 'bytes': 0, 'mtime': 0})
        a['files'] += 1
        a['bytes'] += r.get('size') or 0
        a['mtime'] = max(a['mtime'], r.get('mtime') or 0)
    out = []
    for (y, proj), a in agg.items():
        m = re.match(r'^(\d{5,})[\s_-]*(.*)$', proj)
        out.append({
            'year': y, 'project': proj, 'name': m.group(2).strip() if m else proj,
            'acceptanceNo': m.group(1) if m else '',
            'localFiles': a['files'], 'localBytes': a['bytes'], 'localMtime': a['mtime'],
            'dir': proj,
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', required=True)
    ap.add_argument('--mode', default='quick', choices=['quick', 'full'])
    ap.add_argument('--ocr', action='store_true')
    ap.add_argument('--ocr-limit', type=int, default=20)
    ap.add_argument('--no-xlsx', action='store_true')
    ap.add_argument('--limit', type=int, default=0,
                    help='调试用：只抽取前 N 个待处理文件（索引仍保留全部条目）')
    ap.add_argument('--dry-run', action='store_true',
                    help='只统计不写入（不改 kb_index.jsonl 与 Excel）')
    ap.add_argument('--rebuild', action='store_true',
                    help='从已有 texts/*.txt 重建索引（不重新抽取）；缺文本的文件照常抽取')
    ap.add_argument('--no-word-first', action='store_true',
                    help='关掉「Word 优先」：默认报告/说明有 Word 版时不再解析对应 PDF，'
                         '「04 装订版」里同名同大小的副本也不重复入库')
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    kb = os.path.join(root, '_知识库')
    texts = os.path.join(kb, 'texts')
    md_dir = os.path.join(kb, 'mineru')
    idx_path = os.path.join(kb, 'kb_index.jsonl')
    os.makedirs(texts, exist_ok=True)

    emit('start', root=root, mode=args.mode, ocr=bool(args.ocr), rebuild=bool(args.rebuild))
    prev = load_prev(idx_path)
    mineru = load_mineru(os.path.join(kb, 'mineru_index.jsonl'))

    files = list(iter_files(root))
    disk_rel = set(f[2] for f in files)

    # Word 优先：先把「不该再解析」的文件算出来（只看文件名，不用读正文）
    shadow = {} if args.no_word_first else word_priority_shadow(files)
    n_pdf = sum(1 for v in shadow.values() if v.get('shadow') == 'pdf-word')
    n_bound = sum(1 for v in shadow.values() if v.get('shadow') == 'bound-copy')
    if shadow:
        emit('dedupe', shadowed=len(shadow), pdfWord=n_pdf, boundCopy=n_bound,
             files=list(shadow.keys())[:20])
    added = [f for f in files if f[2] not in prev]
    removed = [r for r in prev if r not in disk_rel]
    changed = []
    same = []
    for f in files:
        p = prev.get(f[2])
        if not p:
            continue
        if p.get('size') == f[4] and p.get('mtime') == f[5]:
            same.append(f)
        else:
            changed.append(f)

    def text_path(rel):
        return os.path.join(texts, hashlib.md5(rel.encode('utf-8')).hexdigest() + '.txt')

    # 原来被 Word 版顶掉的文件，如果 Word 版被删了（或规则改了），要重新进抽取队列
    revived = [f for f in same if f[2] not in shadow and (prev.get(f[2]) or {}).get('shadow')]
    if revived:
        revived_set = set(f[2] for f in revived)
        same = [f for f in same if f[2] not in revived_set]
        changed.extend(revived)

    # --rebuild：索引丢了但 texts/ 还在时，用现成文本重建记录，不重新解析原文件
    recover = []
    if args.rebuild:
        for f in added + changed:
            rel = f[2]
            tp = text_path(rel)
            try:
                if os.path.getsize(tp) > 0:
                    recover.append(f)
            except OSError:
                pass
        recover_set = set(f[2] for f in recover)
        added = [f for f in added if f[2] not in recover_set]
        changed = [f for f in changed if f[2] not in recover_set]

    emit('walk', total=len(files), added=len(added), changed=len(changed),
         removed=len(removed), same=len(same), recovered=len(recover))

    todo = files if args.mode == 'full' else (added + changed)
    # --limit 只截断「抽取工作量」，索引仍以全部磁盘文件为准；
    # 被截掉的文件先记成 pending 条目，下次扫描会继续抽。
    limited = args.limit > 0 and len(todo) > args.limit
    deferred = todo[args.limit:] if limited else []
    if limited:
        todo = todo[:args.limit]
    total = len(todo)
    emit('extract', done=0, total=total, ok=0, skip=0, fail=0, file='')

    records = {}      # rel -> record
    n_ok = n_skip = n_fail = 0
    fails = []
    pending_ocr = []

    # 先放「未变化」的旧记录，保证全量顺序稳定
    for f in same:
        rec = dict(prev[f[2]])
        s = shadow.get(f[2])
        if s:
            rec.update(s)
            rec['text'] = False
            if rec.get('textFile'):
                rec['shadowedText'] = True      # 正文文件留着，打开文件时还能看
        else:
            for k in ('shadow', 'dupOf', 'shadowedText'):
                rec.pop(k, None)
        records[f[2]] = rec

    # 再放 --rebuild 恢复的记录（文本直接从 texts/ 读取，字数按文件大小估）
    for y, proj, rel, fp, size, mtime in recover:
        if shadow.get(rel):
            records[rel] = {'year': y, 'project': proj, 'subdir': subdir_of(rel, y, proj),
                            'rel': rel, 'file': os.path.basename(fp),
                            'ext': os.path.splitext(fp)[1].lower(),
                            'size': size, 'mtime': mtime, 'text': False, **shadow[rel]}
            continue
        tp = text_path(rel)
        ext = os.path.splitext(fp)[1].lower()
        rec = {'year': y, 'project': proj, 'subdir': subdir_of(rel, y, proj),
               'rel': rel, 'file': os.path.basename(fp), 'ext': ext,
               'size': size, 'mtime': mtime, 'text': True,
               'textFile': os.path.basename(tp), 'recovered': True}
        try:
            body = open(tp, encoding='utf-8', errors='replace').read()
            rec['chars'] = len(body)
            rec['scanned'] = rel in mineru
        except OSError:
            rec['chars'] = 0
        o = mineru.get(rel)
        if o:
            rec.update({'scanned': True, 'ocr': 'mineru', 'chars': o.get('chars') or rec.get('chars')})
        records[rel] = rec
        n_ok += 1

    t_last = 0.0
    for i, (y, proj, rel, fp, size, mtime) in enumerate(todo, 1):
        ext = os.path.splitext(fp)[1].lower()
        base = {'year': y, 'project': proj, 'subdir': subdir_of(rel, y, proj),
                'rel': rel, 'file': os.path.basename(fp), 'ext': ext,
                'size': size, 'mtime': mtime}
        if size > MAX_BYTES:
            base.update({'text': False, 'note': '超过 %dMB，未抽取' % (MAX_BYTES // 1048576)})
            records[rel] = base
            n_skip += 1
        elif shadow.get(rel):
            base.update(dict(shadow[rel]))
            base['text'] = False
            records[rel] = base
            n_skip += 1
        elif ext not in TEXT_EXT:
            base.update({'text': False,
                         'note': '图片，仅按文件名检索' if ext in IMAGE_EXT
                         else ('压缩包，需解压后入库' if ext in ARCHIVE_EXT else '非文本类型')})
            records[rel] = base
            n_skip += 1
        else:
            try:
                text, meta = extract_any(fp)
            except Exception as e:
                base.update({'text': False, 'error': ('%s: %s' % (type(e).__name__, e))[:200]})
                records[rel] = base
                n_fail += 1
                if len(fails) < 50:
                    fails.append({'file': rel, 'error': base['error']})
            else:
                if text is None:
                    base.update({'text': False, 'note': meta.get('unsupported', '不支持')})
                    records[rel] = base
                    n_skip += 1
                else:
                    text = norm_lines(text)
                    h = hashlib.md5(rel.encode('utf-8')).hexdigest()
                    with open(os.path.join(texts, h + '.txt'), 'w', encoding='utf-8') as f:
                        f.write(text)
                    scanned = bool(meta.get('scanned'))
                    # 抽出 0 字（扫描件没有文字层）不能算「有全文」：
                    # 否则概览的「有全文 / 共索引」会把空文本也算进去，检索也白读一遍空文件。
                    has_text = bool(text.strip())
                    base.update({'text': has_text, 'chars': len(text), 'textFile': h + '.txt',
                                 'scanned': scanned, 'pages': meta.get('pages')})
                    if not has_text:
                        base['note'] = '扫描件，无文字层' if scanned else '未抽取到文字'
                    if meta.get('fallback'):
                        base['fallback'] = meta['fallback']
                    # 已有 MinerU OCR 结果的扫描件不必再 OCR 一遍
                    o = mineru.get(rel)
                    if o and has_text:
                        base.update({'ocr': 'mineru'})
                    elif scanned and not has_text:
                        pending_ocr.append((rel, fp, base))
                    records[rel] = base
                    n_ok += 1

        now = time.time()
        if i == total or now - t_last > 0.8 or i % 20 == 0:
            t_last = now
            emit('extract', done=i, total=total, ok=n_ok, skip=n_skip, fail=n_fail,
                 file=os.path.basename(fp)[:80])

    # ---- 可选 OCR：只处理「扫描件 + 还没有 OCR 文本」的
    ocr_ok = ocr_fail = 0
    if args.ocr and pending_ocr:
        script = mineru_script()
        tok = mineru_token()
        if not script:
            emit('ocr', done=0, total=0, ok=0, fail=0, skipped='未找到 MinerU 脚本')
        else:
            batch = pending_ocr[:args.ocr_limit] if args.ocr_limit > 0 else pending_ocr
            emit('ocr', done=0, total=len(batch), ok=0, fail=0, file='')
            for i, (rel, fp, base) in enumerate(batch, 1):
                ok, chars, err, md = ocr_one(script, tok, rel, fp, md_dir)
                if ok and md:
                    h = hashlib.md5(rel.encode('utf-8')).hexdigest()
                    with open(os.path.join(texts, h + '.txt'), 'w', encoding='utf-8') as f:
                        f.write(open(md, encoding='utf-8', errors='replace').read())
                    base.update({'text': True, 'chars': chars, 'textFile': h + '.txt',
                                 'scanned': True, 'ocr': 'mineru'})
                    base.pop('note', None)
                    records[rel] = base
                    ocr_ok += 1
                else:
                    ocr_fail += 1
                    if len(fails) < 50:
                        fails.append({'file': rel, 'error': 'OCR: ' + (err or '')[:160]})
                emit('ocr', done=i, total=len(batch), ok=ocr_ok, fail=ocr_fail,
                     file=os.path.basename(fp)[:80])

    # 被 --limit 推迟的文件补一条 pending 记录，保证索引覆盖全部磁盘文件
    for y, proj, rel, fp, size, mtime in deferred:
        ext = os.path.splitext(fp)[1].lower()
        records[rel] = {'year': y, 'project': proj, 'subdir': subdir_of(rel, y, proj),
                        'rel': rel, 'file': os.path.basename(fp), 'ext': ext,
                        'size': size, 'mtime': mtime, 'text': False, 'pending': True,
                        'note': '待抽取（本次受 limit 限制）'}

    # ---- 写索引（原子替换，按年份/项目/路径稳定排序）
    ordered = sorted(records.values(), key=lambda r: (r.get('year', ''), r.get('project', ''), r.get('rel', '')))

    # 归一化历史记录：旧版抽取把「0 字的扫描件」也标成 text=True，会让概览的
    # 「有全文」虚高、检索白读空文件。未变化文件沿用的旧记录在这里一并纠正。
    fixed_empty = 0
    for r in ordered:
        if r.get('text') and not (r.get('chars') or 0) and not r.get('ocr'):
            r['text'] = False
            r.setdefault('note', '扫描件，无文字层' if r.get('scanned') else '未抽取到文字')
            fixed_empty += 1

    # Word 优先第二遍：文件名对不上时，按文号/正文重合判「同一份报告·说明」。
    # 先把上一轮由内容判重压掉的 PDF 放回来（Word 版可能已经删了），再重算。
    n_content = 0
    if not args.no_word_first:
        for r in ordered:
            if r.get('shadow') == 'pdf-content':
                for k in ('shadow', 'dupOf', 'dupWhy'):
                    r.pop(k, None)
                r.pop('note', None)
                if r.get('textFile'):
                    r['text'] = True
        extra = content_word_shadow(records, texts)
        # 文件名那一遍已经判过的，保留更具体的理由（「文件名对得上」比「文号相同」好解释）
        extra = {k: v for k, v in extra.items() if k not in shadow}
        n_content = len(extra)
        if n_content:
            emit('dedupe-content', shadowed=n_content,
                 total=len(shadow) + n_content,
                 files=[k for k in list(extra.keys())[:20]])
        for rel, info in extra.items():
            r = records.get(rel)
            if not r:
                continue
            r.update(info)
            r['text'] = False
            if r.get('textFile'):
                r['shadowedText'] = True

    # 清理孤儿正文：文件已从磁盘删除时，它原来的 texts/<md5>.txt 不再被任何记录引用。
    # texts 目录完全由扫描器管理，按「记录引用集合」删多余文件是安全的。
    orphan_removed = 0
    if not args.dry_run:
        keep = set(r.get('textFile') for r in ordered if r.get('textFile'))
        try:
            for fn in os.listdir(texts):
                if fn.endswith('.txt') and fn not in keep:
                    try:
                        os.remove(os.path.join(texts, fn))
                        orphan_removed += 1
                    except OSError:
                        pass
        except OSError:
            pass

    if not args.dry_run:
        tmp_idx = idx_path + '.tmp'
        with open(tmp_idx, 'w', encoding='utf-8') as f:
            for r in ordered:
                f.write(json.dumps(r, ensure_ascii=False) + '\n')
        os.replace(tmp_idx, idx_path)

    stats = {
        'total': len(ordered),
        'textDocs': sum(1 for r in ordered if r.get('text')),
        'scannedDocs': sum(1 for r in ordered if r.get('scanned')),
        'ocrDocs': sum(1 for r in ordered if r.get('ocr')),
        'chars': sum(r.get('chars') or 0 for r in ordered),
        'extracted': n_ok, 'skipped': n_skip, 'failed': n_fail,
        'added': len(added), 'changed': len(changed), 'removed': len(removed), 'same': len(same),
        'deferred': len(deferred), 'recovered': len(recover),
        'ocrOk': ocr_ok, 'ocrFail': ocr_fail,
        'pendingOcr': max(0, len(pending_ocr) - ocr_ok),
        'orphanRemoved': orphan_removed,
        'shadowed': len(shadow), 'shadowedPdf': n_pdf, 'shadowedBound': n_bound,
        'shadowedContent': n_content,
        'wordFirst': not bool(args.no_word_first),
        'fixedEmptyText': fixed_empty,
        'dryRun': bool(args.dry_run),
        'fails': fails,
    }

    if not args.no_xlsx and not args.dry_run:
        xp = os.path.join(root, '_索引库', '评估文件库索引.xlsx')
        try:
            os.makedirs(os.path.dirname(xp), exist_ok=True)
            crawl = load_crawl_meta(root)
            projs = project_meta(ordered)
            for p in projs:
                p['localMtimeText'] = time.strftime('%Y-%m-%d', time.localtime(p.get('localMtime') or 0))
                m = crawl.get((p.get('year') or '', p.get('acceptanceNo') or ''))
                if not m:
                    continue
                # 磁盘目录只是「年份 + 受理号 + 名称」，能从天源爬到的元数据都补上
                p['status'] = m.get('status') or ''
                p['client'] = m.get('client') or ''
                p['reportNo'] = m.get('reportNo') or ''
                p['origin'] = 'crawl'
            ok = write_xlsx(xp, ordered, projs)
            emit('xlsx', ok=bool(ok), path=xp, projects=len(projs))
        except Exception as e:
            emit('xlsx', ok=False, reason=('%s: %s' % (type(e).__name__, e))[:200])

    emit('done', stats=stats)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        emit('error', message='%s: %s' % (type(e).__name__, e),
             trace=traceback.format_exc()[-1200:])
        sys.exit(1)

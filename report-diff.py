#!/usr/bin/env python3
"""Read-only DOCX comparison. Usage: echo '{"baseline":"a.docx","modified":"b.docx"}' | python3 report-diff.py

Output is one JSON object on stdout. Locations are structural, zero-based paths in
word/document.xml, not writeback anchors. Only body paragraphs and table cell
paragraphs are compared. Other parts, formatting and unsupported objects are not
compared; an empty changes list does not establish document equivalence.
"""
import bisect
import collections
import json
import os
import sys
import zipfile
from xml.parsers import expat

MAX_ARCHIVE = 32 * 1024 * 1024
MAX_ENTRIES = 2048
MAX_TOTAL = 128 * 1024 * 1024
MAX_PART = 32 * 1024 * 1024
MAX_RATIO = 200
MAX_ELEMENTS = 1000000
MAX_DEPTH = 128
MAX_BLOCKS = 50000
MAX_REQUEST = 64 * 1024
# 天源导出/重新出稿时会把表格里的「0.00」占位符抹成空，用户在 Word 里打开、
# 另存后这些单元格就真的空了。这不是用户改的内容，报出来只会把真正的修改淹掉
# （实测浙江交投金属 V4：6 处全是这个形状，且全在两个「其中：长期股权投资」
# 子行里）。只认"表格单元格 && 原文恰好是 0.00 && 改后为空"，不做泛化——
# 正文里的 0.00 是真实数字，绝不能跳过。
ZERO_PLACEHOLDER = '0.00'
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
M = 'http://schemas.openxmlformats.org/officeDocument/2006/math'

def tag(namespace, name):
    return namespace + '}' + name

def fail(message):
    raise ValueError(message)

def load(path):
    if not isinstance(path, str) or not path or '\x00' in path:
        fail('document path must be a non-empty string')
    # Read from one open file descriptor and never extract entries to disk.
    with open(path, 'rb') as source:
        if os.fstat(source.fileno()).st_size > MAX_ARCHIVE:
            fail('archive exceeds size limit')
        with zipfile.ZipFile(source) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_ENTRIES:
                fail('archive has too many entries')
            names = set()
            total = 0
            target = None
            for info in infos:
                name = info.filename
                if name in names:
                    fail('duplicate ZIP entry')
                names.add(name)
                if name.startswith(('/', '\\')) or '\\' in name or any(x in ('.', '..') for x in name.split('/')):
                    fail('unsafe ZIP entry name')
                if info.flag_bits & 1:
                    fail('encrypted ZIP entry is unsupported')
                if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    fail('unsupported ZIP compression')
                if info.file_size > MAX_PART:
                    fail('ZIP entry exceeds size limit')
                total += info.file_size
                if total > MAX_TOTAL:
                    fail('ZIP expanded size exceeds limit')
                if info.file_size > 1024 * 1024 and info.file_size > MAX_RATIO * max(info.compress_size, 1):
                    fail('ZIP compression ratio exceeds limit')
                if name == 'word/document.xml':
                    target = info
            if target is None:
                fail('missing word/document.xml')
            with archive.open(target) as part:
                data = part.read(MAX_PART + 1)
            if len(data) > MAX_PART or len(data) != target.file_size:
                fail('document XML exceeds size limit or is truncated')
    return parse(data, names)

def parse(data, names):
    parser = expat.ParserCreate(namespace_separator='}')
    blocks, stack = [], []
    warnings = set()
    count = 0
    current = None
    body_seen = False
    # 正在被"接受修订"删掉的文字深度：>0 时的 w:t 不计入段落文本。
    # moveFrom 同理（移动的源位置，接受修订后那里的文字就没了）。
    del_depth = [0]
    # Any ignored part means comparison is intentionally incomplete.
    if any(n.startswith('word/') and n.endswith('.xml') and n != 'word/document.xml' and
           (n.startswith(('word/header', 'word/footer', 'word/footnotes', 'word/endnotes', 'word/comments', 'word/glossary/'))) for n in names):
        warnings.add('non-body content such as headers, footers, notes or comments is not compared')
    if any(n.startswith(('word/media/', 'word/embeddings/', 'word/charts/')) for n in names):
        warnings.add('media, embedded objects and charts are not compared')
    def prohibited(*_):
        fail('DTD and entity declarations are prohibited')
    parser.StartDoctypeDeclHandler = prohibited
    parser.EntityDeclHandler = prohibited
    parser.ExternalEntityRefHandler = prohibited
    parser.ProcessingInstructionHandler = prohibited
    def start(name, attrs):
        nonlocal count, current, body_seen
        count += 1
        if count > MAX_ELEMENTS or len(stack) >= MAX_DEPTH:
            fail('XML complexity limit exceeded')
        if not stack:
            if name != tag(W, 'document'):
                fail('unexpected XML root')
            path = []
        else:
            parent = stack[-1]
            index = parent['children']
            parent['children'] += 1
            path = parent['path'] + [index]
        stack.append({'name': name, 'path': path, 'children': 0})
        if name == tag(W, 'body') and len(stack) == 2:
            if body_seen:
                fail('multiple document bodies')
            body_seen = True
        in_body = len(stack) >= 2 and stack[1]['name'] == tag(W, 'body')
        if not in_body:
            return
        local = name.split('}')[-1]
        if name.startswith(M + '}') or (name.startswith(W + '}') and local in ('drawing', 'pict', 'object', 'altChunk', 'fldSimple', 'fldChar', 'instrText', 'subDoc', 'sdt', 'txbxContent')):
            warnings.add('document contains unsupported objects, fields, content controls or formulas')
            if current is not None:
                current['unsupported'] = True
        # 修订（Track Changes）按「全部接受」处理。
        #
        # 为什么不能像以前那样一见到 w:ins 就把整段标成 unsupported：用户在 Word
        # 里开着修订改稿是最常见的做法，那样每一处真实改动都会变成"含变量/图片"、
        # 被判不可写回——功能等于对最典型的用法失效（实测：同一处改动，未开修订
        # 得到 candidate_change，开着修订得到 unpaired+unsupported）。
        #
        # 「接受修订」的语义就是：w:ins / w:moveTo 里的文字算数，
        # w:del / w:moveFrom 里的文字不算数（w:delText 本来就不是 w:t，天然被跳过）。
        # 于是段落文本恰好等于用户"接受全部修订后"的样子，正是要写回线上的内容。
        if name.startswith(W + '}') and local in ('ins', 'moveTo'):
            warnings.add('tracked revisions are interpreted as accepted')
        if name.startswith(W + '}') and local in ('del', 'moveFrom'):
            warnings.add('tracked revisions are interpreted as accepted')
            del_depth[0] += 1
        if name == tag(W, 'p'):
            if current is not None:
                current['unsupported'] = True
                warnings.add('nested paragraphs are not fully compared')
            else:
                ancestors = [x['name'] for x in stack[2:-1]]
                direct = not ancestors
                cell = bool(ancestors and ancestors[-1] == tag(W, 'tc'))
                if direct or cell:
                    # ins/del/moveFrom/moveTo 已按"接受修订"处理，不再是 unsupported；
                    # 只有 sdt（内容控件）和 txbxContent（文本框）仍不可比较。
                    current = {'kind': 'paragraph' if direct else 'table_cell_paragraph', 'path': path, 'text': '', 'unsupported': any(x.split('}')[-1] in ('sdt', 'txbxContent') for x in ancestors), '_depth': len(stack)}
                else:
                    warnings.add('paragraphs in unsupported body containers are not compared')
        if current is not None and name in (tag(W, 'tab'), tag(W, 'br'), tag(W, 'cr')):
            current['text'] += '\t' if name == tag(W, 'tab') else '\n'
    def chars(value):
        if current is not None and del_depth[0] == 0 and stack and stack[-1]['name'] == tag(W, 't'):
            current['text'] += value
    def end(name):
        nonlocal current
        if name.startswith(W + '}') and name.split('}')[-1] in ('del', 'moveFrom') and del_depth[0] > 0:
            del_depth[0] -= 1
        if current is not None and name == tag(W, 'p') and len(stack) == current['_depth']:
            del current['_depth']
            blocks.append(current)
            if len(blocks) > MAX_BLOCKS:
                fail('too many comparable paragraphs')
            current = None
        stack.pop()
    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = chars
    parser.Parse(data, True)
    if not body_seen:
        fail('missing document body')
    warnings.add('formatting, layout, numbering, relationships and non-body content are not compared')
    return blocks, sorted(warnings)

def compare(a, b):
    # Unique text anchors plus a longest increasing subsequence: O(n log n),
    # rather than an unbounded quadratic sequence diff. All anchors and paths
    # are for review only, not identities or writeback targets.
    def key(x):
        return (x['kind'], x['text'])
    def same_block(x, y):
        # Same kind and same text counts as unchanged. That includes paragraphs
        # that carry a formula or an image: we cannot look inside those objects,
        # so reporting them as "modified" whenever their surrounding text is
        # identical produces noise, and reporting them as "unchanged" would be
        # an unverified claim. We do neither quietly — such blocks are counted
        # in `unsupportedUnchanged` so the UI can say "N 处含公式/图片，未逐字节比较".
        if key(x) == key(y):
            return True
        # 只有一个空格与完全空白的差别不是"改动"：天源生成件里这类空段落很多，
        # 逐条报出来只会把真正的修改淹掉。
        if (x['kind'] == y['kind'] and not x['unsupported'] and not y['unsupported']
                and not x['text'].strip() and not y['text'].strip()):
            return True
        # 导出占位符被抹平：表格单元格里 0.00 → 空。见 ZERO_PLACEHOLDER 的说明。
        # 只比表格单元格；正文段落的 0.00 是真实数字，不能当噪声吞掉。
        if (x['kind'] == 'table_cell_paragraph' and y['kind'] == 'table_cell_paragraph'
                and not x['unsupported'] and not y['unsupported']
                and x['text'].strip() == ZERO_PLACEHOLDER and not y['text'].strip()):
            return True
        return False
    ca = collections.Counter(map(key, a))
    cb = collections.Counter(map(key, b))
    positions = {key(x): i for i, x in enumerate(b)
                 if x['text'] and not x['unsupported'] and cb[key(x)] == 1}
    pairs = [(i, positions[key(x)]) for i, x in enumerate(a)
             if x['text'] and not x['unsupported'] and ca[key(x)] == 1
             and key(x) in positions]
    tails, tail_indices, previous = [], [], []
    for idx, (_, pos) in enumerate(pairs):
        at = bisect.bisect_left(tails, pos)
        previous.append(tail_indices[at - 1] if at else -1)
        if at == len(tails):
            tails.append(pos)
            tail_indices.append(idx)
        else:
            tails[at] = pos
            tail_indices[at] = idx
    anchors = []
    cursor = tail_indices[-1] if tail_indices else -1
    while cursor != -1:
        anchors.append(pairs[cursor])
        cursor = previous[cursor]
    anchors.reverse()
    changes = []
    unsupported_same = 0
    def gap(left, right, after=None, before=None):
        nonlocal unsupported_same
        if not left and not right:
            return
        # Identical text needs no diff — including repeated and empty blocks.
        # 含公式/图片的段落只比了外围文字，这里不报"改动"，但要如实计数，
        # 让界面能说明"N 处含公式或图片，未做逐字节比较"。
        if len(left) == len(right) and all(same_block(x, y) for x, y in zip(left, right)):
            unsupported_same += sum(1 for x in left if x['unsupported'])
            return
        # 先判"等价"再判增删：表格里 0.00 → 空 这种导出噪声两侧段数相同、
        # same_block 为真，如果先判增删就会被当成"删了一段 0.00"。
        # 新增/删除的判定要忽略空白段落：删掉一句正文时，Word 往往连带少几个
        # 空段（实测删 1 句，左 5 段右 4 段，其中 4 段本来就空）。不先滤掉空白，
        # 就永远判不成"纯删除"，只能退回 unpaired。
        left_real = [x for x in left if str(x.get('text') or '').strip()]
        right_real = [y for y in right if str(y.get('text') or '').strip()]
        # 纯新增：改稿有实质内容、原稿这段位置没有。
        if not left_real and right_real:
            changes.append({'type': 'insertion', 'after': after, 'before': before, 'modified': right_real})
            return
        # 纯删除：原稿有实质内容、改稿这段没了。
        if left_real and not right_real:
            changes.append({'type': 'deletion', 'baseline': left_real, 'after': after, 'before': before})
            return
        # 两侧段数与类型完全对齐时逐位配对。真实文档里一处文字改动常被上下
        # 若干空段落夹住（正文里空行很多），整段按"未配对"报掉的话用户根本
        # 看不到自己到底改了哪一句。逐位配对后，唯一且确实不同的那几对升级成
        # 候选修改，其余仍按未配对保留。
        if len(left) == len(right) and all(x['kind'] == y['kind'] for x, y in zip(left, right)):
            pending = []
            for x, y in zip(left, right):
                if same_block(x, y):
                    unsupported_same += 1 if x['unsupported'] else 0
                    continue
                if (not x['unsupported'] and not y['unsupported'] and x['text'] and y['text']
                        and ca[key(x)] == 1 and cb[key(y)] == 1):
                    changes.append({'type': 'candidate_change', 'baseline': x, 'modified': y})
                else:
                    pending.append((x, y))
            if pending:
                changes.append({'type': 'unpaired',
                                'baseline': [x for x, _ in pending],
                                'modified': [y for _, y in pending],
                                'reason': 'ambiguous, repeated, unsupported or structural change'})
            return
        if len(left) == len(right) == 1 and left[0]['kind'] == right[0]['kind'] and all(not x['unsupported'] and x['text'] for x in left + right) and ca[key(left[0])] == 1 and cb[key(right[0])] == 1 and ca[key(right[0])] <= 1 and cb[key(left[0])] <= 1:
            changes.append({'type': 'candidate_change', 'baseline': left[0], 'modified': right[0]})
        else:
            changes.append({'type': 'unpaired', 'baseline': left, 'modified': right, 'reason': 'ambiguous, repeated, unsupported or structural change'})
    i = j = 0
    for ai, bj in anchors + [(len(a), len(b))]:
        # 插入/删除的位置靠"前一段实质内容"确定。不能直接用 a[i-1]：
        # 天源生成件里空段落极多，紧挨着的那段十有八九是空的，拿它当锚点
        # 定位不到任何节点。往回找到第一段有文字的才算数。
        anchor = None
        for k in range(i - 1, -1, -1):
            if str(a[k].get('text') or '').strip():
                anchor = a[k]
                break
        # 文首新增/删除时前面没有段落可锚，只能往后找。锚在后面时写回语义变成
        # 「插到它前面 / 删掉它前面那几段」，由 before 标记区分。
        forward = None
        for k in range(ai, len(a)):
            if str(a[k].get('text') or '').strip():
                forward = a[k]
                break
        gap(a[i:ai], b[j:bj], anchor, forward)
        i, j = ai + 1, bj + 1
    return changes, unsupported_same

def main():
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
        if len(raw) > MAX_REQUEST:
            fail('request exceeds size limit')
        req = json.loads(raw)
        if not isinstance(req, dict) or set(req) != {'baseline', 'modified'}:
            fail('request must contain exactly baseline and modified paths')
        a, wa = load(req['baseline'])
        b, wb = load(req['modified'])
        changes, unsupported_same = compare(a, b)
        result = {'ok': True, 'readOnly': True, 'writebackSupported': False,
                  'scope': 'body paragraphs and table cell paragraphs only',
                  'baseline': {'blocks': len(a), 'warnings': wa},
                  'modified': {'blocks': len(b), 'warnings': wb},
                  'unsupportedUnchanged': unsupported_same,
                  'changes': changes}
        code = 0
    except Exception as exc:
        result = {'ok': False, 'error': str(exc), 'readOnly': True, 'writebackSupported': False}
        code = 1
    print(json.dumps(result, ensure_ascii=False))
    return code

if __name__ == '__main__':
    sys.exit(main())

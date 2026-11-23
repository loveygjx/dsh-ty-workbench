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
        if name.startswith(W + '}') and (local in ('ins', 'del', 'moveFrom', 'moveTo', 'delText') or local.endswith('PrChange')):
            warnings.add('tracked revisions are not interpreted')
            if current is not None:
                current['unsupported'] = True
        if name == tag(W, 'p'):
            if current is not None:
                current['unsupported'] = True
                warnings.add('nested paragraphs are not fully compared')
            else:
                ancestors = [x['name'] for x in stack[2:-1]]
                direct = not ancestors
                cell = bool(ancestors and ancestors[-1] == tag(W, 'tc'))
                if direct or cell:
                    current = {'kind': 'paragraph' if direct else 'table_cell_paragraph', 'path': path, 'text': '', 'unsupported': any(x.split('}')[-1] in ('ins', 'del', 'moveFrom', 'moveTo', 'sdt', 'txbxContent') for x in ancestors), '_depth': len(stack)}
                else:
                    warnings.add('paragraphs in unsupported body containers are not compared')
        if current is not None and name in (tag(W, 'tab'), tag(W, 'br'), tag(W, 'cr')):
            current['text'] += '\t' if name == tag(W, 'tab') else '\n'
    def chars(value):
        if current is not None and stack and stack[-1]['name'] == tag(W, 't'):
            current['text'] += value
    def end(name):
        nonlocal current
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
        return (x['kind'] == y['kind'] and not x['unsupported'] and not y['unsupported']
                and not x['text'].strip() and not y['text'].strip())
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
    def gap(left, right):
        nonlocal unsupported_same
        if not left and not right:
            return
        # Identical text needs no diff — including repeated and empty blocks.
        # 含公式/图片的段落只比了外围文字，这里不报"改动"，但要如实计数，
        # 让界面能说明"N 处含公式或图片，未做逐字节比较"。
        if len(left) == len(right) and all(same_block(x, y) for x, y in zip(left, right)):
            unsupported_same += sum(1 for x in left if x['unsupported'])
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
        gap(a[i:ai], b[j:bj])
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

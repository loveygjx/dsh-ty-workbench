# -*- coding: utf-8 -*-
"""知识库（wiki）体检：断链、孤儿页、空页、主题骨架、过期页。

    python lint_wiki.py --root "D:\\天源评估\\已归档" [--fix-log]

输出人类可读的清单 + 一行 JSON 汇总。不修改任何页面（只报告），
要修就重跑 build_wiki.py / 重新编译主题页。
"""
import argparse
import json
import os
import re
import sys
import time

LINK_RE = re.compile(r'\[\[([a-z]+)/([^|\]]+)\|')


def load(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def frontmatter(txt):
    m = re.match(r'^---\n([\s\S]*?)\n---\n', txt)
    if not m:
        return {}
    out = {}
    for line in m.group(1).splitlines():
        if ':' in line:
            k, v = line.split(':', 1)
            out[k.strip()] = v.strip()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', required=True)
    ap.add_argument('--out', default='')
    args = ap.parse_args()
    root = os.path.abspath(args.root)
    base = args.out or os.path.join(root, '_wiki', 'wiki')

    pages = {}
    for kind in ('projects', 'topics', 'years'):
        d = os.path.join(base, kind)
        for fn in sorted(os.listdir(d)) if os.path.isdir(d) else []:
            if fn.endswith('.md'):
                pages['%s/%s' % (kind, fn[:-3])] = os.path.join(d, fn)
    index_p = os.path.join(base, 'index.md')
    files = dict(pages)
    if os.path.exists(index_p):
        files['index'] = index_p

    broken, inbound, fm = [], {}, {}
    for key, path in files.items():
        txt = load(path)
        fm[key] = frontmatter(txt)
        for m in LINK_RE.finditer(txt):
            target = '%s/%s' % (m.group(1), m.group(2))
            inbound[target] = inbound.get(target, 0) + 1
            if target not in pages:
                broken.append({'from': key, 'to': target})

    orphans = [k for k in pages if k.startswith('projects/') and inbound.get(k, 0) == 0]
    empty = [k for k in pages
             if k.startswith('projects/') and str(fm.get(k, {}).get('fulltext', '1')) in ('0', '')]
    stubs = [k for k in pages if k.startswith('topics/') and fm.get(k, {}).get('status') != 'compiled']

    print('== 断链（%d）==' % len(broken))
    for b in broken[:30]:
        print('  %s -> %s' % (b['from'], b['to']))
    if not broken:
        print('  无')
    print('== 孤儿项目页（没有页面指向它，%d）==' % len(orphans))
    for o in orphans[:30]:
        print('  ' + o)
    if not orphans:
        print('  无')
    print('== 项目页没有全文（只有扫描件/图片，%d）==' % len(empty))
    for e in empty[:30]:
        print('  ' + e)
    if not empty:
        print('  无')
    print('== 主题页还是骨架（%d）==' % len(stubs))
    for s in stubs:
        print('  ' + s)
    if not stubs:
        print('  无')
    print(json.dumps({'ev': 'done', 'pages': len(files), 'broken': len(broken),
                      'orphans': len(orphans), 'emptyProjects': len(empty),
                      'topicStubs': len(stubs), 'at': time.strftime('%Y-%m-%d %H:%M:%S')},
                     ensure_ascii=False))


if __name__ == '__main__':
    main()

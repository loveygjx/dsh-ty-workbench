# -*- coding: utf-8 -*-
"""为每个主题页收集「库内证据」摘要（digest），供 LLM 编译主题页正文。

    python topic_digest.py --root "D:\\天源评估\\已归档" --out <root>\\_wiki\\_work

输出：_work\\topic-<slug>.md，每份 = 命中统计 + 最多 16 条原文片段（带项目页链接）。
只读 kb_index.jsonl / texts，不改任何原文。
"""
import argparse
import json
import os
import re
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_wiki import TOPIC_RULES, project_slug, read_text, one_line  # noqa: E402

READ_LIMIT = 60000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', required=True)
    ap.add_argument('--out', default='')
    ap.add_argument('--per-topic', type=int, default=16)
    ap.add_argument('--min-chars', type=int, default=400)
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    out_dir = os.path.abspath(args.out or os.path.join(root, '_wiki', '_work'))
    os.makedirs(out_dir, exist_ok=True)
    kb = os.path.join(root, '_知识库')
    texts_dir = os.path.join(kb, 'texts')
    rows = [json.loads(l) for l in open(os.path.join(kb, 'kb_index.jsonl'), encoding='utf-8') if l.strip()]
    rows = [r for r in rows if r.get('text') and not r.get('shadow') and (r.get('chars') or 0) >= args.min_chars]

    hits = defaultdict(list)
    named = defaultdict(list)
    stats = defaultdict(lambda: {'files': 0, 'projects': set()})
    # 一遍扫完：正文里出现主题词才算证据；文件名/项目名也带主题词的额外记一笔优先级
    for r in rows:
        name = (r.get('project') or '') + ' ' + (r.get('file') or '')
        text = read_text(texts_dir, r, READ_LIMIT)
        for slug, title, kws in TOPIC_RULES:
            in_name = any(k in name for k in kws)
            for k in kws:
                i = text.find(k)
                if i < 0:
                    continue
                item = {'project': r.get('project'), 'file': r.get('file'), 'year': r.get('year'), 'kw': k,
                        'snippet': one_line(text[max(0, i - 150): i + 350], 460), 'named': in_name}
                (named[slug] if in_name else hits[slug]).append(item)
                stats[slug]['files'] += 1
                stats[slug]['projects'].add(r.get('project'))
                break

    made = 0
    for slug, title, kws in TOPIC_RULES:
        # 名字命中优先，但每个项目最多 2 条，避免一整页都是同一个项目
        picks = []
        per_proj = defaultdict(int)
        for pool in (named[slug], hits[slug]):
            for h in pool:
                if per_proj[h['project']] >= 2:
                    continue
                picks.append(h)
                per_proj[h['project']] += 1
                if len(picks) >= args.per_topic:
                    break
            if len(picks) >= args.per_topic:
                break
        lines = ['# 主题证据：%s' % title, '',
                 '- 关键词：%s' % '、'.join(kws),
                 '- 命中文件 %d 个，涉及项目 %d 个' % (stats[slug]['files'], len(stats[slug]['projects'])),
                 '- 下面每条都是原文片段，`[[projects/...]]` 是指回项目页的链接', '']
        if not picks:
            lines.append('（库里没有找到直接证据，写主题页时要如实说明）')
        for i, p in enumerate(picks, 1):
            link = 'projects/' + project_slug(p.get('year') or '', p.get('project') or '')
            lines.append('## 证据 %d · %s' % (i, p.get('project')))
            lines.append('- 文件：`%s`（%s，命中「%s」）' % (p.get('file'), p.get('year'), p.get('kw')))
            lines.append('- 项目页：[[%s|%s]]' % (link, p.get('project')))
            lines.append('')
            lines.append('> ' + (p.get('snippet') or '').replace('\n', ' '))
            lines.append('')
        p_out = os.path.join(out_dir, 'topic-%s.md' % slug)
        with open(p_out, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines))
        made += 1
    print(json.dumps({'ev': 'done', 'digests': made, 'out': out_dir}, ensure_ascii=False))


if __name__ == '__main__':
    main()

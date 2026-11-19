# -*- coding: utf-8 -*-
"""把归档库编译成 llm-wiki 结构的知识库（wiki 层）。

用法：
    python build_wiki.py --root "D:\\天源评估\\已归档" [--limit N] [--topics]

输入：<root>\\_知识库\\kb_index.jsonl + texts\\*.txt（scan_kb.py 的产物）
输出：<root>\\_wiki\\
        WIKI-SCHEMA.md          约定（目录、页面格式、交叉引用规则）
        wiki\\index.md          目录（按年份分组的项目页 + 主题页）
        wiki\\log.md            操作日志（追加）
        wiki\\projects\\*.md     每个项目一页实体页（339 页，纯脚本生成、可重复生成）
        wiki\\years\\*.md        年度页
        wiki\\topics\\*.md       主题页（脚本只建骨架，正文由 LLM 按证据编译）

为什么不把原文搬进 wiki：原始资料（raw）就是归档库本体，永不复制、永不修改；
wiki 只存「编译过的结论 + 指回原文的链接」，原文一旦更新，重跑脚本即可。

Word 优先：scan_kb.py 已经把「有 Word 版的 PDF」「装订版重复副本」标成 shadow，
本脚本默认跳过它们（--include-shadow 可包含），保证 wiki 的出处指向真正被解析的那份。
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
from collections import defaultdict

TEXT_DIR = 'texts'
IDX = 'kb_index.jsonl'

CAT_ORDER = [('01', '取数表'), ('02', '电子底稿'), ('03', '纸质报告、合同扫描'), ('04', '装订版报告')]

# 项目页里要摘的段落关键词（评估师问得最多的几件事）
KEY_SECTIONS = ['评估结论', '评估结果', '评估方法', '评估目的', '评估对象', '评估范围',
                '价值类型', '评估基准日', '收益法', '市场法', '资产基础法', '成本法']

TOPIC_RULES = [
    ('gongsu-jianzhi', '商誉减值测试', ['商誉减值', '减值测试', '资产组']),
    ('shouyifa', '收益法', ['收益法', '现金流折现', '折现率', 'WACC']),
    ('shichangfa', '市场法', ['市场法', '可比案例', '比较法']),
    ('zichanjichufa', '资产基础法（成本法）', ['资产基础法', '成本法']),
    ('wuxingzichan-tudi', '无形资产与土地使用权', ['无形资产', '土地使用权', '土地出让']),
    ('kuangyequan', '矿业权评估', ['矿业权', '采矿权', '探矿权']),
    ('shebei-fangwu', '机器设备与房屋建筑物', ['机器设备', '房屋建筑物', '重置成本', '成新率']),
    ('changtou-guquan', '长期股权投资与股权评估', ['长期股权投资', '股权评估', '股东全部权益']),
    ('baogao-jiegou', '报告与说明的行文结构', ['评估报告', '评估说明', '评估结论']),
    ('fuhe-tixi', '复核体系（一复/二复/三复）', ['复核', '三级复核', '复核意见']),
    ('guidang-guifan', '归档规范与目录结构', ['取数表', '电子底稿', '装订版']),
]


def emit(ev, **kw):
    kw['ev'] = ev
    sys.stdout.write(json.dumps(kw, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def safe_slug(s):
    s = re.sub(r'[\\/:*?"<>|\s]+', '-', str(s or '').strip())
    s = re.sub(r'-{2,}', '-', s).strip('-')
    return s[:80] or 'x'


def read_text(texts_dir, rec, limit=200000):
    tf = rec.get('textFile')
    if not tf:
        return ''
    p = os.path.join(texts_dir, tf)
    try:
        with open(p, encoding='utf-8', errors='replace') as f:
            return f.read(limit)
    except OSError:
        return ''


def one_line(s, n=120):
    return re.sub(r'\s+', ' ', str(s or '')).strip()[:n]


def snippets(text, budget=5, width=240):
    """按 KEY_SECTIONS 从正文里切出若干条带上下文的关键段落"""
    out = []
    if not text:
        return out
    for kw in KEY_SECTIONS:
        i = text.find(kw)
        if i < 0:
            continue
        seg = text[max(0, i - 40): i + width]
        seg = re.sub(r'\s+', ' ', seg).strip()
        if not seg:
            continue
        # 同一段落别重复摘（后一个关键词常落在前一条里）
        if any(seg[:40] in x for x in out):
            continue
        out.append(seg)
        if len(out) >= budget:
            break
    return out


def cat_of(rec):
    sub = rec.get('subdir') or ''
    for code, _ in CAT_ORDER:
        if sub.startswith(code) or ('\\' + code + ' ') in ('\\' + sub):
            return code
    m = re.match(r'(\d{2})', sub)
    return m.group(1) if m else '99'


def project_code(project):
    m = re.match(r'(\d{6,12})', project or '')
    return m.group(1) if m else ''


def project_slug(year, project):
    """文件名靠 year+受理号+项目名+短哈希保证唯一。

    同一个受理号会开好几个子项目（1000060659 天信仪表 / 易联云 / 湖北震新…），
    只用 year+受理号会让 86 个项目页互相覆盖。
    """
    code = project_code(project)
    name = project
    if code and name.startswith(code):
        name = name[len(code):].strip()
    base = safe_slug('%s_%s_%s' % (year.replace('年', ''), code or 'x', name))[:70]
    return base + '-' + hashlib.md5(project.encode('utf-8')).hexdigest()[:5]


def build(rows, root, out_dir, include_shadow=False, limit=0):
    texts_dir = os.path.join(root, '_知识库', TEXT_DIR)
    wiki = os.path.join(out_dir, 'wiki')
    for sub in ('projects', 'years', 'topics'):
        os.makedirs(os.path.join(wiki, sub), exist_ok=True)

    usable = [r for r in rows if include_shadow or not r.get('shadow')]
    by_proj = defaultdict(list)
    for r in usable:
        by_proj[r.get('project') or '未分类'].append(r)

    projects = sorted(by_proj.items(), key=lambda kv: (kv[1][0].get('year') or '', kv[0]))
    if limit:
        projects = projects[:limit]

    today = time.strftime('%Y-%m-%d')
    written = []

    # ---------------- 项目页 ----------------
    for proj, recs in projects:
        year = recs[0].get('year') or ''
        code = project_code(proj)
        slug = project_slug(year, proj)
        rels = sorted(recs, key=lambda r: (cat_of(r), r.get('subdir') or '', r.get('file') or ''))

        docs = sorted([r for r in rels if r.get('text')],
                      key=lambda r: (
                          # 报告 > 说明 > 明细表 > 其它；02 电子底稿优先
                          0 if ('报告' in (r.get('file') or '') and '明细' not in (r.get('file') or '')) else
                          1 if '说明' in (r.get('file') or '') else
                          2 if '明细' in (r.get('file') or '') else 3,
                          0 if cat_of(r) == '02' else 1,
                          -(r.get('chars') or 0)))
        ex = []
        for r in docs[:3]:
            for s in snippets(read_text(texts_dir, r), budget=3):
                if s not in ex:
                    ex.append(s)
            if len(ex) >= 6:
                break

        # 文档地图（每类最多 40 条，超出给计数）
        lines = []
        for code2, cat_name in CAT_ORDER:
            chunk = [r for r in rels if cat_of(r) == code2]
            if not chunk:
                continue
            lines.append('### %s %s（%d 个文件）' % (code2, cat_name, len(chunk)))
            for r in chunk[:40]:
                flag = ''
                if r.get('shadow'):
                    flag = ' · 有 Word 版/装订副本，未重复入库'
                elif not r.get('text'):
                    flag = ' · ' + (r.get('note') or '无全文')
                lines.append('- `%s`%s' % (r.get('file'), flag))
            if len(chunk) > 40:
                lines.append('- …另有 %d 个文件，见「文件库 › 浏览」' % (len(chunk) - 40))
            lines.append('')

        topics = []
        blob = proj + ' ' + ' '.join(r.get('file') or '' for r in rels)
        for slug_t, title_t, kws in TOPIC_RULES:
            if any(k in blob for k in kws):
                topics.append((slug_t, title_t))

        body = []
        body.append('---')
        body.append('title: %s' % proj.replace('\n', ' '))
        body.append('type: entity')
        body.append('created: %s' % today)
        body.append('updated: %s' % today)
        body.append('year: %s' % year.replace('年', ''))
        if code:
            body.append('code: %s' % code)
        body.append('files: %d' % len(rels))
        body.append('fulltext: %d' % sum(1 for r in rels if r.get('text')))
        body.append('sources:')
        for r in rels[:60]:
            body.append('  - %s' % (r.get('rel') or '').replace('\\', '/'))
        body.append('tags: [%s]' % ', '.join(t for _, t in topics))
        body.append('---')
        body.append('')
        body.append('# %s' % proj)
        body.append('')
        body.append('> %s · 文件 %d 个，其中 %d 个已抽取全文%s'
                    % (year, len(rels), sum(1 for r in rels if r.get('text')),
                       (' · 受理号 ' + code) if code else ''))
        body.append('')
        if ex:
            body.append('## 关键摘录（原文，可直接引用）')
            body.append('')
            for s in ex[:6]:
                body.append('- …%s…' % s)
            body.append('')
        body.append('## 文档地图')
        body.append('')
        body.extend(lines)
        body.append('## 出处')
        body.append('')
        body.append('原始资料在归档库：`%s\\%s`（只读）。本页由 `build_wiki.py` 从知识库索引生成，'
                    '重扫后重跑即可刷新。' % (year, proj))
        body.append('')
        body.append('## See Also')
        body.append('')
        body.append('- [[years/%s|%s 年归档]]' % (year.replace('年', '') or 'unknown', year.replace('年', '') or '未标年份'))
        for slug_t, title_t in topics[:6]:
            body.append('- [[topics/%s|%s]]' % (slug_t, title_t))
        body.append('')

        p = os.path.join(wiki, 'projects', slug + '.md')
        with open(p, 'w', encoding='utf-8') as f:
            f.write('\n'.join(body))
        written.append({'slug': slug, 'proj': proj, 'year': year, 'files': len(rels),
                        'fulltext': sum(1 for r in rels if r.get('text')), 'topics': topics})

    # ---------------- 年度页 ----------------
    years = defaultdict(list)
    for w in written:
        years[w['year'] or '未标年份'].append(w)
    for y, items in years.items():
        ys = y.replace('年', '')
        body = ['---', 'title: %s' % y, 'type: synthesis', 'created: %s' % today,
                'updated: %s' % today, 'projects: %d' % len(items), '---', '',
                '# %s' % y, '', '共 %d 个项目。' % len(items), '']
        for w in sorted(items, key=lambda x: x['proj']):
            body.append('- [[projects/%s|%s]] — 文件 %d · 全文 %d'
                        % (w['slug'], w['proj'], w['files'], w['fulltext']))
        body.append('')
        with open(os.path.join(wiki, 'years', (ys or 'unknown') + '.md'), 'w', encoding='utf-8') as f:
            f.write('\n'.join(body))

    # ---------------- 主题页骨架（已存在就不覆盖，保留 LLM 编译的正文） ----------------
    made_topics = 0
    for slug_t, title_t, kws in TOPIC_RULES:
        p = os.path.join(wiki, 'topics', slug_t + '.md')
        if os.path.exists(p):
            continue
        body = ['---', 'title: %s' % title_t, 'type: concept', 'created: %s' % today,
                'updated: %s' % today, 'status: stub', 'tags: [%s]' % title_t, '---', '',
                '# %s' % title_t, '',
                '> 骨架页：正文待按库内证据编译（关键词：%s）。' % '、'.join(kws), '',
                '## 相关项目', '']
        for w in written:
            if any(t[0] == slug_t for t in w['topics']):
                body.append('- [[projects/%s|%s]]' % (w['slug'], w['proj']))
        body.append('')
        with open(p, 'w', encoding='utf-8') as f:
            f.write('\n'.join(body))
        made_topics += 1

    # ---------------- index.md ----------------
    idx = ['---', 'title: 归档知识库目录', 'type: index', 'updated: %s' % today, '---', '',
           '# 归档知识库目录', '',
           '共 %d 个项目页、%d 个主题页。原文在归档库（只读），本目录只汇总编译过的页面。' % (len(written), len(TOPIC_RULES)), '',
           '## 主题', '']
    for slug_t, title_t, _ in TOPIC_RULES:
        idx.append('- [[topics/%s|%s]]' % (slug_t, title_t))
    idx.append('')
    for y, items in sorted(years.items(), key=lambda kv: kv[0], reverse=True):
        ys = y.replace('年', '') or 'unknown'
        idx.append('## %s（%d 个项目）' % (y, len(items)))
        idx.append('')
        idx.append('年度页：[[years/%s|%s]]' % (ys, y))
        idx.append('')
        for w in sorted(items, key=lambda x: x['proj']):
            idx.append('- [[projects/%s|%s]] — 文件 %d · 全文 %d'
                       % (w['slug'], w['proj'], w['files'], w['fulltext']))
        idx.append('')
    with open(os.path.join(wiki, 'index.md'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(idx))

    # ---------------- log.md ----------------
    logp = os.path.join(wiki, 'log.md')
    if not os.path.exists(logp):
        with open(logp, 'w', encoding='utf-8') as f:
            f.write('# 操作日志\n\n格式：`## [YYYY-MM-DD] 操作 | 标题`\n\n')
    with open(logp, 'a', encoding='utf-8') as f:
        f.write('## [%s] ingest | 归档库编译\n' % today)
        f.write('- 项目页 %d、年度页 %d、主题骨架 %d（%s）\n'
                % (len(written), len(years), made_topics,
                   '包含 shadow 文件' if include_shadow else '跳过 Word 版顶替的 PDF / 装订副本'))
        f.write('- 输入：`_知识库/kb_index.jsonl`（%d 行）\n\n' % len(rows))

    return {'projects': len(written), 'years': len(years), 'topics': made_topics}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', required=True)
    ap.add_argument('--out', default='')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--include-shadow', action='store_true')
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    out_dir = os.path.abspath(args.out or os.path.join(root, '_wiki'))
    idx_path = os.path.join(root, '_知识库', IDX)
    rows = []
    with open(idx_path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    emit('start', root=root, rows=len(rows), out=out_dir)
    st = build(rows, root, out_dir, include_shadow=args.include_shadow, limit=args.limit)
    emit('done', **st)


if __name__ == '__main__':
    main()

#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""股权信息批量导入 / 导入模板生成。

用法：
  python equity_import.py import <xlsx|csv>
  python equity_import.py template <输出 xlsx 路径>

只输出一行 JSON：{"ok": true, "rows": [...]} 或 {"ok": false, "error": "..."}
"""
import csv
import json
import os
import sys

HEADERS = {
    'name': ['公司名称', '企业名称', '被投资单位', '被投资单位名称'],
    'short': ['公司简称', '企业简称', '简称'],
    'parent': ['上级母公司', '母公司', '上级单位', '股东', '投资方'],
    'ratio': ['认缴持股比例%', '认缴持股比例', '持股比例%', '持股比例', '股权比例%', '股权比例'],
    'subject': ['科目名称', '会计科目', '科目'],
}


def norm(v):
    if v is None:
        return ''
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, int):
        return str(v)
    return str(v).strip()


def map_header(cells):
    idx = {}
    for key, aliases in HEADERS.items():
        for i, cellv in enumerate(cells):
            c = norm(cellv).replace(' ', '')
            if not c:
                continue
            hit = False
            for a in aliases:
                if c == a or c.startswith(a) or a in c:
                    hit = True
                    break
            if hit:
                idx[key] = i
                break
    return idx


def cellv_at(cells, i):
    if i is None or i < 0 or i >= len(cells):
        return ''
    return norm(cells[i])


def read_xlsx(path):
    from openpyxl import load_workbook
    wb = load_workbook(path, data_only=True, read_only=True)
    ws = wb[wb.sheetnames[0]]
    out = []
    for row in ws.iter_rows(values_only=True):
        out.append(list(row))
    return out


def read_csv(path):
    for enc in ('utf-8-sig', 'utf-8', 'gbk'):
        try:
            with open(path, 'r', encoding=enc, newline='') as fh:
                return [list(r) for r in csv.reader(fh)]
        except UnicodeDecodeError:
            continue
    raise RuntimeError('CSV 编码无法识别（试过 utf-8 / gbk）')


def is_note(text):
    t = (text or '').strip()
    if not t:
        return False
    if t[0] in ('注', '说明', '备注', '#', '（', '('):
        return True
    head = t.split('.')[0].split('、')[0]
    return head.isdigit()


def parse_rows(rows):
    idx = None
    out = []
    for cells in rows:
        if idx is None:
            maybe = map_header(cells)
            if 'name' in maybe:
                idx = maybe
            continue
        name = cellv_at(cells, idx.get('name'))
        if not name or is_note(name):
            continue
        out.append({
            'name': name,
            'short': cellv_at(cells, idx.get('short')),
            'parent': cellv_at(cells, idx.get('parent')),
            'ratio': cellv_at(cells, idx.get('ratio')),
            'subject': cellv_at(cells, idx.get('subject')),
        })
    return out


def make_template(path):
    from openpyxl import Workbook
    from openpyxl.styles import Font, Alignment, PatternFill
    wb = Workbook()
    ws = wb.active
    ws.title = '股权信息列表'
    heads = ['公司名称', '公司简称', '上级母公司', '认缴持股比例%', '科目名称']
    ws.append(heads)
    for i, w in enumerate([40, 18, 40, 18, 24], start=1):
        ws.column_dimensions[chr(64 + i)].width = w
    fill = PatternFill('solid', fgColor='EAF1FF')
    for c in ws[1]:
        c.font = Font(bold=True)
        c.fill = fill
        c.alignment = Alignment(horizontal='center')
    ws.append(['示例：某某有限公司', '某某公司', '', 100, '长期股权投资'])
    ws.append(['示例：某某子公司', '某某子公司', '示例：某某有限公司', 60, '长期股权投资'])
    ws.freeze_panes = 'A2'
    wb.save(path)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'import'
    if len(sys.argv) < 3:
        print(json.dumps({'ok': False, 'error': '缺少文件路径参数'}, ensure_ascii=True))
        return
    target = sys.argv[2]
    try:
        if mode == 'template':
            make_template(target)
            print(json.dumps({'ok': True, 'path': target}, ensure_ascii=True))
            return
        if not os.path.exists(target):
            raise RuntimeError('文件不存在：' + target)
        ext = os.path.splitext(target)[1].lower()
        rows = read_csv(target) if ext == '.csv' else read_xlsx(target)
        print(json.dumps({'ok': True, 'rows': parse_rows(rows)}, ensure_ascii=True))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=True))


if __name__ == '__main__':
    main()

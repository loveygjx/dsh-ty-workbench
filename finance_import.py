#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""财务资料导入：把「科目余额表 / 财务报表」里的科目名和金额抽出来。

用法：
  python finance_import.py import <xlsx|xlsm|csv>

只输出一行 JSON：{"ok": true, "rows": [{"name": "货币资金", "amount": "1234.56"}], "sheet": "...", "header": 2}
或 {"ok": false, "error": "..."}

为什么不猜：科目名/金额列靠表头关键字定位（科目名称、期末余额、账面价值……），
行只保留「有名字且金额是数」的，合计/小计行丢掉。找不到表头就报错，不瞎编。
"""
import csv
import json
import sys

NAME_KEYS = ['科目名称', '科目', '项目', '名称']
AMOUNT_PRIORITY = [
    ('期末余额', 5), ('期末数', 5),
    ('账面价值', 4), ('账面余额', 4),
    ('审定数', 3), ('未审数', 3),
    ('余额', 2), ('金额', 2), ('本期数', 2),
]
AMOUNT_BAN = ['期初', '借方', '贷方', '累计', '比例', '编码', '序号', '行次', '发生额']
SKIP_NAMES = ('合计', '小计', '总计', '本页合计', '累计折旧合计')


def norm(v):
    if v is None:
        return ''
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, int):
        return str(v)
    return str(v).strip()


def compact(v):
    return norm(v).replace(' ', '').replace('\u3000', '')


def parse_amount(v):
    if v is None:
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    t = norm(v)
    if not t:
        return None
    neg = False
    if t.startswith('(') and t.endswith(')'):
        neg = True
        t = t[1:-1]
    t = t.replace(',', '').replace('，', '').replace('￥', '').replace('¥', '').replace('元', '').strip()
    try:
        n = float(t)
    except ValueError:
        return None
    return -n if neg else n


def fmt_amount(n):
    if n is None:
        return ''
    if abs(n - round(n)) < 1e-9:
        return str(int(round(n)))
    return ('%.6f' % n).rstrip('0').rstrip('.')


def read_sheet(path):
    low = path.lower()
    if low.endswith('.csv') or low.endswith('.txt'):
        for enc in ('utf-8-sig', 'utf-8', 'gbk'):
            try:
                with open(path, 'r', encoding=enc, newline='') as fh:
                    return [list(r) for r in csv.reader(fh)], 'csv'
            except UnicodeDecodeError:
                continue
        raise RuntimeError('CSV 编码无法识别（试过 utf-8 / gbk）')
    from openpyxl import load_workbook
    wb = load_workbook(path, data_only=True, read_only=True)
    # 优先「科目余额表 / 资产负债表」这类表，都没有就用第一张
    pick = None
    for sn in wb.sheetnames:
        if ('科目' in sn) or ('余额' in sn):
            pick = sn
            break
    if pick is None:
        pick = wb.sheetnames[0]
    ws = wb[pick]
    rows = [list(r) for r in ws.iter_rows(values_only=True)]
    return rows, pick


def find_header(rows):
    best = None
    for ri, cells in enumerate(rows[:30]):
        name_col = None
        for ci, cell in enumerate(cells):
            c = compact(cell)
            if not c:
                continue
            if '编码' in c or '序号' in c:
                continue
            for k in NAME_KEYS:
                if c == k or c.startswith(k):
                    name_col = ci
                    break
            if name_col is not None:
                break
        if name_col is None:
            continue
        amt_col = None
        amt_pri = 0
        for ci, cell in enumerate(cells):
            c = compact(cell)
            if not c or ci == name_col:
                continue
            if any(b in c for b in AMOUNT_BAN):
                continue
            for key, pri in AMOUNT_PRIORITY:
                if key in c and pri > amt_pri:
                    amt_col, amt_pri = ci, pri
                    break
        if amt_col is None:
            continue
        score = amt_pri + (10 if name_col is not None else 0)
        if best is None or score > best[0]:
            best = (score, ri, name_col, amt_col)
    if best is None:
        return None
    return {'row': best[1], 'name': best[2], 'amount': best[3]}


def fallback_header(rows):
    """完全没有表头时：第 1 列当科目名，前 8 列里「像数字最多的那列」当金额。"""
    width = max([len(r) for r in rows[:40]] or [0])
    if width < 2:
        return None
    best_ci, best_hits = None, 0
    for ci in range(1, min(width, 8)):
        hits = 0
        for cells in rows[:40]:
            if ci < len(cells) and parse_amount(cells[ci]) is not None:
                hits += 1
        if hits > best_hits:
            best_ci, best_hits = ci, hits
    if best_ci is None or best_hits < 2:
        return None
    return {'row': -1, 'name': 0, 'amount': best_ci}


def parse_rows(rows, head):
    out = []
    start = head['row'] + 1
    for cells in rows[start:]:
        if head['name'] >= len(cells):
            continue
        name = norm(cells[head['name']])
        if not name:
            continue
        flat = name.replace(' ', '')
        if any(flat.startswith(s) for s in SKIP_NAMES):
            continue
        if flat in ('科目名称', '科目', '项目', '名称'):
            continue
        amount = parse_amount(cells[head['amount']] if head['amount'] < len(cells) else None)
        if amount is None:
            continue
        out.append({'name': name, 'amount': fmt_amount(amount)})
    return out


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'import'
    if mode != 'import':
        print(json.dumps({'ok': False, 'error': '未知模式：' + mode}, ensure_ascii=True))
        return
    if len(sys.argv) < 3:
        print(json.dumps({'ok': False, 'error': '缺少文件路径参数'}, ensure_ascii=True))
        return
    path = sys.argv[2]
    try:
        rows, sheet = read_sheet(path)
        head = find_header(rows)
        if head is None:
            head = fallback_header(rows)
        if head is None:
            print(json.dumps({'ok': False, 'error': '这张表里找不到「科目名称 + 金额/余额」两列，请确认是科目余额表或财务报表'}, ensure_ascii=True))
            return
        data = parse_rows(rows, head)
        if not data:
            print(json.dumps({'ok': False, 'error': '定位到表头，但表头下面没有「有科目名且有金额」的行'}, ensure_ascii=True))
            return
        print(json.dumps({'ok': True, 'rows': data, 'sheet': sheet, 'header': head['row'] + 1}, ensure_ascii=True))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}, ensure_ascii=True))


if __name__ == '__main__':
    main()

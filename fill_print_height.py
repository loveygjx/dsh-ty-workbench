#!/usr/bin/env python3
"""通过增减行让明细/申报表内容正好占满一页打印高度（合计行贴近页底）。

背景：明细格式脚本把 print_area 设到合计行为止，若内容高度 ≠ 可打印高度，
页面底部会留大片空白（或溢出到第二页）。本脚本用 Excel 同款语义的
insert_rows / delete_rows 在合计行前增删空白网格行：

  - 内容不足一页：在合计行前插入 N 行空白边框行（行高/样式复制自相邻空白行），
    并把引用到该表“合计行及以下”的公式（含其他表交叉引用）整体下移 N 行；
    SUM(G6:G25) 这类范围止于合计行上一行，按 Excel 插入语义保持不变（值为 0 差异）。
  - 内容略超一页：删除合计行前的连续空白边框行，公式引用整体上移。
  - print_area 行号随增删同步调整。
  - 只处理明细类 sheet（汇总/设定信息/封面/目录不碰）；单表失败不拖垮整本。
  - fitToWidth=1 时按宽度估算缩放，纵向容量 = 可打印高度 / 缩放 - 缓冲。

用法：
  python fill_print_height.py --workbook <xlsx路径> --kind detail|declare
"""
from __future__ import annotations

import argparse
import os
import re
import sys

A4_PORTRAIT_HEIGHT_POINTS = 841.89
A4_PORTRAIT_WIDTH_POINTS = 595.276
PAPER_BY_ORIENTATION = {"landscape": A4_PORTRAIT_WIDTH_POINTS, "portrait": A4_PORTRAIT_HEIGHT_POINTS}
PX_PER_CHAR = 7.0
PX_BASE_PER_COL = 5.0
PT_PER_PX = 72.0 / 96.0
SAFETY_BUFFER_PT = 4.0
MIN_ADJUST_PT = 3.0

FIELD_MARKER = re.compile(r"^(index|field\d+|bookSumValue|evaluateSumValue|difference|growRate)$", re.I)
SUMMARY_MARKERS = ("汇总", "设定信息", "封面", "目录")

# 交叉引用：'Sheet Name'!$A$26 / Sheet1!A1:B2（含范围第二端点）
XREF = re.compile(
    r"(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!"
    r"(\$?[A-Za-z]{1,3})\$?(\d+)"
    r"(?::(\$?[A-Za-z]{1,3})\$?(\d+))?"
)
# 本表引用：A26 / $A$26 / A6:A25；排除函数名 LOG10( 与 1E5 之类
LOCAL = re.compile(r"(?<![A-Za-z0-9_!$'\":])(\$?[A-Za-z]{1,3})\$?(\d+)(?![A-Za-z0-9_]*\()")


def is_detail_sheet(title: str) -> bool:
    t = (title or "").strip()
    if not t:
        return False
    return not any(m in t for m in SUMMARY_MARKERS)


def cell_meaningful(value) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        text = value.strip()
        if not text or text.startswith("="):
            return False
        if FIELD_MARKER.match(re.sub(r"\s+", "", text)):
            return False
        return True
    return True


def cell_has_border(cell) -> bool:
    b = cell.border
    return any(getattr(side, "style", None) for side in (b.left, b.right, b.top, b.bottom))


def norm_title(t: str) -> str:
    return t.strip().strip("'").replace("''", "'")


def print_bounds(ws):
    from openpyxl.utils import range_boundaries

    if ws.print_area:
        ref = str(ws.print_area).split("!")[-1].replace("'", "").replace("$", "")
        min_col, min_row, max_col, max_row = range_boundaries(ref)
        return min_row, max_row, min_col, max_col
    return 1, ws.max_row, 1, ws.max_column


def content_width_points(ws, min_col, max_col) -> float:
    from openpyxl.utils import get_column_letter

    total_px = 0.0
    for col in range(min_col, max_col + 1):
        if ws.column_dimensions[get_column_letter(col)].hidden:
            continue
        w = ws.column_dimensions[get_column_letter(col)].width or 8.43
        total_px += round(w * PX_PER_CHAR) + PX_BASE_PER_COL
    return total_px * PT_PER_PX


def estimate_scale(ws, min_col, max_col) -> float:
    from openpyxl.utils import get_column_letter

    if ws.page_setup.fitToWidth:
        paper_w = A4_PORTRAIT_HEIGHT_POINTS  # 横向时宽是纸的长边
        printable_w = paper_w - (ws.page_margins.left + ws.page_margins.right) * 72
        content_w = content_width_points(ws, min_col, max_col)
        if content_w > 0:
            return min(1.0, printable_w / content_w)
    scale = ws.page_setup.scale
    if scale:
        return min(1.0, float(scale) / 100.0)
    return 1.0


def visible_row_height(ws, row) -> float:
    if ws.row_dimensions[row].hidden:
        return 0.0
    return ws.row_dimensions[row].height or ws.sheet_format.defaultRowHeight or 15.0


def col_name_valid(col: str) -> bool:
    """列名必须 ≤ XFD，避免把 LOG10 之类函数名当单元格。"""
    c = col.strip("$").upper()
    if not c or len(c) > 3:
        return False
    limit = "XFD"
    return c <= limit


def shift_formula(formula: str, target_sheet: str, local_sheet: str, threshold: int, delta: int) -> str:
    """把引用 target_sheet 行号 >= threshold 的引用平移 delta 行。

    delta<0 表示删行：删行区间内的引用钳到 threshold-1（近似 Excel #REF! 语义，
    空白行几乎不会被引用）。
    """

    def shift_row(row: int) -> int | None:
        if row >= threshold:
            return row + delta if delta > 0 else max(row + delta, threshold - 1)
        return row  # 行号在阈值之前：不动（Excel 插入/删除行时其上方引用保持）

    def xref_repl(m: re.Match) -> str:
        name = norm_title(m.group(1) or m.group(2))
        if name != target_sheet:
            return m.group(0)
        r1 = int(m.group(4))
        nr = shift_row(r1)
        r2 = int(m.group(6)) if m.group(5) else None
        nr2 = shift_row(r2) if r2 is not None else None
        if nr is None or (r2 is not None and nr2 is None):
            return m.group(0)
        out = [m.group(0)[: m.start(4) - m.start(0)], str(nr)]
        if m.group(5):
            out.append(":" + m.group(5) + str(nr2))
        return "".join(out)

    def local_repl(m: re.Match) -> str:
        col = m.group(1)
        if not col_name_valid(col):
            return m.group(0)
        r = int(m.group(2))
        nr = shift_row(r)
        if nr is None:
            return m.group(0)
        return col + str(nr)

    text = XREF.sub(xref_repl, formula)
    if local_sheet == target_sheet:
        text = LOCAL.sub(local_repl, text)
    return text


def shift_workbook_formulas(wb, target_sheet: str, threshold: int, delta: int) -> int:
    n = 0
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                v = cell.value
                if isinstance(v, str) and v.startswith("="):
                    nv = shift_formula(v, target_sheet, ws.title, threshold, delta)
                    if nv != v:
                        cell.value = nv
                        n += 1
    return n


def copy_row_style(src_ws, src_row, dst_ws, dst_row, max_col) -> None:
    from copy import copy

    for col in range(1, max_col + 1):
        s = src_ws.cell(src_row, col)
        d = dst_ws.cell(dst_row, col)
        if s.has_style:
            d._style = copy(s._style)
    dst_ws.row_dimensions[dst_row].height = src_ws.row_dimensions[src_row].height


def find_total_row(ws, min_row, max_row, max_col) -> int | None:
    """合计行 = 打印区域内最后一个有内容行，且 A 列规范化后含“合计”。"""
    for r in range(max_row, min_row - 1, -1):
        vals = [ws.cell(r, c).value for c in range(1, max_col + 1)]
        if not any(cell_meaningful(v) for v in vals):
            continue
        a = re.sub(r"\s+", "", str(ws.cell(r, 1).value or ""))
        if "合计" in a:
            return r
        return None  # 最后内容行不是合计行，不动
    return None


def row_blank_bordered(ws, row, max_col) -> bool:
    has_border = False
    for col in range(1, max_col + 1):
        cell = ws.cell(row, col)
        if cell_meaningful(cell.value):
            return False
        if cell_has_border(cell):
            has_border = True
    return has_border


def adjust_print_area(ws, old_total: int, delta: int) -> None:
    """把 print_area 末行对齐到新的合计行位置（old_total + delta），消除模板尾随空行。"""
    if not ws.print_area:
        return
    from openpyxl.utils import range_boundaries, get_column_letter

    try:
        mc, mr, xc, xr = range_boundaries(str(ws.print_area).replace("$", "").split("!")[-1])
    except Exception:
        return
    sheet_name = ws.title
    ws.print_area = f"'{sheet_name}'!${get_column_letter(mc)}${mr}:${get_column_letter(xc)}${old_total + delta}"


def fill_sheet(ws) -> dict:
    from openpyxl.utils import get_column_letter

    min_row, max_row, min_col, max_col = print_bounds(ws)
    orientation = "landscape" if ws.page_setup.orientation == "landscape" else "portrait"
    paper_h = PAPER_BY_ORIENTATION[orientation]
    printable_h = paper_h - (ws.page_margins.top + ws.page_margins.bottom) * 72
    scale = estimate_scale(ws, min_col, max_col)
    capacity = printable_h / scale - SAFETY_BUFFER_PT

    content_h = sum(visible_row_height(ws, r) for r in range(min_row, max_row + 1))
    gap = capacity - content_h
    if abs(gap) < MIN_ADJUST_PT:
        return {"changed": False, "reason": "no-gap", "gap": round(gap, 1)}

    total_row = find_total_row(ws, min_row, max_row, max_col)
    if total_row is None or total_row <= min_row + 1:
        return {"changed": False, "reason": "no-total-row"}

    row_h = ws.row_dimensions[total_row - 1].height or ws.sheet_format.defaultRowHeight or 15.0
    if row_h <= 0:
        return {"changed": False, "reason": "bad-template-row"}

    title = ws.title
    if gap > 0:
        n = int(gap // row_h)
        remainder = round(gap - n * row_h, 2)
        if n <= 0:
            # 差值不足一整行：把余量加到合计行前一空白行行高（仍属行高微调，整行数不变）
            return {"changed": False, "reason": "less-than-one-row", "gap": round(gap, 1)}
        ws.insert_rows(total_row, n)
        for i in range(n):
            copy_row_style(ws, total_row - 1, ws, total_row + i, max_col)
        if remainder > 1.0:
            last = total_row + n - 1
            ws.row_dimensions[last].height = round((ws.row_dimensions[last].height or row_h) + remainder, 2)
        shift_workbook_formulas(ws.parent, title, total_row, n)
        adjust_print_area(ws, total_row, n)
        return {"changed": True, "op": "insert", "rows": n, "at": total_row, "gap": round(gap, 1)}

    # 内容超页：删除合计行前的连续空白行
    n = int((-gap) // row_h)
    if n <= 0:
        return {"changed": False, "reason": "less-than-one-row", "gap": round(gap, 1)}
    # 找合计行前连续空白行（从 total_row-1 往上）
    s = total_row - 1
    avail = 0
    while s - avail >= min_row + 1 and row_blank_bordered(ws, s - avail, max_col):
        avail += 1
    n = min(n, avail)
    if n <= 0:
        return {"changed": False, "reason": "no-blank-rows"}
    start = total_row - n
    ws.delete_rows(start, n)
    shift_workbook_formulas(ws.parent, title, start + n, -n)
    adjust_print_area(ws, start + n, -n)
    return {"changed": True, "op": "delete", "rows": n, "at": start, "gap": round(gap, 1)}


def fill_workbook(path: str, kind: str) -> dict:
    raise RuntimeError('自动增删行已暂停：原算法可能破坏合并区域或公式，等待安全验证。')
    if kind not in ("detail", "declare"):
        raise SystemExit("kind 必须是 detail 或 declare")
    from openpyxl import load_workbook

    wb = load_workbook(path)
    results = {}
    for ws in wb.worksheets:
        if not is_detail_sheet(ws.title):
            continue
        try:
            results[ws.title] = fill_sheet(ws)
        except Exception as exc:
            results[ws.title] = {"changed": False, "reason": f"error: {exc}"}
    changed = [t for t, r in results.items() if r.get("changed")]
    if changed:
        wb.save(path)
    return {"ok": True, "changed": changed, "detail": results}


def main() -> None:
    print('自动增删行已暂停：原算法可能破坏合并区域或公式，等待安全验证。', file=sys.stderr)
    raise SystemExit(2)
    ap = argparse.ArgumentParser()
    ap.add_argument("--workbook", required=True)
    ap.add_argument("--kind", required=True, choices=["detail", "declare"])
    args = ap.parse_args()
    if not os.path.isfile(args.workbook):
        print("工作簿不存在：" + args.workbook, file=sys.stderr)
        raise SystemExit(2)
    result = fill_workbook(args.workbook, args.kind)
    if result["changed"]:
        print("已增删行填满页面：" + ",".join(result["changed"]))
    else:
        reasons = {}
        for t, r in result["detail"].items():
            reasons.setdefault(r.get("reason", "?"), 0)
            reasons[r.get("reason", "?")] += 1
        print("无 sheet 需要增删行：" + ", ".join(f"{k}×{v}" for k, v in reasons.items()))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 docx 正文（body 直接子段落）的西文字体统一，让数字不再走 Times New Roman / Calibri。

只处理 body 的直接子 w:p，**完全不碰 w:tbl 里的任何 run**，也不碰页眉页脚与标题段落（Heading1..4）。
判断依据与取舍见 README 段落：天源导出的正文里，数字字形不一致有三个来源——
  1) run 显式写成了 Calibri（整段中文+数字都被标成 Calibri）；
  2) run 只写了 w:eastAsia 没写 w:ascii，数字回落到 docDefaults 的 Times New Roman；
  3) run 完全没有 w:rFonts，同上。
本脚本把 ascii/hAnsi 写成目标字体，并在 eastAsia 明显被西文字体占用时一并改回目标中文字体。

用法：
  python3 normalize_body_fonts.py <文件.docx>
环境变量：
  TIANYUAN_BODY_FONT_CONFIG  {"asciiFont":"宋体","eastAsiaFont":"宋体"}
输出（JSON Lines）：
  {"event":"normalized", "runs":N, "paragraphs":M, "skippedParagraphs":K}
  {"event":"saved", "path":..., "runs":N, "paragraphs":M}
  {"event":"failed", "reason":...}
"""

import json
import os
import sys

from docx import Document
from docx.oxml.ns import qn

# 明确属于西文字体、不该拿来渲染中文的字体名；命中就改回目标中文字体。
LATIN_ONLY_FONTS = {
    "calibri",
    "cambria",
    "cambria math",
    "arial",
    "times new roman",
    "verdana",
    "tahoma",
    "segoe ui",
    "georgia",
    "courier new",
}

# 标题类段落一律不动：它们用黑体，改了会破坏层级观感。
HEADING_STYLE_PREFIX = "heading"


def emit(**payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_rules():
    raw = os.environ.get("TIANYUAN_BODY_FONT_CONFIG")
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _style_id(paragraph):
    ppr = paragraph.find(qn("w:pPr"))
    if ppr is None:
        return None
    style = ppr.find(qn("w:pStyle"))
    if style is None:
        return None
    return style.get(qn("w:val"))


def _is_heading(paragraph):
    style_id = _style_id(paragraph)
    if not style_id:
        return False
    return style_id.strip().lower().startswith(HEADING_STYLE_PREFIX)


def _rpr_of(run):
    rpr = run.find(qn("w:rPr"))
    if rpr is None:
        rpr = run.makeelement(qn("w:rPr"), {})
        run.insert(0, rpr)
    return rpr


def _rfonts_of(run):
    rpr = _rpr_of(run)
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = rpr.makeelement(qn("w:rFonts"), {})
        # rFonts 是 rPr 序列里的第一个元素，必须插到最前
        rpr.insert(0, rfonts)
    return rfonts


def target_ascii_font(rfonts, ascii_font, east_asia_font):
    """决定这个 run 的西文字体该写什么。

    规则：跟随该 run 自己声明的中文字体。封面、声明页这些用黑体的段落，数字也应该是黑体；
    只有中文字体缺失、或被发现是纯西文字体（Calibri / Times New Roman 等）时，才落到默认的宋体。
    """
    east_asia = (rfonts.get(qn("w:eastAsia")) or "").strip()
    if east_asia and east_asia.lower() not in LATIN_ONLY_FONTS:
        return east_asia
    return ascii_font


def normalize_run(run, ascii_font, east_asia_font):
    """返回 1 表示改写了一个 run，0 表示无需改动。"""
    rfonts = _rfonts_of(run)
    changed = False

    # 先把被西文字体占用的 eastAsia 收回中文，再由它决定 ascii/hAnsi
    east_asia = (rfonts.get(qn("w:eastAsia")) or "").strip()
    if east_asia_font and east_asia and east_asia.lower() in LATIN_ONLY_FONTS:
        rfonts.set(qn("w:eastAsia"), east_asia_font)
        changed = True

    ascii_target = target_ascii_font(rfonts, ascii_font, east_asia_font)
    for attr in ("w:ascii", "w:hAnsi"):
        current = rfonts.get(qn(attr))
        if current != ascii_target:
            rfonts.set(qn(attr), ascii_target)
            changed = True

    return 1 if changed else 0


def normalize_document(document, ascii_font, east_asia_font):
    body = document.element.body
    runs = 0
    paragraphs = 0
    skipped = 0

    for node in body:
        if node.tag != qn("w:p"):
            continue  # w:tbl、w:sectPr 等全部跳过
        if _is_heading(node):
            skipped += 1
            continue
        touched = 0
        for run in node.iter(qn("w:r")):
            touched += normalize_run(run, ascii_font, east_asia_font)
        if touched:
            runs += touched
            paragraphs += 1

    return runs, paragraphs, skipped


def main(argv):
    if len(argv) < 2:
        emit(event="failed", reason="缺少 docx 路径参数")
        return 2
    path = argv[1]
    rules = load_rules()
    ascii_font = (rules.get("asciiFont") or "宋体").strip() or "宋体"
    east_asia_font = (rules.get("eastAsiaFont") or ascii_font).strip()

    try:
        document = Document(path)
    except Exception as exc:  # noqa: BLE001 - 原样上报，不猜原因
        emit(event="failed", reason="打开 docx 失败：%s" % exc)
        return 1

    try:
        runs, paragraphs, skipped = normalize_document(document, ascii_font, east_asia_font)
    except Exception as exc:  # noqa: BLE001
        emit(event="failed", reason="处理正文失败：%s" % exc)
        return 1

    emit(event="normalized", runs=runs, paragraphs=paragraphs,
         skippedParagraphs=skipped, asciiFont=ascii_font)

    # 没有任何改动就不保存：保持文件字节不变，重复执行天然幂等
    if not runs:
        emit(event="saved", path=path, runs=0, paragraphs=0, changed=False)
        return 0

    try:
        document.save(path)
    except Exception as exc:  # noqa: BLE001
        emit(event="failed", reason="保存 docx 失败：%s" % exc)
        return 1

    emit(event="saved", path=path, runs=runs, paragraphs=paragraphs, changed=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

#!/usr/bin/env python3
"""按公司写入导出工作簿页脚（明细表：填表人/填表日期/评估人员；申报表：填表人/填表日期）。

用法：
  python footer_workbook.py --workbook <xlsx路径> --kind detail|declare \
      --preparer "张三" --date "2026-11-24" --appraisers "张三、李四"

规则（与真实明细表样例一致）：
  - 汇总表/分类汇总/设定信息等非明细 sheet 不写。
  - 明细 sheet：oddFooter.left 已有“填表人/填表日期”模板 → 在其后补值；
    right 已有“评估人员”模板 → 补值（仅 detail）。
  - 申报表：format 脚本已清 right 的评估人员模板，这里只写填表人/填表日期；
    oddFooter.left 无模板时新建。
  - preserve：只替换“：”后的值部分，不动模板文字；模板缺失才整段写入。
"""
import argparse
import os
import sys

SUMMARY_MARKERS = ("汇总", "设定信息", "封面", "目录")
# “评估人员/填表人”等标签出现即可视为明细 sheet 的页脚模板。
LABELS = ("填表人", "填表日期", "评估人员")


def is_detail_sheet(title: str) -> bool:
    t = (title or "").strip()
    if not t:
        return False
    if any(m in t for m in SUMMARY_MARKERS):
        return False
    # 明细 sheet 形如 “3-1-2银行存款”、“固定资产-房屋”；无“汇总”字样且带编号或类别名。
    return True


def append_value(template: str, label: str, value: str) -> str:
    """在含 label 的页脚文本里，把 label 后面的值补上；不动已有值（导出重跑会重写文件，覆盖是预期行为）。"""
    if value is None or value == "":
        return template or ""
    text = template if template is not None else ""
    if label not in text:
        return (text + ("" if text.endswith("\n") or not text else "\n") + label + "：" + value) if text else (label + "：" + value)
    # 已含 label：只替换该行 label 之后冒号后面的旧值，保留模板前缀（如“被评估单位填表人：”）。
    lines = text.split("\n")
    out = []
    for line in lines:
        idx = line.find(label)
        if idx >= 0:
            after = idx + len(label)
            colon = -1
            for ch_i in range(after, len(line)):
                if line[ch_i] in "：:":
                    colon = ch_i
                    break
            if colon >= 0:
                out.append(line[: colon + 1] + value)
            else:
                out.append(line + "：" + value)
        else:
            out.append(line)
    return "\n".join(out)


def write_footer(path: str, kind: str, preparer: str, date: str, appraisers: str) -> dict:
    from openpyxl import load_workbook  # 局部 import：没有 openpyxl 时报错更清晰

    if kind not in ("detail", "declare"):
        raise SystemExit("kind 必须是 detail 或 declare")
    wb = load_workbook(path)
    touched = []
    for ws in wb.worksheets:
        if not is_detail_sheet(ws.title):
            continue
        f = ws.oddFooter
        left = f.left.text or ""
        right = f.right.text or ""
        new_left = append_value(left, "填表人", preparer)
        new_left = append_value(new_left, "填表日期", date)
        if new_left != left:
            f.left.text = new_left
        if kind == "detail":
            if appraisers:
                new_right = append_value(right, "评估人员", appraisers)
                if new_right != right:
                    f.right.text = new_right
        elif "评估人员" in right:
            # 申报表不应带评估人员：残留模板/旧值一并清掉（与申报格式脚本行为一致）。
            f.right.text = right.replace("评估人员", "").replace("：", "", 1).strip()
            if not f.right.text:
                f.right.text = None
        touched.append(ws.title)
    if touched:
        wb.save(path)
    return {"ok": True, "sheets": touched}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workbook", required=True)
    ap.add_argument("--kind", required=True, choices=["detail", "declare"])
    ap.add_argument("--preparer", default="")
    ap.add_argument("--date", default="")
    ap.add_argument("--appraisers", default="")
    args = ap.parse_args()
    if not os.path.isfile(args.workbook):
        print("工作簿不存在：" + args.workbook, file=sys.stderr)
        raise SystemExit(2)
    result = write_footer(args.workbook, args.kind, args.preparer, args.date, args.appraisers)
    print(result["sheets"] and "已写入 " + ",".join(result["sheets"]) or "未找到明细 sheet，未写入")


if __name__ == "__main__":
    main()

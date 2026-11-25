# footer_workbook.py 单元测试（node --test 不适用 python，用 python -m unittest 也可；
# 仓库无 python 测试先例，这里直接用 python 内置断言写成可独立运行的脚本）。
# 运行：python3 footer_workbook_test.py
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from openpyxl import Workbook, load_workbook

import footer_workbook as fw


def make_wb(title, left=None, right=None):
    wb = Workbook()
    ws = wb.active
    ws.title = title
    if left is not None:
        ws.oddFooter.left.text = left
    if right is not None:
        ws.oddFooter.right.text = right
    fd, path = tempfile.mkstemp(suffix='.xlsx')
    os.close(fd)
    wb.save(path)
    return path


class AppendValueTest(unittest.TestCase):
    def test_preserves_prefix(self):
        self.assertEqual(
            fw.append_value('被评估单位填表人：', '填表人', '张三'),
            '被评估单位填表人：张三',
        )

    def test_replaces_old_value(self):
        self.assertEqual(
            fw.append_value('填表人：旧值', '填表人', '新值'),
            '填表人：新值',
        )

    def test_appends_missing_label(self):
        self.assertEqual(
            fw.append_value('填表人：张三', '填表日期', '2026-11-24'),
            '填表人：张三\n填表日期：2026-11-24',
        )

    def test_empty_value_keeps_template(self):
        self.assertEqual(fw.append_value('填表人：', '填表人', ''), '填表人：')


class WriteFooterTest(unittest.TestCase):
    def test_detail_template_preserved(self):
        path = make_wb('3-1-2银行存款', '被评估单位填表人：\n填表日期: ', '评估人员：')
        try:
            fw.write_footer(path, 'detail', '张三', '2026-11-24', '张三、李四')
            ws = load_workbook(path)['3-1-2银行存款']
            self.assertEqual(ws.oddFooter.left.text, '被评估单位填表人：张三\n填表日期:2026-11-24')
            self.assertEqual(ws.oddFooter.right.text, '评估人员：张三、李四')
        finally:
            os.remove(path)

    def test_summary_sheet_untouched(self):
        path = make_wb('1-汇总表')
        try:
            fw.write_footer(path, 'detail', '张三', '2026-11-24', '张三')
            ws = load_workbook(path)['1-汇总表']
            self.assertIsNone(ws.oddFooter.left.text)
            self.assertIsNone(ws.oddFooter.right.text)
        finally:
            os.remove(path)

    def test_declare_no_appraisers(self):
        path = make_wb('固定资产')
        try:
            fw.write_footer(path, 'declare', '李四', '2026-11-24', '应被忽略')
            ws = load_workbook(path)['固定资产']
            self.assertEqual(ws.oddFooter.left.text, '填表人：李四\n填表日期：2026-11-24')
            self.assertIsNone(ws.oddFooter.right.text)
        finally:
            os.remove(path)

    def test_declare_clears_existing_appraisers_right(self):
        # 申报脚本已清 right 模板；若历史上残留评估人员，申报写入不应带上。
        path = make_wb('3-2-1存货', None, '评估人员：旧名单')
        try:
            fw.write_footer(path, 'declare', '李四', '2026-11-24', '')
            ws = load_workbook(path)['3-2-1存货']
            self.assertNotIn('评估人员', ws.oddFooter.right.text or '')
        finally:
            os.remove(path)

    def test_detail_no_appraisers_keeps_right(self):
        path = make_wb('3-1-1现金', '填表人：', '评估人员：')
        try:
            fw.write_footer(path, 'detail', '张三', '2026-11-24', '')
            ws = load_workbook(path)['3-1-1现金']
            self.assertEqual(ws.oddFooter.right.text, '评估人员：')
        finally:
            os.remove(path)


if __name__ == '__main__':
    unittest.main(verbosity=2)

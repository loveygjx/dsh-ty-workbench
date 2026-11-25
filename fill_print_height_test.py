#!/usr/bin/env python3
"""fill_print_height 增删行 + 公式平移的单元测试（合成数据，不依赖真实项目）。"""
import sys, os, unittest, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from openpyxl import Workbook
from fill_print_height import shift_workbook_formulas, shift_formula


class ShiftFormulaTests(unittest.TestCase):
    def test_xref_single_point_down(self):
        self.assertEqual(shift_formula("='S1'!G26", "S1", "S2", 26, 2), "='S1'!G28")

    def test_xref_range_both_endpoints(self):
        self.assertEqual(shift_formula("=SUM('S1'!G6:G26)", "S1", "S2", 26, 2), "=SUM('S1'!G6:G28)")

    def test_xref_range_before_threshold(self):
        self.assertEqual(shift_formula("=SUM('S1'!G6:G25)", "S1", "S2", 26, 2), "=SUM('S1'!G6:G25)")

    def test_xref_mixed_range(self):
        self.assertEqual(shift_formula("=SUM('S1'!G25:G26)", "S1", "S2", 26, 2), "=SUM('S1'!G25:G28)")

    def test_other_sheet_untouched(self):
        self.assertEqual(shift_formula("='S9'!G26", "S1", "S2", 26, 2), "='S9'!G26")

    def test_function_names_untouched(self):
        self.assertEqual(shift_formula("=LOG10(100)+SUM('S1'!G26)", "S1", "S2", 26, 2), "=LOG10(100)+SUM('S1'!G28)")

    def test_local_refs_down(self):
        self.assertEqual(shift_formula("=G26+A26", "S1", "S1", 26, 2), "=G28+A28")

    def test_local_range_before_threshold(self):
        self.assertEqual(shift_formula("=SUM(G6:G25)", "S1", "S1", 26, 2), "=SUM(G6:G25)")

    def test_delete_clamps(self):
        self.assertEqual(shift_formula("='S1'!G28", "S1", "S2", 26, -2), "='S1'!G26")

    def test_delete_above_untouched(self):
        self.assertEqual(shift_formula("='S1'!G25", "S1", "S2", 26, -2), "='S1'!G25")


class ShiftWorkbookTests(unittest.TestCase):
    def _wb(self):
        wb = Workbook()
        a = wb.active; a.title = "S1"
        b = wb.create_sheet("S2")
        return wb, a, b

    def test_cross_sheet_move(self):
        wb, a, b = self._wb()
        b["A1"] = "='S1'!G26"
        b["A2"] = "=SUM('S1'!G6:G26)"
        n = shift_workbook_formulas(wb, "S1", 26, 2)
        self.assertEqual(n, 2)
        self.assertEqual(b["A1"].value, "='S1'!G28")
        self.assertEqual(b["A2"].value, "=SUM('S1'!G6:G28)")

    def test_local_sheet_move(self):
        wb, a, b = self._wb()
        a["B1"] = "=G26"
        a["B2"] = "=SUM(G6:G25)"
        n = shift_workbook_formulas(wb, "S1", 26, 2)
        self.assertEqual(n, 1)
        self.assertEqual(a["B1"].value, "=G28")
        self.assertEqual(a["B2"].value, "=SUM(G6:G25)")


class FillSheetTests(unittest.TestCase):
    """用最小可打印高度场景测增行：横向、大容量。"""

    def _sheet(self):
        from openpyxl.worksheet.properties import PageSetupProperties
        wb = Workbook()
        ws = wb.active
        ws.title = "3-1-2测试"
        ws.print_area = "A1:K10"
        ws.page_setup.orientation = "landscape"
        ws.page_setup.paperSize = 9
        ws.page_setup.fitToWidth = 1
        ws.page_setup.fitToHeight = 0
        ws.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)
        ws.page_margins.left = ws.page_margins.right = 0.45
        ws.page_margins.top = 0.3
        ws.page_margins.bottom = 0.6
        # 宽度超页 → scale < 1
        # 标题1 + 表头4 + 明细5..8（空白带边框）+ 合计9
        from openpyxl.styles import Border, Side
        thin = Side(style="thin")
        border = Border(left=thin, right=thin, top=thin, bottom=thin)
        ws["A1"] = "测试明细表"
        for c in range(1, 12):
            ws.cell(4, c).value = "头"
            ws.cell(9, c).border = border
        ws.cell(9, 1).value = "合 计"
        ws.cell(9, 7).value = "=ROUND(SUM(G6:G8),2)"
        for r in range(5, 9):
            for c in range(1, 12):
                ws.cell(r, c).border = border
            ws.row_dimensions[r].height = 16.5
        for r in range(1, 10):
            ws.row_dimensions[r].height = ws.row_dimensions[r].height or 15
        return wb, ws

    def test_insert_rows_fills_page(self):
        from fill_print_height import fill_sheet
        wb, ws = self._sheet()
        res = fill_sheet(ws)
        self.assertTrue(res.get("changed"), res)
        self.assertEqual(res["op"], "insert")
        # print_area 末行增加
        end = int(str(ws.print_area).replace("$", "").split(":")[1][1:])
        self.assertEqual(end, 9 + res["rows"])
        # 合计行落在 print_area 末行
        self.assertIn("合", str(ws.cell(end, 1).value))
        # SUM 范围保持
        self.assertIn("SUM(G6:G8)", str(ws.cell(end, 7).value))

    def test_workbook_entry_rejects_without_modifying_file(self):
        from fill_print_height import fill_workbook
        import tempfile
        wb, ws = self._sheet()
        ws.title = "汇总"
        with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as fh:
            path = fh.name
        wb.save(path)
        try:
            with open(path, 'rb') as f:
                before = f.read()
            with self.assertRaisesRegex(RuntimeError, '自动增删行已暂停'):
                fill_workbook(path, "detail")
            with open(path, 'rb') as f:
                self.assertEqual(f.read(), before)
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main(verbosity=1)

"""uno_row_apply: openpyxl preserves styles; LibreOffice UNO bridge output is
the semantic ground truth for formulas / merges / print area. All tests use
synthetic workbooks only; the real sample is never written."""
import unittest

from openpyxl import Workbook, load_workbook
from uno_row_apply import apply_operation


def synthetic_book():
    """Two sheets: target with header/data/total + untouched summary sheet."""
    wb = Workbook()
    ws = wb.active
    ws.title = 'Target'
    ws.merge_cells('A1:C1')
    ws['A1'] = '表头'
    ws['A2'], ws['B2'], ws['C2'] = '名称', '数量', '单价'
    ws['A3'], ws['B3'], ws['C3'] = '甲', 2, 3.5
    ws['A4'], ws['B4'], ws['C4'] = '乙', 1, 10.0
    ws.merge_cells('A5:B5')
    ws['A5'] = '合计'
    ws['C5'] = '=ROUND(SUM(C3:C4),2)'
    # B5 在合并区内不可写；总量公式放 C5，B5 公式省略（合成模板不用 B 列合计）。
    ws.print_area = 'A1:C5'
    s2 = wb.create_sheet('Summary')
    s2['A1'] = '=Target!C5'
    return wb


class ApplyOperationTests(unittest.TestCase):
    def setUp(self):
        import tempfile, os
        fd, self.src = tempfile.mkstemp(suffix='.xlsx'); os.close(fd)
        fd, self.lo = tempfile.mkstemp(suffix='.xlsx'); os.close(fd)
        fd, self.out = tempfile.mkstemp(suffix='.xlsx'); os.close(fd)
        synthetic_book().save(self.src)
        synthetic_book().save(self.lo)  # bridge output: same layout already shifted
        from openpyxl import load_workbook
        # fabricate bridge output as if a row was inserted before the total (row 5)
        wb = load_workbook(self.lo)
        ws = wb['Target']
        ws.insert_rows(5)
        ws['C6'] = '=ROUND(SUM(C3:C4),2)'
        ws.merge_cells('A6:B6')
        ws.print_area = 'A1:C6'
        wb.save(self.lo)

    def tearDown(self):
        import os
        for p in (self.src, self.lo, self.out):
            if os.path.exists(p):
                os.unlink(p)

    def test_insert_matches_bridge_semantics(self):
        result = apply_operation(self.src, self.lo, self.out, 'Target', 'insert', 5, 1)
        self.assertTrue(result['ok'])
        out = load_workbook(self.out)
        ws = out['Target']
        self.assertEqual(ws['C6'].value, '=ROUND(SUM(C3:C4),2)')
        self.assertEqual(ws['C6'].value, '=ROUND(SUM(C3:C4),2)')
        self.assertEqual(str(ws.print_area), "'Target'!$A$1:$C$6")
        self.assertIn('A6:B6', {str(m) for m in ws.merged_cells.ranges})

    def test_untouched_sheets_unchanged(self):
        apply_operation(self.src, self.lo, self.out, 'Target', 'insert', 5, 1)
        src, out = load_workbook(self.src), load_workbook(self.out)
        self.assertEqual(out['Summary']['A1'].value, '=Target!C5')
        self.assertEqual(out.sheetnames, src.sheetnames)

    def test_font_preserved_on_untouched_cells(self):
        apply_operation(self.src, self.lo, self.out, 'Target', 'insert', 5, 1)
        src, out = load_workbook(self.src), load_workbook(self.out)
        for r in range(1, 5):
            self.assertEqual(out['Target'].cell(r, 1).font.name,
                             src['Target'].cell(r, 1).font.name)

    def test_diverged_bridge_rejected(self):
        from openpyxl import load_workbook
        wb = load_workbook(self.lo)
        wb['Summary']['A1'] = 999  # diverge on untouched sheet
        diverged = self.lo + '.div.xlsx'
        wb.save(diverged)
        try:
            with self.assertRaises(SystemExit):
                apply_operation(self.src, diverged, self.out, 'Target', 'insert', 5, 1)
        finally:
            import os
            os.unlink(diverged)

    def test_inserted_row_has_copied_style_and_height(self):
        from openpyxl import load_workbook
        from copy import copy
        # give row 4 a distinctive style before inserting at 5
        wb = load_workbook(self.src)
        ws = wb['Target']
        from openpyxl.styles import Font, Border, Side
        line = Side(style='thin')
        ws.cell(4, 1).font = Font(name='黑体', size=9)
        ws.cell(4, 1).border = Border(left=line)
        ws.row_dimensions[4].height = 21.0
        wb.save(self.src)
        apply_operation(self.src, self.lo, self.out, 'Target', 'insert', 5, 1)
        out = load_workbook(self.out)
        ws = out['Target']
        self.assertEqual(ws.cell(5, 1).font.name, '黑体')
        self.assertEqual(ws.cell(5, 1).border.left.style, 'thin')
        self.assertEqual(ws.row_dimensions[5].height, 21.0)


class BatchApplyTests(unittest.TestCase):
    """apply_operations: two sheets, one bridge call, one reconcile pass."""

    def setUp(self):
        import tempfile, os
        wb = Workbook()
        for name in ('T1', 'T2'):
            ws = wb.create_sheet(name)
            ws['A1'], ws['B1'] = '名称', '数量'
            ws['A2'], ws['B2'] = '甲', 1
            ws['A3'], ws['B3'] = '合计', '=SUM(B2:B2)'
            ws.print_area = f'A1:B3'
        del wb['Sheet']
        fd, self.src = tempfile.mkstemp(suffix='.xlsx'); os.close(fd)
        fd, self.lo = tempfile.mkstemp(suffix='.xlsx'); os.close(fd)
        fd, self.out = tempfile.mkstemp(suffix='.xlsx'); os.close(fd)
        wb.save(self.src)
        from openpyxl import load_workbook
        wb2 = load_workbook(self.src)
        for name, row in (('T1', 3), ('T2', 3)):
            wb2[name].insert_rows(row, 2)
            wb2[name]['B5'] = '=SUM(B2:B2)'
            wb2[name].print_area = 'A1:B5'
        wb2.save(self.lo)

    def tearDown(self):
        import os
        for p in (self.src, self.lo, self.out):
            if os.path.exists(p):
                os.unlink(p)

    def test_two_sheets_one_pass(self):
        from uno_row_apply import apply_operations
        result = apply_operations(self.src, self.lo, self.out, [
            {'sheet': 'T1', 'operation': 'insert', 'row': 3, 'count': 2},
            {'sheet': 'T2', 'operation': 'insert', 'row': 3, 'count': 2},
        ])
        self.assertTrue(result['ok'])
        self.assertEqual(result['sheets'], ['T1', 'T2'])
        out = load_workbook(self.out)
        for name in ('T1', 'T2'):
            self.assertEqual(out[name]['B5'].value, '=SUM(B2:B2)')
            self.assertEqual(str(out[name].print_area), f"'{name}'!$A$1:$B$5")
            self.assertEqual(out[name]['A2'].value, '甲')

    def test_duplicate_sheet_rejected(self):
        from uno_row_apply import apply_operations
        with self.assertRaises(SystemExit):
            apply_operations(self.src, self.lo, self.out, [
                {'sheet': 'T1', 'operation': 'insert', 'row': 3, 'count': 1},
                {'sheet': 'T1', 'operation': 'insert', 'row': 4, 'count': 1},
            ])


if __name__ == '__main__':
    unittest.main()

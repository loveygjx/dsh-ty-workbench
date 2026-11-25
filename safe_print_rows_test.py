import dataclasses
import io
import unittest
import zipfile

from openpyxl import load_workbook
from openpyxl.styles import Border, Side

import safe_print_rows as safe


def mutate(source, change):
    wb = load_workbook(io.BytesIO(source))
    change(wb)
    out = io.BytesIO()
    wb.save(out)
    wb.close()
    return out.getvalue()


class SafeRowsTest(unittest.TestCase):
    def test_insert_delete_and_copy_integrity(self):
        for old, new in [(2, 4), (4, 1), (2, 2)]:
            source = safe.synthetic_workbook(old)
            before = bytes(source)
            plan = safe.plan_rows(source, new)
            result = safe.apply_plan(source, plan)
            self.assertEqual(source, before)
            self.assertEqual(plan.last_data_row, 3)
            self.assertEqual(plan.old_total_row, 4 + old)
            self.assertEqual(plan.new_total_row, 4 + new)
            self.assertEqual(safe._members(result), safe._members(safe.synthetic_workbook(new)))
            wb = load_workbook(io.BytesIO(result))
            ws = wb.active
            self.assertEqual([ws.cell(r, 1).value for r in range(4, 4 + new)], [None] * new)
            self.assertEqual(ws['A3'].value, 'Example')
            self.assertEqual(ws.cell(4 + new, 1).value, 'Total (literal)')
            self.assertEqual(ws['A4'].border.left.style, 'thin')
            self.assertEqual({str(r) for r in ws.merged_cells.ranges},
                             {'A1:B1', f'A{4 + new}:B{4 + new}'})
            wb.close()

    def test_reject_formula_cross_sheet_merges_and_structures(self):
        source = safe.synthetic_workbook()
        changes = [
            lambda w: setattr(w.active['B3'], 'value', '=1+1'),
            lambda w: (w.create_sheet('Other'), setattr(w.active['B3'], 'value', "='Other'!A1")),
            lambda w: w.create_sheet('Other'),
            lambda w: w.active.merge_cells('A3:A4'),
            lambda w: w.active.merge_cells('A4:A5'),
            lambda w: setattr(w.active['A4'], 'value', 'not blank'),
            lambda w: setattr(w.active['A3'], 'value', 'different business row'),
            lambda w: setattr(w.active['A4'], 'border', Border(left=Side(style='double'))),
            lambda w: setattr(w.active.row_dimensions[4], 'height', 30),
            lambda w: setattr(w.active.auto_filter, 'ref', 'A2:B3'),
        ]
        for change in changes:
            with self.subTest(change=change):
                changed = mutate(source, change)
                before = bytes(changed)
                with self.assertRaises(safe.UnsafeWorkbook):
                    safe.plan_rows(changed, 3)
                self.assertEqual(changed, before)

    def test_bad_zip_extra_member_duplicate_and_limits(self):
        source = safe.synthetic_workbook()
        for bad in (b'not a workbook', b'', b'x' * 1_000_001, bytearray(source)):
            with self.assertRaises(safe.UnsafeWorkbook):
                safe.plan_rows(bad, 2)
        for member in ('extra.xml', 'xl/workbook.xml'):
            out = io.BytesIO(source)
            with zipfile.ZipFile(out, 'a') as z:
                z.writestr(member, 'unexpected')
            bad = out.getvalue()
            with self.assertRaises(safe.UnsafeWorkbook):
                safe.plan_rows(bad, 2)

    def test_stale_and_forged_plans_never_change_source(self):
        source = safe.synthetic_workbook(2)
        plan = safe.plan_rows(source, 4)
        before = bytes(source)
        for bad in (dataclasses.replace(plan, source_hash='wrong'),
                    dataclasses.replace(plan, old_total_row=999),
                    dataclasses.replace(plan, new_blank_rows=0), object()):
            with self.assertRaises(safe.UnsafeWorkbook):
                safe.apply_plan(source, bad)
            self.assertEqual(source, before)
        with self.assertRaises(safe.UnsafeWorkbook):
            safe.apply_plan(safe.synthetic_workbook(3), plan)
        self.assertEqual(source, before)

    def test_invalid_counts(self):
        source = safe.synthetic_workbook()
        for n in (0, 6, -1, True, 1.0, '2', None):
            with self.assertRaises(safe.UnsafeWorkbook):
                safe.plan_rows(source, n)


if __name__ == '__main__':
    unittest.main()

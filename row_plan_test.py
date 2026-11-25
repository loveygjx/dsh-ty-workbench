import unittest
from openpyxl import Workbook
from row_plan import plan_sheet


def bank():
    ws = Workbook().active
    ws.title = 'bank'
    ws['A1'] = '货币资金-银行存款评估明细表'
    for c, text in enumerate(('序号', '开户银行', '账号', '币种'), 1):
        ws.cell(5, c, text)
    ws['A6'] = 'index'
    ws['A7'], ws['B7'], ws['G7'] = 1, '银行', 0
    ws['A12'] = '合 计'
    ws['G12'] = '=ROUND(SUM(G6:G11),2)'
    ws.merge_cells('A12:B12')
    ws.print_area = 'A1:K12'
    return ws


def property_sheet():
    ws = Workbook().active
    ws['A1'], ws['A2'] = '投资性房地产-房屋评估明细表', '（采用成本模式计量）'
    for c, text in enumerate(('序号', '权证编号', '房屋名称', '坐落'), 1):
        ws.cell(6, c, text)
    ws['A8'] = 'index'
    ws['A9'], ws['B9'] = 1, '证号'
    ws['A15'], ws['J15'] = '合计', '=ROUND(SUM(J9:J14),2)'
    ws['A16'], ws['A17'] = '减：减值准备', '合计'
    ws.merge_cells('A15:C15')
    ws.merge_cells('A16:C16')
    ws.merge_cells('A17:C17')
    ws.print_area = 'A1:K17'
    return ws


class PlanTest(unittest.TestCase):
    def test_bank_boundary_and_strict_empty(self):
        p = plan_sheet(bank())
        self.assertEqual(p['status'], 'proposal')
        self.assertEqual(p['family'], 'generic_bottom_total')
        self.assertEqual(p['first_subtotal_row'], 12)
        self.assertEqual(p['last_occupied_row'], 7)
        self.assertEqual(p['delete_run'], [8, 9, 10, 11])

    def test_formula_only_row_never_deleted(self):
        ws = bank()
        ws['I11'] = '=H11-G11'
        p = plan_sheet(ws)
        self.assertEqual(p['delete_run'], [])
        self.assertEqual(p['last_occupied_row'], 11)

    def test_zero_is_occupied(self):
        ws = bank()
        ws['C11'] = 0
        self.assertEqual(plan_sheet(ws)['delete_run'], [])

    def test_first_of_two_totals(self):
        p = plan_sheet(property_sheet())
        self.assertEqual(p['total_rows'], [15, 17])
        self.assertEqual(p['insert_before'], 15)

    def test_inconsistent_total_skips(self):
        ws = property_sheet()
        ws['J15'] = '=SUM(J9:J16)'  # SUM 末端越过合计行：结构不一致，必须跳过
        self.assertEqual(plan_sheet(ws)['reason'], 'unverified_subtotal_formula')

    def test_crossing_merge_skips(self):
        ws = bank()
        ws.unmerge_cells('A12:B12')
        ws.merge_cells('A11:A12')
        ws['A11'] = '合计'
        self.assertEqual(plan_sheet(ws)['status'], 'skip')

    def test_no_print_area_skips(self):
        ws = bank()
        ws.print_area = None
        self.assertEqual(plan_sheet(ws)['reason'], 'no_print_area')

    def test_no_header_skips(self):
        ws = bank()
        for c in (1, 2, 3, 4, 5):
            ws.cell(5, c).value = None
        self.assertEqual(plan_sheet(ws)['reason'], 'no_header')

    def test_static_number_in_block_skips(self):
        ws = property_sheet()
        ws['A16'] = '备注'  # 非合计标签行
        ws['D16'] = 123  # 合计块内非标签行出现静态数字：边界判定不可信
        self.assertEqual(plan_sheet(ws)['reason'], 'static_values_in_total_block')

    def test_labelled_total_row_allows_static_numbers(self):
        ws = property_sheet()
        ws['J17'] = 888  # 合计标签行的静态数（系统给定值）允许
        self.assertEqual(plan_sheet(ws)['status'], 'proposal')

    def test_block_formula_referencing_business_rows_skips(self):
        ws = property_sheet()
        ws['J17'] = '=SUM(J9:J16)'  # 边界以下公式直接引用业务行：跳过
        self.assertEqual(plan_sheet(ws)['reason'], 'block_formula_references_business_rows')

    def test_mid_table_total_fails_closed(self):
        ws = property_sheet()
        ws['A11'] = '合计'  # 表中部合计标签：其块内公式引用业务行 → 最靠上候选失效
        # fail-closed：不回退到更低候选（那会在页脚中间插行），整表跳过。
        p = plan_sheet(ws)
        self.assertEqual(p['status'], 'skip')
        self.assertEqual(p['reason'], 'block_formula_references_business_rows')

    def test_real_cells_unchanged(self):
        ws = bank()
        before = [(c.coordinate, c.value) for row in ws for c in row if c.value is not None]
        plan_sheet(ws)
        after = [(c.coordinate, c.value) for row in ws for c in row if c.value is not None]
        self.assertEqual(before, after)


if __name__ == '__main__':
    unittest.main()

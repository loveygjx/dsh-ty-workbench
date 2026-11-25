"""safe_fill_rows gate tests (no LibreOffice needed)."""
import json
import os
import tempfile
import unittest

from openpyxl import Workbook

from safe_fill_rows import fill_workbook


class KindGateTests(unittest.TestCase):
    def setUp(self):
        fd, self.src = tempfile.mkstemp(suffix='.xlsx'); os.close(fd)
        fd, self.out = tempfile.mkstemp(suffix='.xlsx'); os.close(fd)
        os.unlink(self.out)  # output must not pre-exist
        wb = Workbook()
        wb.active['A1'] = '任意工作簿'
        wb.save(self.src)
        self.missing = ['/nonexistent', '/nonexistent', '/nonexistent']

    def tearDown(self):
        for p in (self.src, self.out):
            if os.path.exists(p):
                os.unlink(p)

    def test_declare_with_missing_components_fails_closed(self):
        # 申报表与明细表同一逻辑：结构规则校验 + 桥组件齐全才执行；组件缺失即失败关闭。
        res = fill_workbook(self.src, self.out, 'declare', *self.missing)
        self.assertEqual(res['changed'], [])
        self.assertTrue(any('bridge_unavailable' in s['reason'] for s in res['skipped']))
        self.assertFalse(os.path.exists(self.out), '申报表不得产出任何文件')

    def test_unknown_kind_never_runs(self):
        res = fill_workbook(self.src, self.out, 'other', *self.missing)
        self.assertEqual(res['changed'], [])
        self.assertTrue(any(s['reason'].startswith('fill_disabled_for_kind')
                            for s in res['skipped']))

    def test_xlsm_never_runs(self):
        xlsm = self.src[:-5] + '.xlsm'
        os.rename(self.src, xlsm)
        try:
            res = fill_workbook(xlsm, self.out, 'detail', *self.missing)
            self.assertTrue(any(s['reason'] == 'unsupported_format_xlsm'
                                for s in res['skipped']))
            self.assertFalse(os.path.exists(self.out))
        finally:
            os.rename(xlsm, self.src)

    def test_detail_with_missing_components_fails_closed(self):
        res = fill_workbook(self.src, self.out, 'detail', *self.missing)
        self.assertEqual(res['changed'], [])
        self.assertTrue(any('bridge_unavailable' in s['reason'] for s in res['skipped']))
        self.assertFalse(os.path.exists(self.out))


if __name__ == '__main__':
    unittest.main()

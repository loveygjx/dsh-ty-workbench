// 只使用临时目录和模拟 CLI；不访问真实天源数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ty-export-directory-'));
process.env.DSH_WORKBENCH_DATA_DIR = join(root, 'data');
process.env.TIANYUAN_PRINT_SKILLS_DIR = join(root, 'skills');
process.env.TYCPV_BIN = join(root, 'fake-tycpv');
const linkScript = join(root, 'skills/asset-link-restore/scripts/restore_links.py');
const fmtScript = join(root, 'skills/appraisal-detail-print-format/scripts/adjust_appraisal_detail_print.py');
await mkdir(dirname(linkScript), { recursive: true });
await mkdir(dirname(fmtScript), { recursive: true });
await writeFile(linkScript, '# mock\n');
await writeFile(fmtScript, '# mock\n');
await writeFile(process.env.TYCPV_BIN, `#!/usr/bin/env python3
import sys, os, zipfile
args = sys.argv
out = args[args.index('-o') + 1]
cid = args[args.index('-c') + 1]
with zipfile.ZipFile(os.path.join(out, 'same.xlsx'), 'w') as z:
    z.writestr('company.txt', cid)
`, { mode: 0o755 });

try {
  const mod = await import('./index.js');
  const routes = [];
  mod.apply({ connection: { fetch: { register: r => { routes.push(r); return () => {}; } } }, logger: { warn() {}, info() {} }, effect: fn => fn() });
  const route = routes.find(r => r.path === '/api/workbench/ty/export');
  assert.ok(route);
  test('批次直接位于输出根目录，重复导出唯一且按公司隔离同名文件', async () => {
    const output = join(root, 'output');
    await mkdir(output);
    async function run() {
      const response = await route.fetch(new Request('http://localhost/api/workbench/ty/export', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'detail', projectId: '42', projectCode: 'P1', projectName: '模拟项目', companyIds: '101,102', outputDir: output, applyFooters: false, applyFill: false, restoreFormulas: false }),
      }));
      assert.equal(response.status, 200);
      return response.json();
    }
    const first = await run();
    const second = await run();
    assert.notEqual(first.outDir, second.outDir);
    for (const result of [first, second]) {
      assert.equal(dirname(result.outDir), await realpath(output));
      assert.equal(result.successCount, 2);
      assert.ok(result.results.every(r => r.warnings.some(w => w.includes('自动增删行未启用'))));
      assert.match(basename(result.outDir), /^P1 模拟项目-明细表-\d{8}T\d{6}Z-[A-Za-z0-9]+$/);
      assert.equal(result.total, 2);
      const a = await readFile(join(result.outDir, '101', 'same.xlsx'));
      const b = await readFile(join(result.outDir, '102', 'same.xlsx'));
      assert.notDeepEqual(a, b);
    }
  });
  test('applyFill 默认启用时对不匹配模板安全跳过（端到端接线）', async () => {
    const response = await route.fetch(new Request('http://localhost/api/workbench/ty/export', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'detail', projectId: '42', companyIds: '101', restoreFormulas: false, applyFooters: false }),
    }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.successCount, 1);
    // 模拟工作簿没有任何受支持模板：必须跳过并写明原因，不得伪造成功步骤。
    assert.ok(result.results.every(r => r.ok && !r.stages.some(s => String(s).startsWith('safe_fill_rows'))));
    assert.ok(result.results.every(r => r.warnings.some(w => w.includes('自动增删行已暂停'))));
  });
  test('CLI 返回失败时部分文件不能被当作成功导出', async () => {
    const failedCli = join(root, 'failed-tycpv');
    await writeFile(failedCli, `#!/usr/bin/env python3\nimport os, sys, zipfile\na=sys.argv\nout=a[a.index('-o')+1]\nwith zipfile.ZipFile(os.path.join(out, 'partial.xlsx'), 'w') as z: z.writestr('partial', 'x')\nsys.exit(3)\n`, { mode: 0o755 });
    const previous = process.env.TYCPV_BIN;
    process.env.TYCPV_BIN = failedCli;
    try {
      const response = await route.fetch(new Request('http://localhost/api/workbench/ty/export', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'detail', projectId: '42', companyIds: '101', restoreFormulas: false, applyFooters: false, applyFill: false }),
      }));
      assert.equal(response.status, 502);
      const result = await response.json();
      assert.equal(result.ok, false);
      assert.match(result.error, /可能不完整，未进行后处理/);
    } finally { process.env.TYCPV_BIN = previous; }
  });
  test('申报表 409 拦截已移除：自动导出走 --skip-fill，手动流程直达文件校验', async () => {
    const response = await route.fetch(new Request('http://localhost/api/workbench/ty/export', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'declare', projectId: '42', companyIds: '101' }),
    }));
    assert.notEqual(response.status, 409);
    const result = await response.json().catch(() => ({}));
    assert.ok(!String(result.error ?? '').includes('暂时停用'), '旧拦截文案不应再出现');
    const { runManualWorkflow } = await import('./export-workflow.js');
    // 手动流程不再有入口拦截：不存在源文件应直达文件校验（ENOENT），而非“暂时停用”。
    await assert.rejects(
      runManualWorkflow({ kind: 'declare', sourcePath: join(root, 'source.xlsx'), outputDir: root, applyFormat: true }),
      /ENOENT/
    );
  });
  // node:test completes asynchronous tests after the module body returns.
  const { after } = await import('node:test');
  after(async () => { await rm(root, { recursive: true, force: true }); });
} catch (error) {
  await rm(root, { recursive: true, force: true });
  throw error;
}

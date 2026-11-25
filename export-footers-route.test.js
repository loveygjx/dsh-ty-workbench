// 导出页脚配置路由回归测试（不联网、不碰真实 Cookie）：
//   1) GET 校验 projectId 必须为数字
//   2) POST 保存 → GET 回读一致（含申报 hidden 字段语义：appraisers 留空即存空）
//   3) POST 三项全空条目 → 保存后条目被剔除（视为删除）
//   4) POST 整个项目全部清空 → 项目配置整个移除
//   5) POST 公司 ID 非数字 / footers 结构非法 → 400
//   6) store 隔离：用 DSH_WORKBENCH_DATA_DIR 指向临时目录，不污染真实配置
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 页脚配置落在 store.config().dir；测试前把数据目录指到临时目录。
const dataDir = mkdtempSync(join(tmpdir(), 'dsh-ty-footers-'));
process.env.DSH_WORKBENCH_DATA_DIR = dataDir;

const mod = await import('./index.js');

const routes = [];
mod.apply({
  connection: { fetch: { register: (r) => { routes.push(r); return () => {}; } } },
  logger: { warn: () => {}, info: () => {} },
  effect: (fn) => fn(),
});
const footersRoute = routes.find(r => r.path === '/api/workbench/ty/export/footers');
assert.ok(footersRoute, 'footers route registered');
assert.deepEqual([...footersRoute.methods].sort(), ['GET', 'POST'], 'footers route supports GET+POST');

const PJ = '20261110001';

async function getFooters(projectId) {
  const req = new Request('http://127.0.0.1/api/workbench/ty/export/footers?projectId=' + projectId, { method: 'GET' });
  const res = await footersRoute.fetch(req);
  return { status: res.status, body: await res.json() };
}
async function postFooters(body) {
  const req = new Request('http://127.0.0.1/api/workbench/ty/export/footers', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
  const res = await footersRoute.fetch(req);
  return { status: res.status, body: await res.json() };
}

test('GET 拒绝非数字 projectId', async () => {
  const r = await getFooters('abc');
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
});

test('GET 空配置返回空 footers', async () => {
  const r = await getFooters(PJ);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.footers, {});
});

test('POST 保存后 GET 回读一致', async () => {
  const save = await postFooters({ projectId: PJ, footers: { '101': { preparer: '张三', date: '2026-11-24', appraisers: '李四、王五' } } });
  assert.equal(save.status, 200);
  assert.equal(save.body.ok, true);
  assert.equal(save.body.saved, 1);

  const back = await getFooters(PJ);
  assert.equal(back.status, 200);
  assert.deepEqual(back.body.footers, { '101': { preparer: '张三', date: '2026-11-24', appraisers: '李四、王五' } });
});

test('POST 保存多公司且长字段截断', async () => {
  const long = 'x'.repeat(300);
  const save = await postFooters({ projectId: PJ, footers: { '102': { preparer: long, date: '', appraisers: '' } } });
  assert.equal(save.status, 200);
  const back = await getFooters(PJ);
  assert.equal(back.body.footers['102'].preparer.length, 200);
});

test('POST 三项全空条目被剔除', async () => {
  const save = await postFooters({ projectId: PJ, footers: { '103': { preparer: '', date: '', appraisers: '' } } });
  assert.equal(save.status, 200);
  assert.equal(save.body.saved, 0);
  const back = await getFooters(PJ);
  assert.equal(back.body.footers['103'], undefined);
});

test('POST 项目全部清空后配置整个移除', async () => {
  const save = await postFooters({ projectId: PJ, footers: {} });
  assert.equal(save.status, 200);
  const back = await getFooters(PJ);
  assert.deepEqual(back.body.footers, {});
});

test('POST 公司 ID 非数字 → 400', async () => {
  const r = await postFooters({ projectId: PJ, footers: { '公司A': { preparer: 'x' } } });
  assert.equal(r.status, 400);
});

test('POST footers 结构非法 → 400', async () => {
  const r = await postFooters({ projectId: PJ, footers: [1, 2] });
  assert.equal(r.status, 400);
});

test('POST projectId 非数字 → 400', async () => {
  const r = await postFooters({ projectId: 'p1', footers: { '1': { preparer: 'x' } } });
  assert.equal(r.status, 400);
});

test('落盘文件在数据目录内且 JSON 可解析', async () => {
  const file = join(dataDir, '导出页脚.json');
  assert.ok(existsSync(file), '导出页脚.json 已落盘');
  const j = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(j && typeof j === 'object', 'JSON 合法');
});

test('损坏的页脚配置不能被默认为空并覆盖', async () => {
  const file = join(dataDir, '导出页脚.json');
  writeFileSync(file, '{broken', 'utf8');
  const read = await getFooters(PJ);
  assert.equal(read.body.ok, false);
  const save = await postFooters({ projectId: PJ, footers: { '101': { preparer: 'X' } } });
  assert.equal(save.body.ok, false);
  assert.equal(readFileSync(file, 'utf8'), '{broken');
});

// 清理：删掉临时数据目录（测试进程退出后 tmpdir 也会被系统清理，这里主动删更干净）。
after(async () => {
  delete process.env.DSH_WORKBENCH_DATA_DIR;
  const fs = await import('node:fs');
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
});

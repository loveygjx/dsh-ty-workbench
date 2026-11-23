import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOnlineSnapshot } from './report-online-snapshot.js';
import { astDigest, checkEvidence, locateCandidate } from './report-node-mapper.js';

function para(text) {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}
function item(id, blocks) {
  return {
    id, itemType: 4, itemName: 'item-' + id,
    itemContent: { itemId: id, itemType: 4, text: { type: 'doc', content: blocks } },
    subItemList: [],
  };
}
function doc(itemList, basicInfo = { projectId: 110804796309505, companyId: 110804796309543, reportType: 2 }) {
  return { basicInfo, itemList, headerFooter: { header: '页眉' }, warnings: [] };
}

test('同批次快照：身份取自 basicInfo，摘要与计数可复核', () => {
  const items = [item(101, [para('第一部分'), para('关于资产评估说明使用范围的声明')]), item(102, [para('第二部分')])];
  const { snapshot, evidence } = buildOnlineSnapshot({
    document: doc(items),
    expected: { projectId: '110804796309505', companyId: '110804796309543', reportType: '2' },
    capturedAt: '2026-11-22T15:40:00.000Z',
  });
  assert.deepEqual(snapshot.identity, { projectId: '110804796309505', companyId: '110804796309543', reportType: '2' });
  assert.equal(evidence.astSha256, astDigest(items));
  assert.equal(evidence.itemCount, 2);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.versionMatched, true);
  assert.equal(evidence.versionProof, 'same-batch');
  assert.equal(evidence.capturedAt, '2026-11-22T15:40:00.000Z');
  assert.deepEqual(snapshot.headerFooter, { header: '页眉' });
  // 证据必须能过 checkEvidence，否则后续定位层会直接拒绝。
  assert.equal(checkEvidence(snapshot, evidence), null);
});

test('身份不符或缺失一律拒绝，不允许"猜一个"', () => {
  const items = [item(101, [para('正文')])];
  assert.throws(() => buildOnlineSnapshot({ document: doc(items), expected: { projectId: '999' } }), /projectId 与本次导出不一致/);
  assert.throws(() => buildOnlineSnapshot({ document: doc(items), expected: { reportType: '3' } }), /reportType 与本次导出不一致/);
  assert.throws(() => buildOnlineSnapshot({ document: { basicInfo: { projectId: 1 }, itemList: items } }), /缺少身份字段/);
  assert.throws(() => buildOnlineSnapshot({ document: { basicInfo: { projectId: 1, companyId: 2, reportType: 2 } } }), /没有节点树/);
  assert.throws(() => buildOnlineSnapshot({ document: doc([]) }), /没有节点树/);
  assert.throws(() => buildOnlineSnapshot({ document: doc(items, { projectId: 1, companyId: '', reportType: 2 }) }), /缺少身份字段/);
});

test('warnings 非空视为不完整，complete=false 时定位必须被拒', () => {
  const items = [item(101, [para('关于资产评估说明使用范围的声明')])];
  const document = doc(items);
  document.warnings = ['节点条件校验未通过'];
  const { snapshot, evidence } = buildOnlineSnapshot({ document });
  assert.equal(evidence.complete, false);
  assert.deepEqual(snapshot.warnings, ['节点条件校验未通过']);
  assert.match(checkEvidence(snapshot, evidence), /not proven complete/);
  const out = locateCandidate({
    snapshot, evidence,
    change: { baseline: '关于资产评估说明使用范围的声明', modified: '关于评估说明使用范围的声明' },
  });
  assert.equal(out.status, 'refused');
  assert.equal(out.writebackAllowed, false);
});

test('同一快照能定位唯一段落，且仍然不允许写回', () => {
  const items = [item(101, [para('第一部分'), para('关于资产评估说明使用范围的声明')])];
  const { snapshot, evidence } = buildOnlineSnapshot({ document: doc(items) });
  const out = locateCandidate({
    snapshot, evidence,
    change: { baseline: '关于资产评估说明使用范围的声明', modified: '关于评估说明使用范围的声明' },
  });
  assert.equal(out.status, 'located');
  assert.equal(out.candidate.itemId, 101);
  assert.equal(out.candidate.blockIndex, 1);
  assert.equal(out.writebackAllowed, false);
  assert.equal(out.requiresHumanReview, true);
});

test('节点树超宽或过深时报错而不是爆栈或截断', () => {
  // 超宽：一层里塞 20 万条以上节点
  const wide = Array.from({ length: 200002 }, (_, i) => item(i + 1, [para('x')]));
  assert.throws(() => buildOnlineSnapshot({ document: doc(wide) }), /节点树超过上限/);

  // 过深：逐层嵌套超过 200 层，必须报层级错误而不是 RangeError 爆栈
  const root = item(1, [para('x')]);
  let node = root;
  for (let i = 0; i < 300; i++) {
    const child = item(i + 2, [para('x')]);
    node.subItemList = [child];
    node = child;
  }
  assert.throws(() => buildOnlineSnapshot({ document: doc([root]) }), /节点树层级过深/);
});

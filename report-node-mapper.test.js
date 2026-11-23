import test from 'node:test';
import assert from 'node:assert/strict';

import {
  astDigest,
  checkEvidence,
  collectLocatableBlocks,
  locateCandidate,
  safeParagraphText,
  stableStringify,
} from './report-node-mapper.js';

/** 造一个只含 text run 的段落。 */
function para(...texts) {
  return { type: 'paragraph', content: texts.map((text) => ({ type: 'text', text })) };
}

/** 造一个含变量的段落。 */
function paraWithField(text, key) {
  return {
    type: 'paragraph',
    content: [
      { type: 'text', text },
      { type: 'fieldValue', attrs: { content: key, text: '${' + key + '}' } },
    ],
  };
}

function item(id, blocks, extra = {}) {
  return {
    id,
    itemType: 4,
    itemName: 'item-' + id,
    itemContent: { itemId: id, itemType: 4, text: { type: 'doc', content: blocks } },
    subItemList: [],
    ...extra,
  };
}

const IDENTITY = { projectId: '20250903002', companyId: '8801', reportType: '2' };

/** 造快照 + 与之匹配的证据。 */
function snapshotWith(items, identity = IDENTITY) {
  const snapshot = { identity, itemList: items };
  const evidence = { versionMatched: true, complete: true, ...identity, astSha256: astDigest(items) };
  return { snapshot, evidence };
}

test('极简段落：单段唯一文本可以被定位为候选', () => {
  const items = [item(101, [para('第一部分'), para('关于资产评估说明使用范围的声明')])];
  const { snapshot, evidence } = snapshotWith(items);
  const out = locateCandidate({
    snapshot,
    evidence,
    change: { baseline: '关于资产评估说明使用范围的声明', modified: '关于评估说明使用范围的声明' },
  });
  assert.equal(out.status, 'located');
  assert.equal(out.candidate.itemId, 101);
  assert.deepEqual(out.candidate.itemIndex, [0]);
  assert.equal(out.candidate.blockIndex, 1);
  assert.equal(out.writebackAllowed, false, '定位成功也不得声称可写回');
  assert.equal(out.requiresHumanReview, true);
});

test('没有任何版本证据时整体拒绝，不做任何猜测', () => {
  const items = [item(101, [para('唯一的一段')])];
  assert.equal(locateCandidate({ snapshot: { identity: IDENTITY, itemList: items }, change: { baseline: '唯一的一段', modified: '改过的段落' } }).status, 'refused');
  assert.match(
    locateCandidate({ snapshot: { identity: IDENTITY, itemList: items } }).reason,
    /missing change/,
  );
  const { snapshot } = snapshotWith(items);
  const noEvidence = locateCandidate({ snapshot, change: { baseline: '唯一的一段', modified: '改过的段落' } });
  assert.equal(noEvidence.status, 'refused');
  assert.match(noEvidence.reason, /missing version evidence/);
});

test('证据声明版本不匹配或快照不完整时拒绝', () => {
  const items = [item(101, [para('唯一的一段')])];
  const { snapshot, evidence } = snapshotWith(items);
  const change = { baseline: '唯一的一段', modified: '改过的段落' };
  assert.match(
    locateCandidate({ snapshot, evidence: { ...evidence, versionMatched: false }, change }).reason,
    /version is not proven/,
  );
  assert.match(
    locateCandidate({ snapshot, evidence: { ...evidence, complete: false }, change }).reason,
    /not proven complete/,
  );
});

test('身份或 AST 摘要对不上时拒绝，防止拿错快照定位', () => {
  const items = [item(101, [para('唯一的一段')])];
  const { snapshot, evidence } = snapshotWith(items);
  const change = { baseline: '唯一的一段', modified: '改过的段落' };
  assert.match(
    locateCandidate({ snapshot, evidence: { ...evidence, companyId: '9999' }, change }).reason,
    /companyId does not match/,
  );
  assert.match(
    locateCandidate({ snapshot, evidence: { ...evidence, projectId: '1' }, change }).reason,
    /projectId does not match/,
  );
  assert.match(
    locateCandidate({ snapshot, evidence: { ...evidence, astSha256: 'a'.repeat(64) }, change }).reason,
    /AST does not match/,
  );
  assert.match(
    locateCandidate({ snapshot, evidence: { ...evidence, astSha256: 'not-a-digest' }, change }).reason,
    /missing or invalid evidence astSha256/,
  );
});

test('含变量的段落不可定位：不能整体覆盖变量语义', () => {
  const items = [item(101, [paraWithField('委托人为', 'project_info.client_info.clientName')])];
  const { snapshot, evidence } = snapshotWith(items);
  const out = locateCandidate({
    snapshot,
    evidence,
    change: { baseline: '委托人为${项目信息.委托人信息.委托人名称}', modified: '新的段落' },
  });
  assert.equal(out.status, 'refused');
  assert.match(out.reason, /not found among locatable paragraphs/);
  // 含变量的段落本身也不应出现在可定位集合里
  assert.equal(collectLocatableBlocks(items).length, 0);
  assert.equal(safeParagraphText(paraWithField('委托人为', 'x')), null);
});

test('表格、图片、公式段落不可定位', () => {
  const table = { type: 'paragraph', content: [{ type: 'tableValue', attrs: { content: 't' } }] };
  const image = { type: 'paragraph', content: [{ type: 'image', attrs: { src: 'https://ty.zhrdc.net/a.png' } }] };
  const formula = { type: 'paragraph', content: [{ type: 'formula', attrs: {} }, { type: 'text', text: 'x' }] };
  const items = [item(101, [table, image, formula])];
  const { snapshot, evidence } = snapshotWith(items);
  assert.equal(collectLocatableBlocks(items).length, 0);
  for (const block of [table, image, formula]) {
    assert.equal(safeParagraphText(block), null);
  }
  const out = locateCandidate({ snapshot, evidence, change: { baseline: 'x', modified: 'y' } });
  assert.equal(out.status, 'refused');
});

test('附件 item（itemType=1）永不参与正文定位', () => {
  const attachment = {
    id: 201,
    itemType: 1,
    itemContent: { itemId: 201, itemType: 1, text: null, attachId: 55, fileName: 'a.docx', uri: 'u', fileKey: 'k' },
    subItemList: [],
  };
  const items = [attachment, item(101, [para('正文一段')])];
  const { snapshot, evidence } = snapshotWith(items);
  assert.equal(collectLocatableBlocks(items).length, 1, '附件不应产生可定位段落');
  const out = locateCandidate({ snapshot, evidence, change: { baseline: '正文一段', modified: '正文第二段' } });
  assert.equal(out.status, 'located');
  assert.equal(out.candidate.itemId, 101);
});

test('文本重复出现时拒绝，绝不取第一条', () => {
  const items = [item(101, [para('重复段落')]), item(102, [para('重复段落')])];
  const { snapshot, evidence } = snapshotWith(items);
  const out = locateCandidate({ snapshot, evidence, change: { baseline: '重复段落', modified: '改过的段落' } });
  assert.equal(out.status, 'refused');
  assert.match(out.reason, /more than once/);
});

test('改动后的文本已存在于别处时拒绝，避免制造新的重复', () => {
  const items = [item(101, [para('原段落')]), item(102, [para('目标段落')])];
  const { snapshot, evidence } = snapshotWith(items);
  const out = locateCandidate({ snapshot, evidence, change: { baseline: '原段落', modified: '目标段落' } });
  assert.equal(out.status, 'refused');
  assert.match(out.reason, /already exists elsewhere/);
});

test('文本前后只有空白差异时视为未改动', () => {
  const items = [item(101, [para('同一段')])];
  const { snapshot, evidence } = snapshotWith(items);
  const out = locateCandidate({ snapshot, evidence, change: { baseline: '同一段', modified: ' 同一段 ' } });
  assert.equal(out.status, 'refused');
  assert.match(out.reason, /identical/);
});

test('空段落与纯空白段落不参与定位，也不制造假冲突', () => {
  const items = [item(101, [para(''), para(' '), para('实段')])];
  const { snapshot, evidence } = snapshotWith(items);
  const blocks = collectLocatableBlocks(items);
  assert.deepEqual(blocks.map((b) => b.text), ['实段']);
  const out = locateCandidate({ snapshot, evidence, change: { baseline: '实段', modified: '实段2' } });
  assert.equal(out.status, 'located');
});

test('itemContent.itemId 与外层 id 不一致的节点不可信，不做定位', () => {
  const broken = {
    id: 101,
    itemType: 4,
    itemContent: { itemId: 999, text: { type: 'doc', content: [para('不该被定位')] } },
    subItemList: [],
  };
  const items = [broken];
  const { snapshot, evidence } = snapshotWith(items);
  assert.equal(collectLocatableBlocks(items).length, 0);
  const out = locateCandidate({ snapshot, evidence, change: { baseline: '不该被定位', modified: 'x' } });
  assert.equal(out.status, 'refused');
});

test('子节点树也会被展开定位，路径指向真实层级', () => {
  const child = item(202, [para('子节点里的段落')]);
  const parent = { ...item(101, [para('父节点段落')]), subItemList: [child] };
  const { snapshot, evidence } = snapshotWith([parent]);
  const out = locateCandidate({ snapshot, evidence, change: { baseline: '子节点里的段落', modified: '改过' } });
  assert.equal(out.status, 'located');
  assert.equal(out.candidate.itemId, 202);
  assert.deepEqual(out.candidate.itemIndex, [0, 0]);
});

test('AST 摘要对键序不敏感，对内容敏感', () => {
  const a = [{ id: 1, itemContent: { text: 'x', itemId: 1 } }];
  const b = [{ itemContent: { itemId: 1, text: 'x' }, id: 1 }];
  assert.equal(stableStringify(a), stableStringify(b));
  assert.equal(astDigest(a), astDigest(b));
  const c = [{ id: 1, itemContent: { text: 'y', itemId: 1 } }];
  assert.notEqual(astDigest(a), astDigest(c));
});

test('checkEvidence 对缺失字段给出具体原因', () => {
  assert.match(checkEvidence(null, {}), /missing snapshot/);
  assert.match(checkEvidence({}, {}), /missing snapshot itemList/);
  assert.match(checkEvidence({ itemList: [] }, null), /missing version evidence/);
  assert.match(checkEvidence({ itemList: [] }, { versionMatched: true, complete: true }), /missing snapshot identity/);
  const base = { itemList: [], identity: IDENTITY };
  const ev = { versionMatched: true, complete: true, ...IDENTITY, astSha256: astDigest([]) };
  assert.equal(checkEvidence(base, ev), null);
  assert.match(
    checkEvidence(base, { ...ev, capturedAt: 5 }),
    /invalid evidence capturedAt/,
  );
});

test('Word 里的章节序号不影响定位：线上节点不带「五、」这类前缀', () => {
  // 线上节点的正文（无序号，序号由生成器按节点顺序加）
  const items = [item(900000000000003, [
    para('本资产评估机构及其资产评估专业人员遵守法律、行政法规和资产评估准则，坚持独立、客观、公正的原则，并对所出具的资产评估报告依法承担责任。'),
  ])];
  const { snapshot, evidence } = snapshotWith(items);
  // Word 侧带「五、」，且这次改的是正文里的一句
  const out = locateCandidate({
    snapshot,
    evidence,
    change: {
      baseline: '五、本资产评估机构及其资产评估专业人员遵守法律、行政法规和资产评估准则，坚持独立、客观、公正的原则，并对所出具的资产评估报告依法承担责任。',
      modified: '五、本资产评估机构及其资产评估专业人员遵守法律、行政法规和资产评估准则，坚持独立、客观、公正、诚信的原则，并对所出具的资产评估报告依法承担责任。',
    },
  });
  assert.equal(out.status, 'located');
  assert.equal(out.candidate.itemId, 900000000000003);
  assert.equal(out.candidate.blockIndex, 0);
  assert.equal(out.candidate.text.startsWith('本资产评估机构'), true, '返回的应是线上原文，不带序号');
  assert.equal(out.matchedBy, 'stripped numbering prefix');
  assert.equal(out.writebackAllowed, false);
});

test('剥序号只在精确匹配失败后进行，且各种序号形态都能剥', () => {
  // 线上节点一侧不带序号（序号由生成器按节点顺序加），Word 一侧带序号。
  const items = [item(7, [
    para('正文第一句'),
    para('括号序号后的正文'),
    para('阿拉伯数字序号后的正文'),
    para('标题文字'),
  ])];
  const { snapshot, evidence } = snapshotWith(items);
  const baselines = ['一、正文第一句', '（一）括号序号后的正文', '(一)括号序号后的正文', '1、阿拉伯数字序号后的正文', '第一章标题文字'];
  for (const baseline of baselines) {
    const out = locateCandidate({ snapshot, evidence, change: { baseline, modified: baseline + '（改）' } });
    assert.equal(out.status, 'located', '应能定位：' + baseline);
    assert.equal(out.matchedBy, 'stripped numbering prefix', baseline + ' 应走剥前缀分支');
  }
});

test('剥序号不能把小数或正文里的数字当序号删掉', () => {
  const items = [item(9, [para('1.5 倍的系数说明'), para('营业收入 12.5 万元')])];
  const { snapshot, evidence } = snapshotWith(items);
  // 「1.5 倍的系数说明」不该被剥成「5 倍的系数说明」
  const out = locateCandidate({ snapshot, evidence, change: { baseline: '1.5 倍的系数说明', modified: '1.6 倍的系数说明' } });
  assert.equal(out.status, 'located');
  assert.equal(out.matchedBy, 'exact', '含小数的文本必须走精确匹配，不能被剥前缀');
});

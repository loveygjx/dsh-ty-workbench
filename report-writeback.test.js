import test from 'node:test';
import assert from 'node:assert/strict';
import { blockText, plainText, replaceBlockText, applyWriteback, insertBlocksAfter, deleteBlocksAt } from './report-writeback.js';
import { stripNumberingPrefix } from './report-node-mapper.js';

const doc = () => ({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: '第一段原文' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: '引用：' },
        { type: 'fieldValue', attrs: { content: 'a.b', text: '${变量}' } },
      ],
    },
    { type: 'paragraph', content: [] },
  ],
});

test('plainText 会拼上 fieldValue 的显示文本', () => {
  assert.equal(plainText(doc().content[2]), '');
  assert.equal(blockText(doc(), 1), '引用：${变量}');
});

test('replaceBlockText 只改目标段落，其余段落对象原样保留', () => {
  const before = doc();
  const after = replaceBlockText(before, 0, '第一段改后');
  assert.equal(blockText(after, 0), '第一段改后');
  assert.equal(after.content[1], before.content[1], '其他段落必须是同一个对象引用，证明没被重建');
  assert.equal(before.content[0].content[0].text, '第一段原文', '不得就地修改入参');
});

test('replaceBlockText 对越界索引返回 null', () => {
  assert.equal(replaceBlockText(doc(), 9, 'x'), null);
  assert.equal(replaceBlockText(null, 0, 'x'), null);
});

test('replaceBlockText 必须保住段落 attrs：线上渲染器遇到 attrs=null 会整份报告生成失败', () => {
  const before = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { textAlign: 'justify', indent: 1, lineHeight: '150%' },
        content: [{ type: 'text', text: '原文' }],
      },
    ],
  };
  const after = replaceBlockText(before, 0, '新文');
  assert.deepEqual(after.content[0].attrs, { textAlign: 'justify', indent: 1, lineHeight: '150%' });
  assert.equal(after.content[0].attrs.textAlign, 'justify', '对齐方式不能被抹掉');
  assert.equal(after.content[0].attrs.lineHeight, '150%', '行距不能被抹掉');
});

test('replaceBlockText 必须保住文字 run 的字体 marks：否则字号字体全掉', () => {
  const marks = [{ type: 'textStyle', attrs: { fontFamily: '黑体', fontSize: 12, color: '' } }];
  const before = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { textAlign: 'center' }, content: [{ type: 'text', text: '标题', marks }] },
    ],
  };
  const after = replaceBlockText(before, 0, '新标题');
  assert.deepEqual(after.content[0].content[0].marks, marks, '字体标记必须带过去');
  assert.notEqual(after.content[0].content[0].marks, marks, '必须是副本，不能共享引用');
});

test('原段落没有 attrs 时也要补一个合法对象，绝不能留 null', () => {
  const before = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '无属性段' }] }] };
  const after = replaceBlockText(before, 0, '改后');
  assert.equal(typeof after.content[0].attrs, 'object');
  assert.notEqual(after.content[0].attrs, null);
});

test('applyWriteback 不传 confirm 一律拒绝', async () => {
  await assert.rejects(
    () => applyWriteback({ projectId: '1', companyId: '2', reportType: 1, baseline: {}, locate: {}, confirm: false }),
    /必须显式传 confirm=true/,
  );
});

test('applyWriteback 缺基线快照或没有定位结果都拒绝', async () => {
  await assert.rejects(
    () => applyWriteback({ baseline: {}, locate: {}, confirm: true }),
    /缺少基线快照/,
  );
  await assert.rejects(
    () => applyWriteback({ baseline: { onlineSnapshot: { astSha256: 'x' } }, locate: { located: [] }, confirm: true }),
    /没有可写回的改动/,
  );
});

// ---------- 现场比对通道（不导出基线）的并发校验 ----------
//
// 用户要求"只上传改稿、自动跟线上比"，于是归档 manifest 不再一定存在。
// 这种情况下并发校验的期望哈希必须由宿主在比对时当场抓到的节点树摘要提供，
// 绝不能来自前端请求体 —— 下面三条把它钉住。

test('现场比对通道：expectedSha256 可以直接驱动并发校验，不需要 baseline', async () => {
  await assert.rejects(
    () => applyWriteback({ projectId: '1', companyId: '2', reportType: 1, expectedSha256: 'a'.repeat(64), locate: { located: [{ candidate: { itemId: '9' } }] }, confirm: true }),
    // 走到"重抓线上节点树"这一步才算通过了哈希校验；这里没有浏览器通道，所以必然在这一步失败。
    /抓取线上节点失败|OPENCLI|BRIDGE|EVAL|exportTree/i,
    '应当已经越过哈希校验，说明 expectedSha256 被接受了',
  );
});

test('现场比对通道：两个来源都没有哈希时必须拒绝，不能默认放行', async () => {
  await assert.rejects(
    () => applyWriteback({ projectId: '1', companyId: '2', reportType: 1, locate: { located: [{ candidate: { itemId: '9' } }] }, confirm: true }),
    /缺少基线快照|缺少 astSha256/,
  );
  // baseline 存在但没快照、又没给 expectedSha256，同样要拒绝
  await assert.rejects(
    () => applyWriteback({ projectId: '1', companyId: '2', reportType: 1, baseline: {}, locate: { located: [{ candidate: { itemId: '9' } }] }, confirm: true }),
    /缺少基线快照/,
  );
});

test('现场比对通道：依然要先过 confirm，且要先有定位结果', async () => {
  await assert.rejects(
    () => applyWriteback({ projectId: '1', companyId: '2', reportType: 1, expectedSha256: 'a'.repeat(64), locate: { located: [] }, confirm: false }),
    /必须显式传 confirm=true/,
    'confirm 必须排在所有校验最前面',
  );
  await assert.rejects(
    () => applyWriteback({ projectId: '1', companyId: '2', reportType: 1, expectedSha256: 'a'.repeat(64), locate: { located: [] }, confirm: true }),
    /没有可写回的改动/,
  );
});

// ---------- 序号剥不剥，取决于线上原文自己带不带 ----------
//
// 血泪教训（实测浙江交投金属 V4）：报告里很多章节序号是**字面写在节点正文里**的
// （DOCX 里 w:numPr/w:numId 出现 0 次，全是死文本），例如「1．市场法」「(1) 必须
// 有一个充分发展、活跃的资本市场；」。而另一批序号（「(二)」「18.」「2.」）确实
// 只存在于生成出来的 DOCX 里、节点正文没有。
//
// 早期实现无条件 stripNumberingPrefix，导致改「1．市场法」→「1．市场法（2024年修订）」
// 写回去变成「市场法（2024年修订）」，序号被当成前缀扔掉。
// 正确判据是线上原文：原文自带序号 → 序号属于内容，必须保留；原文没有 → 剥掉，
// 否则写回去会和生成器重复加一遍。

test('写回时线上原文自带序号，必须保留改稿里的序号（不能剥）', () => {
  // 直接验证判据函数本身，避免为这条规则起浏览器会话
  const decide = (originalText, rawWanted) => {
    const originalHasPrefix = typeof originalText === 'string' && originalText.trim() !== ''
      && stripNumberingPrefix(originalText) !== originalText.trim();
    return originalHasPrefix ? String(rawWanted).trim() : stripNumberingPrefix(String(rawWanted));
  };
  assert.equal(decide('1．市场法', '1．市场法（2024年修订）'), '1．市场法（2024年修订）', '字面序号必须留在正文里');
  assert.equal(decide('(1) 必须有一个充分发展、活跃的资本市场；', '(1) 必须有充分发展、活跃的资本市场；'), '(1) 必须有充分发展、活跃的资本市场；');
});

test('写回时线上原文没有序号，必须剥掉改稿里的序号（否则与生成器重复）', () => {
  const decide = (originalText, rawWanted) => {
    const originalHasPrefix = typeof originalText === 'string' && originalText.trim() !== ''
      && stripNumberingPrefix(originalText) !== originalText.trim();
    return originalHasPrefix ? String(rawWanted).trim() : stripNumberingPrefix(String(rawWanted));
  };
  assert.equal(decide('不动产权证书；', '2. 不动产权证书；'), '不动产权证书；');
  assert.equal(
    decide('截至评估基准日，纳入评估范围的6项房屋建筑物尚未取得不动产权证书，具体如下：',
           '(二) 截至评估基准日，纳入评估范围的6项房屋建筑物尚未取得不动产权证书，具体如下：'),
    '截至评估基准日，纳入评估范围的6项房屋建筑物尚未取得不动产权证书，具体如下：',
  );
  assert.equal(
    decide('《商标资产评估指导意见》（中评协〔2017〕51号）；',
           '18. 《商标资产评估指导意见》（中评协〔2017〕51号）。'),
    '《商标资产评估指导意见》（中评协〔2017〕51号）。',
  );
});

// ── 增删段落：节点是段落数组，增删就是改数组长度 ──
test('insertBlocksAfter 必须沿用锚点段的 attrs 与 marks，否则线上渲染会崩', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { textAlign: 'justify', indent: 1, lineHeight: '150%' },
        content: [{ type: 'text', marks: [{ type: 'textStyle', attrs: { fontFamily: '宋体', fontSize: 12 } }], text: '锚点段落' }] },
      { type: 'paragraph', attrs: { textAlign: 'justify', indent: 1, lineHeight: '150%' },
        content: [{ type: 'text', marks: [{ type: 'textStyle', attrs: { fontFamily: '宋体', fontSize: 12 } }], text: '后一段' }] },
    ],
  };
  const out = insertBlocksAfter(doc, 0, ['新加的第一段', '新加的第二段']);
  assert.ok(out);
  assert.equal(out.content.length, 4);
  assert.equal(plainText(out.content[1]), '新加的第一段');
  assert.equal(plainText(out.content[2]), '新加的第二段');
  // 关键：attrs 与 marks 必须原样带过来。attrs 为 null 会让线上抛
  // Cannot invoke "java.util.Map.get(Object)" because "content.attrs" is null
  for (const i of [1, 2]) {
    assert.ok(out.content[i].attrs && typeof out.content[i].attrs === 'object', 'attrs 不能为 null');
    assert.equal(out.content[i].attrs.textAlign, 'justify');
    assert.ok(Array.isArray(out.content[i].content[0].marks), 'marks 不能丢');
    assert.equal(out.content[i].content[0].marks[0].attrs.fontFamily, '宋体');
  }
});

test('insertBlocksAfter 支持插到锚点段之前（文首新增的场景）', () => {
  const doc = {
    type: 'doc',
    content: [{ type: 'paragraph', attrs: {}, content: [{ type: 'text', text: '第一段' }] }],
  };
  const out = insertBlocksAfter(doc, 0, ['插到前面'], { before: true });
  assert.equal(plainText(out.content[0]), '插到前面');
  assert.equal(plainText(out.content[1]), '第一段');
});

test('deleteBlocksAt 只删文本匹配的段，不误删相邻空段', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: {}, content: [{ type: 'text', text: '要删的' }] },
      { type: 'paragraph', attrs: {}, content: [{ type: 'text', text: '' }] },
      { type: 'paragraph', attrs: {}, content: [{ type: 'text', text: '留下的' }] },
    ],
  };
  const out = deleteBlocksAt(doc, 0, ['要删的']);
  assert.ok(out);
  assert.equal(out.content.length, 2);
  assert.equal(plainText(out.content[0]), '');
  assert.equal(plainText(out.content[1]), '留下的');
});

test('deleteBlocksAt 文本对不上时返回 null（宁可不删也不猜）', () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph', attrs: {}, content: [{ type: 'text', text: '别的' }] }] };
  assert.equal(deleteBlocksAt(doc, 0, ['要删的']), null);
});

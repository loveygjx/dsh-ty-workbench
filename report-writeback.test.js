import test from 'node:test';
import assert from 'node:assert/strict';
import { blockText, plainText, replaceBlockText, applyWriteback } from './report-writeback.js';

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

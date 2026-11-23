import test from 'node:test';
import assert from 'node:assert/strict';

import { WRITE_CHANNELS, buildSavePayload } from './report-write-channel.js';

test('写回通道路径与前端产物一致', () => {
  assert.equal(WRITE_CHANNELS.saveContents.path, '/ty/api/report/config/item/content/save');
  assert.equal(WRITE_CHANNELS.readContents.path, '/ty/api/report/config/item/content/batch');
  assert.equal(WRITE_CHANNELS.itemTree.path, '/ty/api/report/config/item/detail');
  assert.equal(WRITE_CHANNELS.reportList.path, '/ty/api/report/project');
  // 单节点锁，而不是整份报告锁——写回的最小粒度
  assert.match(WRITE_CHANNELS.lockAcquire.path, /report_config_item\/acquire\/\{projectId\}\/\{companyId\}\/\{itemId\}$/);
  assert.match(WRITE_CHANNELS.lockRelease.path, /report_config_item\/release\//);
});

test('保存 payload 与前端 content/save 的构造完全一致', () => {
  const content = {
    itemId: 900000000000003,
    itemType: 2,
    text: '{"type":"doc","content":[]}',
    rtfContent: { type: 'doc', content: [{ type: 'paragraph' }] },
    rtfContentEdit: '{"type":"doc","content":[]}',
    backup: '{}',
    name: '关于资产评估说明使用',
  };
  const payload = buildSavePayload({
    content,
    text: '{"type":"doc","content":[{"type":"paragraph"}]}',
    projectId: 110804796309505,
    companyId: 110804796309543,
  });

  // 前端明确 delete g.rtfContent —— 只发 text
  assert.equal('rtfContent' in payload, false);
  // text 被替换成本地改后的内容，而不是原样回传
  assert.equal(payload.text, '{"type":"doc","content":[{"type":"paragraph"}]}');
  assert.equal(payload.projectId, '110804796309505');
  assert.equal(payload.companyId, '110804796309543');
  // 其余字段原样保留（后端按整节点覆盖）
  assert.equal(payload.itemId, 900000000000003);
  assert.equal(payload.itemType, 2);
  assert.equal(payload.rtfContentEdit, '{"type":"doc","content":[]}');

  // 不改动入参
  assert.equal('rtfContent' in content, true);
});

test('保存 payload 拒绝缺失或类型不对的输入', () => {
  assert.throws(() => buildSavePayload({ text: '{}', projectId: 1, companyId: 2 }), /缺少节点原始内容/);
  assert.throws(() => buildSavePayload({ content: {}, projectId: 1, companyId: 2 }), /text 必须是 JSON 字符串/);
  assert.throws(
    () => buildSavePayload({ content: {}, text: '{}', companyId: 2 }),
    /缺少 projectId\/companyId/,
  );
});

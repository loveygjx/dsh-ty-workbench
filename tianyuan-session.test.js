import { test } from 'node:test';
import assert from 'node:assert/strict';

// 冻结 fetch，模拟天源响应，验证会话层行为
const calls = [];
let responder = async () => ({ status: 200, text: async () => '{"code":200,"data":[]}', headers: new Map([['content-type','application/json']]) });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return responder(url, opts); };

const mod = await import('./tianyuan-session.js');
const { setSession, clearSession, hasSession, tyApi, listReports, buildReport, downloadAttachmentRaw, TySessionError } = mod;

function jsonRes(body, status = 200) {
  return { status, text: async () => JSON.stringify(body), headers: new Map([['content-type','application/json']]) };
}

test('no session → tyApi rejects UNAUTHENTICATED without calling fetch', async () => {
  clearSession();
  calls.length = 0;
  await assert.rejects(() => tyApi('/ty/api/x'), e => e.code === 'UNAUTHENTICATED');
  assert.equal(calls.length, 0);
});

test('with session → cookie header carries tk+sid, listReports maps rows', async () => {
  setSession({ tk: 'TK1', sid: 'SID1', user: '测试' });
  calls.length = 0;
  responder = async () => jsonRes({ code: 200, data: [
    { id: 'r1', companyId: 'c1', companyName: '甲公司', reportType: 2, version: 17, jobState: 2, attachId: 'a1', createTime: '2026-11-19 10:00:00', createUserFullName: '林' },
    { id: 'r2', companyId: 'c2', companyName: '乙公司', reportType: 1, version: 12, jobState: 1, attachId: null, createTime: '', createUserFullName: '' },
  ]});
  const rows = await listReports('123');
  assert.equal(calls.length, 1);
  assert.match(calls[0].opts.headers.Cookie, /tk=TK1/);
  assert.match(calls[0].opts.headers.Cookie, /sid=SID1/);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { reportId:'r1', companyId:'c1', companyName:'甲公司', type:2, version:17, status:2, jobState:2, preferFlag:undefined, attachId:'a1', updatedAt:'2026-11-19 10:00:00', creator:'林', downloadable:true });
  assert.equal(rows[1].downloadable, false);
});

test('403 未登录 clears session and throws UNAUTHENTICATED', async () => {
  setSession({ tk: 'TK2' });
  responder = async () => jsonRes({ code: 403, msg: '未登录' });
  await assert.rejects(() => tyApi('/ty/api/x'), e => e.code === 'UNAUTHENTICATED');
  assert.equal(hasSession(), false);
});

test('buildReport ok returns jobId; non-200 throws BUILD_FAILED', async () => {
  setSession({ tk: 'TK3' });
  calls.length = 0;
  responder = async () => jsonRes({ code: 200, data: 999 });
  const r = await buildReport('P', 'C', 2);
  assert.equal(r.ok, true); assert.equal(r.jobId, 999);
  assert.match(calls[0].url, /report\/build\/P\/C\/2$/);
  assert.equal(calls[0].opts.method, 'POST');
  responder = async () => jsonRes({ code: 500, msg: '模板未配置' });
  await assert.rejects(() => buildReport('P','C',3), e => e.code === 'BUILD_FAILED');
});

test('downloadAttachmentRaw validates ZIP header and errors on JSON', async () => {
  setSession({ tk: 'TK4' });
  responder = async () => ({ status: 200, headers: new Map([['content-type','application/octet-stream']]), arrayBuffer: async () => new Uint8Array([0x50,0x4b,0x03,0x04,1,2,3]).buffer });
  const { buf } = await downloadAttachmentRaw('a1');
  assert.equal(buf.slice(0,2).toString('hex'), '504b');
  responder = async () => ({ status: 200, headers: new Map([['content-type','application/json']]), json: async () => ({ code: 500, msg: '无权限' }) });
  await assert.rejects(() => downloadAttachmentRaw('a2'), e => e.code === 'DOWNLOAD_FAILED');
  responder = async () => ({ status: 200, headers: new Map([['content-type','application/octet-stream']]), arrayBuffer: async () => new Uint8Array([1,2,3,4]).buffer });
  await assert.rejects(() => downloadAttachmentRaw('a3'), e => e.code === 'NOT_DOCX');
  clearSession();
});

test('validateDocx: real docx passes, plain text with ZIP header fails', async () => {
  const { readFile } = await import('node:fs/promises');
  const real = await readFile('/tmp/real.docx');
  const v1 = await mod.validateDocx(real);
  assert.equal(v1.ok, true);
  const fake = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('hello world plain text not zip')]);
  const v2 = await mod.validateDocx(fake);
  assert.equal(v2.ok, false);
});

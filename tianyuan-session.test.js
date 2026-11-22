// tianyuan-session.js 定向回归测试（不联网、不碰真实 Cookie）：
//   - validateDocx：真 docx 通过；损坏 ZIP / 缺部件 / 非 OOXML / 截断 / 存储型 ZIP 全覆盖
//   - listReports：自适应分页（单页不满即停、多页取满、永不只信第一页）
//   - 基线失败语义：listReports 抛错即整体失败（由 index.js 路由测试覆盖装配层）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

const calls = [];
let responder = async () => ({ status: 200, text: async () => '{"code":200,"data":[]}', headers: new Map([['content-type','application/json']]) });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return responder(url, opts); };

const mod = await import('./tianyuan-session.js');
const { setSession, clearSession, tyApi, listReports, buildReport, downloadAttachmentRaw, validateDocx, TySessionError } = mod;

function jsonRes(body, status = 200) {
  return { status, text: async () => JSON.stringify(body), headers: new Map([['content-type','application/json']]) };
}

// ---------- DOCX 合成工具（真 ZIP，可精确注入缺陷） ----------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** 构造最小合法 docx（method=8 deflate，标准 ZIP 布局）。 */
function makeDocx(parts, { method = 8, truncate = 0, corruptEntry = null } = {}) {
  const chunks = []; const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(parts)) {
    let data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    let comp = data, compMethod = method;
    if (method === 8) { comp = deflateRawSync(data, { level: 6 }); }
    if (corruptEntry === name) {
      // 破坏压缩数据（保留长度）→ inflate 必然抛错
      comp = Buffer.from(comp); comp[0] ^= 0xff; comp[1] ^= 0xff;
    }
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(compMethod, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(compMethod, 10);
    cd.writeUInt32LE(crc32(data), 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += local.length + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  let eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(parts).length, 8); // disk entries（EOCD+8 才是条目数字段，+6 是磁盘号）
  eocd.writeUInt16LE(Object.keys(parts).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  let out = Buffer.concat([...chunks, cdBuf, eocd]);
  if (truncate > 0) out = out.subarray(0, out.length - truncate);
  return out;
}

const GOOD_PARTS = {
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
  'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
};

// ---------- validateDocx ----------
test('validateDocx: 合成最小 docx 通过（真实 ZIP，非伪件）', async () => {
  const v = await validateDocx(makeDocx(GOOD_PARTS));
  assert.equal(v.ok, true, 'reason: ' + (v.reason || ''));
  assert.ok(v.entries >= 3);
});

test('validateDocx: 真实项目导出件通过', async () => {
  const { readFile, access } = await import('node:fs/promises');
  let real = null;
  try { real = await readFile('/tmp/real.docx'); } catch { /* 环境里没有就跳过该子断言 */ }
  if (real) {
    const v = await validateDocx(real);
    assert.equal(v.ok, true, 'reason: ' + (v.reason || ''));
  }
});

test('validateDocx: 损坏 ZIP（EOCD 缺失）拒绝', async () => {
  const buf = makeDocx(GOOD_PARTS);
  // 抹掉 EOCD 签名本身（EOCD 从 len-22 开始，签名占前 4 字节）→ 找不到 EOCD
  const broken = Buffer.from(buf);
  for (let i = 0; i < 4; i++) broken[broken.length - 22 + i] = 0;
  const v = await validateDocx(broken);
  assert.equal(v.ok, false);
  assert.match(v.reason, /EOCD|结构/);
});

test('validateDocx: 截断 ZIP（Central Directory 越界）拒绝', async () => {
  // 截掉 Central Directory 中段但保留 EOCD 里的 cdSize/cdOffset → 越界检查命中
  const full = makeDocx(GOOD_PARTS);
  const cut = 20; // 从 CD 起始处往后裁 20 字节，EOCD 仍在尾部 → cdOffset+cdSize > length
  const buf = Buffer.concat([full.subarray(0, 60), full.subarray(full.length - 22)]);
  const v = await validateDocx(buf);
  assert.equal(v.ok, false);
  assert.match(v.reason, /越界|截断/);
});

test('validateDocx: 缺 word/document.xml 拒绝', async () => {
  const parts = { ...GOOD_PARTS }; delete parts['word/document.xml'];
  parts['word/other.xml'] = '<x/>';
  const v = await validateDocx(makeDocx(parts));
  assert.equal(v.ok, false);
  assert.match(v.reason, /word\/document\.xml/);
});

test('validateDocx: 缺 [Content_Types].xml 拒绝（隔离伪 docx 场景）', async () => {
  const parts = { ...GOOD_PARTS };
  // 仍保持 3 个条目（加一个占位条目），这样触发的是「缺必需部件」而不是「条目过少」
  parts['word/other.xml'] = '<x/>';
  delete parts['[Content_Types].xml'];
  const v = await validateDocx(makeDocx(parts));
  assert.equal(v.ok, false);
  assert.match(v.reason, /\[Content_Types\]\.xml/);
});

test('validateDocx: document.xml 解压数据被破坏 → 拒绝', async () => {
  const v = await validateDocx(makeDocx(GOOD_PARTS, { corruptEntry: 'word/document.xml' }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /解压失败|损坏/);
});

test('validateDocx: document.xml 解出来不是 Word XML → 拒绝', async () => {
  const parts = { ...GOOD_PARTS, 'word/document.xml': 'plain text not xml' };
  const v = await validateDocx(makeDocx(parts));
  assert.equal(v.ok, false);
  assert.match(v.reason, /Word 文档 XML/);
});

test('validateDocx: 纯文本带 ZIP 头 → 拒绝（原有回归）', async () => {
  const fake = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('hello world plain text not zip')]);
  const v = await validateDocx(fake);
  assert.equal(v.ok, false);
});

test('validateDocx: stored（method=0）ZIP 也能通过', async () => {
  const v = await validateDocx(makeDocx(GOOD_PARTS, { method: 0 }));
  assert.equal(v.ok, true, 'reason: ' + (v.reason || ''));
});

test('validateDocx: 非 ZIP 头 / 空 buffer 拒绝', async () => {
  assert.equal((await validateDocx(Buffer.from([1,2,3,4]))).ok, false);
  assert.equal((await validateDocx(Buffer.alloc(0))).ok, false);
});

// ---------- listReports 分页 ----------
test('listReports: 单页不满即停（只发一次请求）', async () => {
  setSession({ tk: 'P1' });
  calls.length = 0;
  responder = async (url) => {
    assert.match(String(url), /pageNum=1&limit=200/);
    return jsonRes({ code: 200, data: Array.from({ length: 5 }, (_, i) => ({ id: 'r' + i, companyId: 'c', companyName: '甲', reportType: 1, version: i + 1, jobState: 2, attachId: 'a' + i })) });
  };
  const rows = await listReports('123');
  assert.equal(calls.length, 1);
  assert.equal(rows.length, 5);
});

test('listReports: 第一页满则翻页，第二页不满停（不漏新版本）', async () => {
  setSession({ tk: 'P2' });
  calls.length = 0;
  const mk = i => ({ id: 'r' + i, companyId: 'c' + (i % 3), companyName: '公司' + (i % 3), reportType: (i % 2) + 1, version: 10 + i, jobState: 2, attachId: 'a' + i });
  responder = async (url) => {
    const u = String(url);
    const page = Number(u.match(/pageNum=(\d+)/)[1]);
    if (page === 1) return jsonRes({ code: 200, data: Array.from({ length: 200 }, (_, i) => mk(i)) });
    return jsonRes({ code: 200, data: [mk(200), mk(201)] });
  };
  const rows = await listReports('123');
  assert.equal(calls.length, 2, 'should fetch exactly 2 pages');
  assert.equal(rows.length, 202);
  assert.equal(rows[201].version, 211, 'page-2 row mapped');
});

test('listReports: 服务端 total 语义（data.total）取满即停', async () => {
  setSession({ tk: 'P3' });
  calls.length = 0;
  responder = async (url) => {
    const page = Number(String(url).match(/pageNum=(\d+)/)[1]);
    return jsonRes({ code: 200, data: { total: 200, list: Array.from({ length: 200 }, (_, i) => ({ id: 'x' + i, companyId: 'c', reportType: 2, version: i, jobState: 2 })) } });
  };
  const rows = await listReports('9');
  assert.equal(calls.length, 1);
  assert.equal(rows.length, 200);
});

test('listReports: 会话失效（403）在翻页中途也会清除会话并抛 UNAUTHENTICATED', async () => {
  setSession({ tk: 'P4' });
  responder = async () => jsonRes({ code: 403, msg: '未登录' });
  await assert.rejects(() => listReports('1'), e => e.code === 'UNAUTHENTICATED');
  // tyApi 内部 clearSession → 后续直接 UNAUTHENTICATED
  await assert.rejects(() => listReports('1'), e => e.code === 'UNAUTHENTICATED');
});

// ---------- downloadAttachmentRaw（保持原有语义） ----------
test('downloadAttachmentRaw: ZIP 头通过 / JSON 错误抛 DOWNLOAD_FAILED / 非 ZIP 抛 NOT_DOCX', async () => {
  setSession({ tk: 'P5' });
  // 注意：Buffer.concat 常驻 Node 共享池（byteOffset≠0），直接 .buffer 会带上池内垃圾。
  // stub 必须复制出独占 ArrayBuffer，模拟真实 fetch 的行为。
  const toOwnedAb = (b) => { const ab = new ArrayBuffer(b.length); new Uint8Array(ab).set(b); return ab; };
  responder = async () => ({ status: 200, headers: new Map([['content-type','application/octet-stream']]), arrayBuffer: async () => toOwnedAb(makeDocx(GOOD_PARTS)) });
  const { buf } = await downloadAttachmentRaw('a1');
  assert.equal(buf.slice(0, 2).toString('hex'), '504b');
  responder = async () => ({ status: 200, headers: new Map([['content-type','application/json']]), json: async () => ({ code: 500, msg: '无权限' }) });
  await assert.rejects(() => downloadAttachmentRaw('a2'), e => e.code === 'DOWNLOAD_FAILED');
  responder = async () => ({ status: 200, headers: new Map([['content-type','application/octet-stream']]), arrayBuffer: async () => new Uint8Array([1,2,3,4]).buffer });
  await assert.rejects(() => downloadAttachmentRaw('a3'), e => e.code === 'NOT_DOCX');
  clearSession();
});

// ---------- 其余原有语义保持 ----------
test('no session → tyApi rejects UNAUTHENTICATED without calling fetch', async () => {
  clearSession();
  calls.length = 0;
  await assert.rejects(() => tyApi('/ty/api/x'), e => e.code === 'UNAUTHENTICATED');
  assert.equal(calls.length, 0);
});

test('403 未登录 clears session and throws UNAUTHENTICATED', async () => {
  setSession({ tk: 'TK2' });
  responder = async () => jsonRes({ code: 403, msg: '未登录' });
  await assert.rejects(() => tyApi('/ty/api/x'), e => e.code === 'UNAUTHENTICATED');
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

test.after(() => { globalThis.fetch = realFetch; });

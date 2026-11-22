import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { openShell } from './opener.js';
import { join, extname, basename, dirname, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

/**
 * 评估文件库（本地归档库）读取层。
 *
 * 库结构：D:\天源评估\已归档\{2024年|2025年|2026年}\{受理号} {项目名称}\{分类}\...
 * 索引：  D:\天源评估\已归档\_索引库\projects_index.json
 * 知识库：D:\天源评估\已归档\_知识库\kb_index.jsonl + texts\*.txt
 */

// macOS 移植：默认归档根按平台区分，非 Windows 落在用户目录下。
const ROOT = process.env.DSH_VALUATION_LIB
  || (process.platform === 'win32' ? 'D:\\天源评估\\已归档' : join(homedir(), 'Documents', '天源评估', '已归档'));
const IDX_JSON = join(ROOT, '_索引库', 'projects_index.json');
const KB_DIR = join(ROOT, '_知识库');
const KB_INDEX = join(KB_DIR, 'kb_index.jsonl');

let cache = { at: 0, index: null, kb: null, kbAt: 0 };
const CACHE_MS = 15000;
/** 正文 LRU 缓存（约 1500 篇）：检索时同一批文件会被反复读，缓存后命中率高得多 */
const textCache = new Map();

// macOS 移植：原实现把 / 一律转成 \（Windows 口径）。非 Windows 下反转为
// 「\ → /」，这样从 Windows 机器带过来的索引里用反斜杠写的相对路径也能落到真实文件。
function normPath(p) {
  const s = String(p || '');
  return process.platform === 'win32' ? s.replace(/\//g, '\\') : s.replace(/\\/g, '/');
}

/** 去掉结尾的一个或多个分隔符 */
function stripSep(p) {
  return String(p || '').replace(/[\\/]+$/, '');
}

/** 库根（去掉结尾分隔符）；所有越界判断都基于它 */
const ROOT_ABS = stripSep(normPath(ROOT));

function withinRoot(abs) {
  const a = stripSep(normPath(abs)).toLowerCase();
  const r = ROOT_ABS.toLowerCase();
  return a === r || a.startsWith(r + sep);
}

/**
 * 把调用方给的路径统一成「库内绝对路径」。
 *
 * 两边的写法不一样，必须都接住：
 *  - 相对路径（'2025年\1000106074 融通煤业债转股评估'）→ 拼到库根；
 *  - 绝对路径（项目列表里 projects() 返回的 dir 就是绝对路径）→ 原样使用。
 * 以前 openPath() 直接 join(ROOT, rel)，前端把绝对 dir 传进来就会拼成
 * 「D:\天源评估\已归档\D:\天源评估\已归档\2025年\...」这种重复路径，
 * 于是 existsSync 必然失败、界面弹「打开失败：文件不存在」。
 *
 * 越界（落在库根之外）返回 null，由调用方拒绝。
 */
export function resolveLibPath(p) {
  const raw = String(p || '').trim();
  if (!raw) return ROOT_ABS;
  const abs = resolve(ROOT_ABS, normPath(raw));
  return withinRoot(abs) ? abs : null;
}

export async function getIndex(force) {
  const now = Date.now();
  if (!force && cache.index && now - cache.at < CACHE_MS) return cache.index;
  try {
    const raw = await readFile(IDX_JSON, 'utf8');
    cache.index = JSON.parse(raw);
    cache.at = now;
    return cache.index;
  } catch (e) {
    return { projects: [], files: [], error: '索引不存在：' + IDX_JSON };
  }
}

export async function getKb(force) {
  const now = Date.now();
  if (!force && cache.kb && now - cache.kbAt < CACHE_MS) return cache.kb;
  const rows = [];
  try {
    const raw = await readFile(KB_INDEX, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch (e) {}
    }
  } catch (e) {}
  cache.kb = rows;
  cache.kbAt = now;
  return rows;
}

export function rootPath() { return ROOT; }

/** 知识库全部记录（给扫描器重建项目索引时用；走同一份缓存） */
export async function kbRows(force) { return getKb(force); }

/** 扫描完成后清缓存：下次 overview/projects/search 直接读新索引 */
export function refresh() {
  cache = { at: 0, index: null, kb: null, kbAt: 0 };
  textCache.clear();
}

/** 列出某目录（库内；相对库根或绝对路径都可以） */
export async function listDir(rel) {
  const abs = resolveLibPath(rel);
  if (!abs) return { error: '路径越界' };
  const out = [];
  let entries = [];
  try { entries = await readdir(abs, { withFileTypes: true }); } catch (e) { return { error: '目录不可读：' + e.message }; }
  for (const d of entries) {
    if (d.name.startsWith('.')) continue;
    const full = join(abs, d.name);
    let st = null;
    try { st = await stat(full); } catch (e) {}
    out.push({
      name: d.name,
      dir: d.isDirectory(),
      size: d.isDirectory() ? null : (st ? st.size : null),
      mtime: st ? st.mtimeMs : null,
      ext: d.isDirectory() ? '' : extname(d.name).toLowerCase(),
    });
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh') : a.dir ? -1 : 1));
  return { path: relative(ROOT_ABS, abs) || '', abs, items: out };
}

/** 概览：按年份/项目统计 */
export async function overview() {
  const idx = await getIndex();
  const kb = await getKb();
  // 只统计「磁盘上真的有文件」的项目：空目录不再进索引，
  // 这里再兜一层，避免旧索引里的空项目把项目数/源端文件数算进去。
  const projs = (idx.projects || []).filter(p => (p.localFiles || 0) > 0);
  const byYear = {};
  for (const p of projs) {
    const y = p.year || '未知';
    byYear[y] = byYear[y] || { year: y, projects: 0, files: 0, bytes: 0, sourceFiles: 0 };
    byYear[y].projects += 1;
    byYear[y].files += p.localFiles || 0;
    byYear[y].bytes += p.localBytes || 0;
    byYear[y].sourceFiles += p.totalFiles || 0;
  }
  const textDocs = kb.filter(r => r.text).length;
  const scanned = kb.filter(r => r.scanned).length;
  return {
    root: ROOT,
    projects: projs.length,
    sourceFiles: projs.reduce((n, p) => n + (p.totalFiles || 0), 0),
    localFiles: projs.reduce((n, p) => n + (p.localFiles || 0), 0),
    localBytes: projs.reduce((n, p) => n + (p.localBytes || 0), 0),
    kbDocs: kb.length,
    kbTextDocs: textDocs,
    kbScanned: scanned,
    kbOcr: kb.filter(r => r.ocr).length,
    kbChars: kb.reduce((n, r) => n + (r.chars || 0), 0),
    generatedAt: idx.generatedAt,
    lastScanAt: (idx.scanner && idx.scanner.lastScanAt) || null,
    lastScan: (idx.scanner && idx.scanner.lastScanStats) || null,
    diskOnlyProjects: projs.filter(p => p.origin === 'disk').length,
    byYear: Object.values(byYear).sort((a, b) => a.year.localeCompare(b.year)),
  };
}

/** 项目列表（可按年份/关键词过滤） */
export async function projects(q) {
  const idx = await getIndex();
  const kw = String(q || '').trim().toLowerCase();
  // 没有本地文件的项目（旧版「待归档」）不展示，见 overview() 的说明
  let list = (idx.projects || []).filter(p => (p.localFiles || 0) > 0);
  if (kw) {
    list = list.filter(p => [p.name, p.acceptanceNo, p.client, p.manager, p.partner, p.reportNo, p.year]
      .some(v => String(v || '').toLowerCase().includes(kw)));
  }
  return list.map(p => ({
    year: p.year, acceptanceNo: p.acceptanceNo, name: p.name, status: p.status,
    createdAt: p.createdAt, manager: p.manager, partner: p.partner, dept: p.dept,
    client: p.client, reportNo: p.reportNo, purpose: p.evaluationPurpose, valueType: p.valueType,
    target: p.target, counts: p.counts, totalFiles: p.totalFiles, prjId: p.prjId,
    dir: p.dir, localFiles: p.localFiles, localBytes: p.localBytes,
  }));
}

/** 不限层数时的条目上限：防止某个项目塞了上万张图把响应拖死 */
const OUT_LIMIT = 20000;

/**
 * 某项目下的文件树。
 *
 * depth：省略 / 0 / 负数 = **不限制层数**（一直展开到末级文件）；正数 = 只展开到该层。
 * 归档目录实际有 6 层上下（项目\02 电子底稿\2-底稿\1-股权评估底稿\2-实物资产\设备询价\1.png），
 * 以前前端写死 depth=4、后端还夹在 6 以内，末级文件走不到，界面上只能看到中间几层文件夹。
 *
 * 不限层数时用 OUT_LIMIT 兜底：命中上限置 truncated，界面据此提示「未完全展开」。
 */
export async function projectFiles(dirRel, depth) {
  const want = Number(depth);
  const maxDepth = Number.isFinite(want) && want > 0 ? Math.min(64, Math.floor(want)) : Infinity;
  const absBase = resolveLibPath(dirRel);
  if (!absBase) return { error: '路径越界' };
  const base = relative(ROOT_ABS, absBase);
  const out = [];
  let truncated = false;

  async function walk(rel, level) {
    if (level > maxDepth) return;
    let entries = [];
    try { entries = await readdir(join(ROOT_ABS, rel), { withFileTypes: true }); } catch (e) { return; }
    const kids = [];
    for (const d of entries) {
      if (d.name.startsWith('.')) continue;
      const r = join(rel, d.name);
      const isDir = d.isDirectory();
      let st = null;
      // 目录不 stat：mtime 界面上用不到，少一次系统调用，深目录树快很多
      if (!isDir) { try { st = await stat(join(ROOT_ABS, r)); } catch (e) {} }
      kids.push({
        path: r, name: d.name, dir: isDir, level,
        size: isDir ? null : (st ? st.size : null),
        mtime: st ? st.mtimeMs : null,
        ext: isDir ? '' : extname(d.name).toLowerCase(),
      });
    }
    // 同层内「文件夹在前、文件在后」并按中文名排序：子目录紧跟它的父目录，
    // 深树的层级关系一眼能看清（readdir 原顺序是乱序的）
    kids.sort((a, b) => (a.dir === b.dir
      ? a.name.localeCompare(b.name, 'zh', { numeric: true })
      : a.dir ? -1 : 1));
    for (const it of kids) {
      if (out.length >= OUT_LIMIT) { truncated = true; return; }
      out.push(it);
      if (it.dir) await walk(it.path, level + 1);
    }
  }

  await walk(base, 1);
  return {
    path: base, items: out, truncated, limit: OUT_LIMIT,
    dirs: out.filter(i => i.dir).length,
    files: out.filter(i => !i.dir).length,
  };
}

/**
 * 知识库检索：文件名/项目/正文关键词。
 * 返回命中的文件 + 正文片段。
 */
/** 正文 LRU 缓存：检索时同一批文件会被反复读，缓存后命中率高得多 */
const TEXT_CACHE_MAX = 1500;

async function readTextCached(textFile) {
  const key = textFile;
  if (textCache.has(key)) {
    const v = textCache.get(key);
    textCache.delete(key); textCache.set(key, v);   // 触碰即提到最新
    return v;
  }
  let txt = null;
  try { txt = await readFile(join(KB_DIR, 'texts', textFile), 'utf8'); } catch (e) { txt = null; }
  if (txt != null) {
    textCache.set(key, txt);
    if (textCache.size > TEXT_CACHE_MAX) {
      const oldest = textCache.keys().next().value;
      textCache.delete(oldest);
    }
  }
  return txt;
}

export async function search(q, opts) {
  const kw = String(q || '').trim();
  if (!kw) return { total: 0, hits: [] };
  const limit = Math.max(1, Math.min(200, (opts && opts.limit) || 30));
  const kb = await getKb();
  const lower = kw.toLowerCase();
  const hits = [];
  let scanned = 0;
  // 先扫元数据（快），元数据没命中的再读正文（慢）；正文用缓存并并发读。
  const needText = [];
  for (const r of kb) {
    // 有 Word 版顶替的 PDF / 装订版重复副本：文件还在（浏览页能看到），但不参与检索
    if (r.shadow) continue;
    scanned += 1;
    const meta = [r.project, r.file, r.subdir, r.year].join(' ').toLowerCase();
    if (meta.includes(lower)) {
      hits.push({
        rel: r.rel, project: r.project, subdir: r.subdir, file: r.file, year: r.year,
        size: r.size, ext: r.ext, where: 'name', snippet: '', chars: r.chars || 0,
        scanned: !!r.scanned, abs: join(ROOT, normPath(r.rel)),
      });
      if (hits.length >= limit) return { total: hits.length, scannedDocs: scanned, keyword: kw, hits };
    } else if (r.text && r.textFile) {
      needText.push(r);
    }
  }
  // 正文匹配：分批并发，避免一次性读上千个文件
  const BATCH = 60;
  for (let i = 0; i < needText.length && hits.length < limit; i += BATCH) {
    const batch = needText.slice(i, i + BATCH);
    const found = await Promise.all(batch.map(async (r) => {
      const txt = await readTextCached(r.textFile);
      if (!txt) return null;
      const idx = txt.toLowerCase().indexOf(lower);
      if (idx < 0) return null;
      return {
        rel: r.rel, project: r.project, subdir: r.subdir, file: r.file, year: r.year,
        size: r.size, ext: r.ext, where: 'content',
        snippet: txt.slice(Math.max(0, idx - 80), idx + 160).replace(/\s+/g, ' '),
        chars: r.chars || 0, scanned: !!r.scanned, abs: join(ROOT, normPath(r.rel)),
      };
    }));
    for (const f of found) {
      if (f && hits.length < limit) hits.push(f);
    }
  }
  return { total: hits.length, scannedDocs: scanned, keyword: kw, hits };
}

/** 读正文（给检索结果做预览/全文） */
export async function docText(rel, maxChars) {
  const kb = await getKb();
  const key = normPath(rel);
  const hit = kb.find(r => normPath(r.rel) === key);
  if (!hit) return { error: '该文件不在知识库索引中（可能是图片或未抽取类型）' };
  if (!hit.text || !hit.textFile) return { meta: hit, text: '', note: hit.scanned ? 'PDF 为扫描件，未含文字层' : (hit.note || '无可抽取文本') };
  const txt = await readFile(join(KB_DIR, 'texts', hit.textFile), 'utf8');
  const cap = Math.max(1000, Math.min(200000, maxChars || 20000));
  return { meta: hit, text: txt.slice(0, cap), truncated: txt.length > cap, totalChars: txt.length };
}

/** 用系统默认程序打开库内文件或所在目录（rel 可以是相对库根的路径，也可以是绝对路径） */
export async function openPath(rel, revealOnly) {
  const abs = resolveLibPath(rel);
  if (!abs) return { ok: false, error: '路径越界' };
  if (!existsSync(abs)) return { ok: false, error: '文件不存在：' + abs };
  // 不传 windowsHide：否则资源管理器窗口会以隐藏状态创建（详见 opener.js 顶部说明）
  const r = await openShell(abs, !!revealOnly);
  if (!r.ok) return { ok: false, error: r.error || '打开失败', abs };
  return { ok: true, abs, revealed: !!revealOnly };
}

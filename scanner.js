/**
 * 归档库扫描调度（宿主半侧）。
 *
 * 职责：
 *  1. 启动 python scan_kb.py，把它的 JSONL 进度转成内存状态供浏览器轮询；
 *  2. 扫描结束后重建 `_索引库/projects_index.json`（把「磁盘上新增/删除的项目」同步进项目列表）；
 *  3. 让 library.js 的缓存失效，界面立刻能看到新数据。
 *
 * 为什么重建 JSON 索引要放在 Node 而不是 python 里：
 *  projects_index.json 同时含「天源爬取到的项目元数据」（状态/委托方/报告号/源端挂档数）和
 *  「磁盘实际情况」（本地文件数/体积/目录）。前者是历史资产，不能让一次扫描抹掉，
 *  所以在这里按「年份 + 受理号」把它和磁盘聚合结果合并。
 */
import { spawn } from 'node:child_process';
import { readFile, readdir, stat, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import * as lib from './library.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'scan_kb.py');

const CATS = [
  ['01', '取数表', '01 取数表'],
  ['02', '电子底稿', '02 电子底稿'],
  ['03', '纸质报告、合同扫描', '03 纸质报告、合同扫描'],
  ['04', '装订版报告', '04 装订版报告'],
];

/** 扫描状态（单例：同一时刻只允许一个扫描任务） */
const S = {
  running: false,
  id: 0,
  startedAt: null,
  endedAt: null,
  mode: 'quick',
  ocr: false,
  phase: 'idle',      // idle | walking | extracting | ocr | xlsx | indexing | done | error
  progress: { done: 0, total: 0, ok: 0, skip: 0, fail: 0 },
  walk: null,
  dedupe: null,        // Word 优先：本次跳过多少个 PDF / 装订版副本
  ocrProgress: null,
  events: [],          // 最近若干条进度事件（含文件名），供界面滚动展示
  newProjects: [],     // 本次扫描新发现的项目
  removedProjects: [], // 索引里有、磁盘上已不见的项目
  result: null,
  error: null,
  pid: null,
};

const EVENTS_MAX = 200;

function pushEvent(ev) {
  S.events.push(ev);
  if (S.events.length > EVENTS_MAX) S.events.splice(0, S.events.length - EVENTS_MAX);
}

export function status() {
  return {
    running: S.running,
    id: S.id,
    startedAt: S.startedAt,
    endedAt: S.endedAt,
    mode: S.mode,
    ocr: S.ocr,
    phase: S.phase,
    progress: S.progress,
    walk: S.walk,
    ocrProgress: S.ocrProgress,
    events: S.events.slice(-40),
    newProjects: S.newProjects,
    removedProjects: S.removedProjects,
    result: S.result,
    error: S.error,
    root: lib.rootPath(),
    script: SCRIPT,
  };
}

/** 找一个可用的 python：优先环境变量，其次 python / py / python3 */
function findPython() {
  const cands = [];
  if (process.env.DSH_PYTHON) cands.push({ cmd: process.env.DSH_PYTHON, pre: [] });
  // macOS 移植：优先工作台专用 venv（PyYAML/PyMuPDF 等装在这里），
  // 否则系统 python3 缺依赖会报「扫描脚本退出码 1」。
  cands.push({
    cmd: join(homedir(), '.dsh', 'workbench-venv',
      ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python3'])),
    pre: [],
  });
  if (process.platform === 'win32') cands.push({ cmd: 'py', pre: ['-3'] });
  cands.push({ cmd: 'python3', pre: [] });
  cands.push({ cmd: 'python', pre: [] });
  return cands;
}

async function pythonWorks(cand) {
  return new Promise(resolve => {
    let done = false;
    const finish = ok => { if (!done) { done = true; resolve(ok); } };
    try {
      const p = spawn(cand.cmd, [...cand.pre, '-c', 'import sys;print(sys.version_info[0])'], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out = '';
      p.stdout.on('data', d => { out += d.toString(); });
      p.on('error', () => finish(false));
      p.on('close', code => finish(code === 0 && out.trim() === '3'));
      setTimeout(() => { try { p.kill(); } catch (e) {} finish(false); }, 4000);
    } catch (e) { finish(false); }
  });
}

async function resolvePython() {
  for (const c of findPython()) {
    if (await pythonWorks(c)) return c;
  }
  return null;
}

// ------------------------------------------------------------ 项目聚合

function parseFolder(name) {
  const m = String(name || '').match(/^(\d{5,})[\s_\-—]*(.*)$/);
  if (!m) return { acceptanceNo: '', name: String(name || '') };
  return { acceptanceNo: m[1], name: m[2].trim() || String(name) };
}

function catOf(subdir) {
  const head = String(subdir || '').split(/[\\/]/)[0];
  for (const [code, cat] of CATS) if (head.startsWith(code)) return cat;
  return '其他';
}

async function listDirs(dir) {
  try {
    const ents = await readdir(dir, { withFileTypes: true });
    return ents.filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_')).map(e => e.name).sort();
  } catch (e) { return []; }
}

async function dirStats(abs) {
  let files = 0, bytes = 0, newest = 0;
  async function walk(p) {
    let ents = [];
    try { ents = await readdir(p, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name.startsWith('~$')) continue;
      const full = join(p, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        try {
          const st = await stat(full);
          files += 1; bytes += st.size;
          if (st.mtimeMs > newest) newest = st.mtimeMs;
        } catch (e2) {}
      }
    }
  }
  await walk(abs);
  return { files, bytes, newest };
}

/** 由知识库记录 + 磁盘目录重建项目列表，并保留已有爬取元数据 */
export async function rebuildProjectIndex(root, kbRows, scannedAt) {
  const oldPath = join(root, '_索引库', 'projects_index.json');
  let old = null;
  try { old = JSON.parse(await readFile(oldPath, 'utf8')); } catch (e) { old = null; }

  const crawlByKey = new Map();
  for (const p of (old && old.projects) || []) {
    // 上一轮就标成 disk 的项目没有爬取元数据，不能反过来冒充「有元数据」
    if (p.origin === 'disk') continue;
    crawlByKey.set(`${p.year || ''}|${p.acceptanceNo || ''}`, p);
  }

  // 知识库记录按 (年份, 项目目录) 聚合
  const agg = new Map();
  for (const r of kbRows) {
    const key = `${r.year || ''}|${r.project || ''}`;
    let a = agg.get(key);
    if (!a) { a = { year: r.year || '', folder: r.project || '', files: 0, bytes: 0, counts: {}, newest: 0 }; agg.set(key, a); }
    a.files += 1;
    a.bytes += r.size || 0;
    if ((r.mtime || 0) > a.newest) a.newest = r.mtime || 0;
    const c = catOf(r.subdir);
    a.counts[c] = (a.counts[c] || 0) + 1;
  }

  // 只有「磁盘上真的有文件」的项目才算项目。
  // 以前这里会把还没放文件的空目录也列出来（界面显示「待归档」），但空目录既不能浏览
  // 也不能检索，反而让项目数、源端挂档数虚高，所以现在直接不收。
  // 用户在磁盘上新建目录后，只要放进了文件，下一次扫描就会自动建档。
  const projects = [];
  const seen = new Set();
  for (const [, a] of agg) {
    const key = `${a.year}|${a.folder}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const parsed = parseFolder(a.folder);
    const meta = crawlByKey.get(`${a.year}|${parsed.acceptanceNo}`) || null;
    const counts = {};
    for (const [, cat] of CATS) counts[cat] = a.counts[cat] || 0;
    counts['其他'] = a.counts['其他'] || 0;
    projects.push({
      year: a.year,
      acceptanceNo: (meta && meta.acceptanceNo) || parsed.acceptanceNo,
      name: (meta && meta.name) || parsed.name || a.folder,
      status: (meta && meta.status) || '',
      createdAt: (meta && meta.createdAt) || '',
      manager: (meta && meta.manager) || '',
      partner: (meta && meta.partner) || '',
      dept: (meta && meta.dept) || '',
      client: (meta && meta.client) || '',
      reportNo: (meta && meta.reportNo) || '',
      purpose: (meta && meta.purpose) || '',
      valueType: (meta && meta.valueType) || '',
      target: (meta && meta.target) || '',
      counts,
      totalFiles: (meta && meta.totalFiles) || 0,
      prjId: (meta && meta.prjId) || '',
      dir: join(root, a.year, a.folder),
      folder: a.folder,
      localFiles: a.files,
      localBytes: a.bytes,
      localMtime: a.newest,
      origin: meta ? 'crawl' : 'disk',
    });
  }

  projects.sort((x, y) => (x.year === y.year ? String(x.folder).localeCompare(String(y.folder), 'zh') : String(x.year).localeCompare(String(y.year))));

  // 对比出「新增项目」「消失的项目」：要赶在写 payload 之前算好，
  // 否则 scanner.lastScanStats 里没有这两个数字（概览页会显示 0）。
  const oldKeys = new Set(((old && old.projects) || []).map(p => `${p.year || ''}|${p.acceptanceNo || ''}`));
  const newKeys = new Set(projects.map(p => `${p.year}|${p.acceptanceNo}`));
  const added = projects
    .filter(p => !oldKeys.has(`${p.year}|${p.acceptanceNo}`))
    .map(p => ({ year: p.year, name: p.name, acceptanceNo: p.acceptanceNo, localFiles: p.localFiles, origin: p.origin }));
  const removed = ((old && old.projects) || [])
    .filter(p => !newKeys.has(`${p.year || ''}|${p.acceptanceNo || ''}`))
    .map(p => ({ year: p.year, name: p.name, acceptanceNo: p.acceptanceNo }));

  const textDocs = kbRows.filter(r => r.text).length;
  // 源端挂档记录（old.files）同样要跟项目走：项目目录从磁盘上删掉以后，
  // 它在天源侧的挂档清单不能继续留在索引里，否则「源端文件数」永远清不掉。
  const projectKeys = new Set(projects.map(p => `${p.year}|${p.acceptanceNo}`));
  const sourceFiles = ((old && old.files) || [])
    .filter(f => projectKeys.has(`${f.year || ''}|${f.acceptanceNo || ''}`));
  const payload = {
    generatedAt: new Date().toISOString().slice(0, 19),
    root,
    projectCount: projects.length,
    fileCount: kbRows.length,
    sourceFileCount: sourceFiles.length,
    projects,
    files: sourceFiles,
    kb: {
      files: kbRows.length,
      withText: textDocs,
      ocr: kbRows.filter(r => r.ocr).length,
      scanned: kbRows.filter(r => r.scanned).length,
      chars: kbRows.reduce((n, r) => n + (r.chars || 0), 0),
    },
    scanner: {
      lastScanAt: scannedAt || S.endedAt || S.startedAt || null,
      lastScanMode: S.mode,
      // 这里必须带上 newProjects/removedProjects：概览页「上次扫描」卡片读的就是它，
      // 而 added/removed 是在本函数里算出来的，不能等函数返回后再补。
      lastScanStats: { ...(S.result || {}), newProjects: added.length, removedProjects: removed.length },
    },
  };
  await mkdir(dirname(oldPath), { recursive: true });
  const tmp = oldPath + '.tmp';
  await writeFile(tmp, JSON.stringify(payload, null, 1), 'utf8');
  await rename(tmp, oldPath);

  return { payload, added, removed };
}

// ------------------------------------------------------------ 扫描主流程

async function readKbRows(root) {
  const p = join(root, '_知识库', 'kb_index.jsonl');
  const rows = [];
  let raw = '';
  try { raw = await readFile(p, 'utf8'); } catch (e) { return rows; }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch (e) {}
  }
  return rows;
}

/**
 * 启动一次扫描。返回 {ok, id} 或 {ok:false, error}。
 * 同一时刻只允许一个；重复调用返回当前任务 id。
 */
export async function startScan(opts) {
  const o = opts || {};
  if (S.running) return { ok: true, already: true, id: S.id, status: status() };

  const py = await resolvePython();
  if (!py) {
    return { ok: false, error: '未找到可用的 Python 3（可设置环境变量 DSH_PYTHON 指向 python.exe）' };
  }
  if (!existsSync(SCRIPT)) return { ok: false, error: '扫描脚本缺失：' + SCRIPT };

  S.running = true;
  S.id += 1;
  const myId = S.id;
  S.startedAt = new Date().toISOString();
  S.endedAt = null;
  S.mode = o.full ? 'full' : 'quick';
  S.ocr = !!o.ocr;
  S.phase = 'walking';
  S.progress = { done: 0, total: 0, ok: 0, skip: 0, fail: 0 };
  S.walk = null;
  S.ocrProgress = null;
  S.events = [];
  S.newProjects = [];
  S.removedProjects = [];
  S.result = null;
  S.error = null;

  const args = [SCRIPT, '--root', lib.rootPath(), '--mode', S.mode];
  if (S.ocr) args.push('--ocr', '--ocr-limit', String(Math.max(0, Math.min(500, Number(o.ocrLimit) || 20))));
  if (o.rebuild) args.push('--rebuild');
  // Word 优先：报告/说明有 Word 版就不再解析对应 PDF，装订版副本不重复入库（默认开）
  if (o.wordFirst === false) args.push('--no-word-first');

  const child = spawn(py.cmd, [...py.pre, ...args], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
  });
  S.pid = child.pid;

  let buf = '';
  let stderrTail = '';
  child.stdout.on('data', chunk => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch (e) { pushEvent({ ev: 'log', text: line.slice(0, 300) }); continue; }
      handleEvent(ev);
    }
  });
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
  });

  // 立即返回，不阻塞 HTTP 请求：扫描可能跑几分钟，浏览器要的是轮询进度。
  // 结束后的重建索引在后台异步完成，期间 S.running 保持 true，status() 能反映真实阶段。
  const finished = new Promise(resolve => {
    let settled = false;
    const done = async (code) => {
      if (settled) return;
      settled = true;
      try {
        if (code !== 0) {
          S.phase = 'error';
          S.error = '扫描脚本退出码 ' + code + (stderrTail ? '：' + stderrTail.trim().split(/\r?\n/).slice(-3).join(' ') : '');
          pushEvent({ ev: 'error', text: S.error.slice(0, 400) });
          resolve({ ok: false, code, id: myId });
          return;
        }
        S.phase = 'indexing';
        pushEvent({ ev: 'phase', text: '重建项目索引' });
        // 先记结束时间：重建项目索引时要把它写进 JSON 的 scanner.lastScanAt
        S.endedAt = new Date().toISOString();
        const rows = await readKbRows(lib.rootPath());
        const { payload, added, removed } = await rebuildProjectIndex(lib.rootPath(), rows, S.endedAt);
        S.newProjects = added;
        S.removedProjects = removed;
        S.result = {
          ...(S.result || {}),
          projectCount: payload.projectCount,
          fileCount: payload.fileCount,
          kbTextDocs: payload.kb.withText,
          kbOcr: payload.kb.ocr,
          kbChars: payload.kb.chars,
          newProjects: added.length,
          removedProjects: removed.length,
        };
        lib.refresh();
        S.phase = 'done';
        resolve({ ok: true, code, id: myId });
      } catch (e) {
        S.phase = 'error';
        S.error = '重建索引失败：' + String((e && e.message) || e);
        pushEvent({ ev: 'error', text: S.error.slice(0, 400) });
        resolve({ ok: false, code, id: myId, error: S.error });
      } finally {
        S.running = false;
        if (!S.endedAt) S.endedAt = new Date().toISOString();
        S.pid = null;
        // 结束事件只写中文阶段名，界面日志里出现裸 'done' 会显得像半成品
        pushEvent({ ev: 'finish', text: S.phase === 'error' ? '扫描中止' : '扫描结束' });
      }
    };
    child.on('error', e => {
      if (settled) return;
      settled = true;
      S.error = String((e && e.message) || e);
      S.phase = 'error';
      S.running = false;
      S.pid = null;
      S.endedAt = new Date().toISOString();
      resolve({ ok: false, id: myId, error: S.error });
    });
    child.on('close', code => { done(code); });
  });

  // 保留引用，供需要等待结果的调用方（测试/CLI）使用
  S._finished = finished;
  return { ok: true, id: myId, started: true, status: status() };
}

/** 等待当前扫描结束（内部/测试用） */
export async function waitForScan() {
  if (S._finished) { try { await S._finished; } catch (e) {} }
  return status();
}

function handleEvent(ev) {
  switch (ev.ev) {
    case 'start':
      S.phase = 'walking';
      break;
    case 'walk':
      S.walk = { total: ev.total, added: ev.added, changed: ev.changed, removed: ev.removed, same: ev.same, recovered: ev.recovered || 0 };
      S.progress.total = (ev.added || 0) + (ev.changed || 0);
      S.phase = S.progress.total > 0 ? 'extracting' : 'xlsx';
      pushEvent({ ev: 'walk', text: `扫到 ${ev.total} 个文件：新增 ${ev.added}、变化 ${ev.changed}、删除 ${ev.removed}、未变 ${ev.same}` });
      break;
    case 'dedupe':
      S.dedupe = { shadowed: ev.shadowed || 0, pdfWord: ev.pdfWord || 0, boundCopy: ev.boundCopy || 0 };
      pushEvent({ ev: 'dedupe', text: `Word 优先：${ev.pdfWord || 0} 个 PDF 已有 Word 版不再解析，${ev.boundCopy || 0} 个装订版副本不重复入库` });
      break;
    case 'dedupe-content':
      // 第二遍：文件名对不上，靠文号/正文重合判出来的（同一份报告·说明的 Word 版）
      S.dedupe = Object.assign({}, S.dedupe || {}, {
        contentShadowed: ev.shadowed || 0, totalShadowed: ev.total || 0,
      });
      pushEvent({ ev: 'dedupe-content', text: `再按文号/正文比对，又有 ${ev.shadowed || 0} 个 PDF 确认有 Word 版（累计跳过 ${ev.total || 0} 个）` });
      break;
    case 'extract':
      S.phase = 'extracting';
      S.progress = { done: ev.done || 0, total: ev.total || 0, ok: ev.ok || 0, skip: ev.skip || 0, fail: ev.fail || 0 };
      if (ev.file) pushEvent({ ev: 'extract', text: ev.file, n: ev.done, total: ev.total });
      break;
    case 'ocr':
      S.phase = 'ocr';
      S.ocrProgress = { done: ev.done || 0, total: ev.total || 0, ok: ev.ok || 0, fail: ev.fail || 0, skipped: ev.skipped || '' };
      if (ev.file) pushEvent({ ev: 'ocr', text: ev.file, n: ev.done, total: ev.total });
      break;
    case 'xlsx':
      S.phase = 'xlsx';
      pushEvent({ ev: 'xlsx', text: ev.ok ? '已刷新 Excel 索引' : ('Excel 索引写入失败：' + (ev.reason || '')) });
      break;
    case 'done':
      S.result = { ...(ev.stats || {}) };
      pushEvent({ ev: 'done', text: '抽取完成：成功 ' + ((ev.stats || {}).extracted || 0) + '，跳过 ' + ((ev.stats || {}).skipped || 0) + '，失败 ' + ((ev.stats || {}).failed || 0) });
      break;
    case 'error':
      S.error = ev.message || '扫描出错';
      pushEvent({ ev: 'error', text: String(S.error).slice(0, 400) });
      break;
    default:
      pushEvent({ ev: ev.ev || 'log', text: JSON.stringify(ev).slice(0, 300) });
  }
}

/** 中断当前扫描 */
export function cancelScan() {
  if (!S.running || !S.pid) return { ok: false, error: '当前没有正在运行的扫描' };
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(S.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(S.pid, 'SIGTERM');
    }
    S.error = '已手动中断';
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 只做磁盘对比、不抽文本：用于「看有哪些新项目」的轻量预检 */
export async function previewScan() {
  const root = lib.rootPath();
  const rows = await readKbRows(root);
  const known = new Map();
  for (const r of rows) known.set(`${r.year || ''}|${r.project || ''}`, (known.get(`${r.year || ''}|${r.project || ''}`) || 0) + 1);
  const found = [];
  for (const y of await listDirs(root)) {
    for (const p of await listDirs(join(root, y))) {
      const key = `${y}|${p}`;
      const files = known.get(key) || 0;
      const st = await dirStats(join(root, y, p));
      found.push({ year: y, folder: p, ...parseFolder(p), kbFiles: files, diskFiles: st.files, bytes: st.bytes, newest: st.newest });
    }
  }
  return { root, kbRows: rows.length, projects: found.length, items: found };
}

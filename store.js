import { readFile, writeFile, mkdir, rename, stat, unlink, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, isAbsolute, basename } from 'node:path';
import { homedir } from 'node:os';
import { openShell } from './opener.js';

/**
 * 个人工作台的数据落盘层。
 *
 * 为什么要有这一层：工作台原来只把数据存在浏览器 localStorage 里，
 * 清理站点数据/换浏览器/换端口就全丢，也没法备份到归档目录旁边。
 * 现在数据写到用户指定的文件夹（默认 D:\\天源评估\\个人工作台），
 * localStorage 只当快路径缓存，磁盘上的副本才是正式数据。
 *
 * 两套目录：
 *  - 数据目录：工作台自己的 工作台数据.json + 股票库（默认 D:\\天源评估\\个人工作台）
 *  - 项目目录：本地项目的文件夹都建在这里（默认 D:\\天源评估\\00项目ing）
 * 归档时整个项目文件夹从这里移到 D:\\天源评估\\已归档\\{年份}年\\ 下（见 archive.js）。
 *
 * 两层文件：
 *  - 配置：~/.dsh/workbench-store.json      { dir, projectsDir }   ← 选哪个文件夹
 *  - 数据：<dir>/工作台数据.json            { app, version, savedAt, data }
 * 数据文件走「写临时文件 → 改名」的原子替换，覆盖前把上一版留成 .bak，
 * 避免写到一半断电后 json 半截、下次启动解析失败。
 */

const configFile = () => process.env.DSH_WORKBENCH_CONFIG || join(homedir(), '.dsh', 'workbench-store.json');
export const DATA_FILE = '工作台数据.json';
export const DEFAULT_DIR = process.platform === 'win32' ? 'D:\\天源评估\\个人工作台' : join(homedir(), 'Documents', '天源评估', '个人工作台');
// 本地项目文件夹的根目录：老的「年份 项目名」「项目编号 项目简称」目录都在这里
export const DEFAULT_PROJECTS_DIR = process.platform === 'win32' ? 'D:\\天源评估\\00项目ing' : join(homedir(), 'Documents', '天源评估', '00项目ing');

function normalizeDir(dir) {
  let d = String(dir || '').trim().replace(/^"|"$/g, '');
  if (!d) return null;
  // 盘符根（D: / D:\\ / D:/）：直接补分隔符，别被下面的「去掉尾部反斜杠」削成 `D:`，
  // 那样 isAbsolute('D:') 为 false，会把合法的盘符根误判成相对路径
  if (/^[A-Za-z]:[\\/]*$/.test(d)) return d.slice(0, 2) + '\\';
  d = d.replace(/[\\/]+$/, '');
  if (!d) return null;
  if (!isAbsolute(d)) return null;
  return d;
}

async function readConfigFile() {
  try {
    const j = JSON.parse(await readFile(configFile(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (e) {
    return {};
  }
}

/**
 * 当前配置：数据目录 + 项目目录。
 * 优先级都是 配置文件（用户选的） > 环境变量（只当默认值，测试用） > 内置默认值。
 */
export async function config() {
  const j = await readConfigFile();
  const cfgDir = normalizeDir(j && j.dir);
  const envDir = normalizeDir(process.env.DSH_WORKBENCH_DATA_DIR);
  const cfgProjects = normalizeDir(j && j.projectsDir);
  const envProjects = normalizeDir(process.env.DSH_WORKBENCH_PROJECTS_DIR);
  return {
    dir: cfgDir || envDir || DEFAULT_DIR,
    source: cfgDir ? 'config' : (envDir ? 'env' : 'default'),
    projectsDir: cfgProjects || envProjects || DEFAULT_PROJECTS_DIR,
    projectsSource: cfgProjects ? 'config' : (envProjects ? 'env' : 'default'),
  };
}

async function writeConfig(patch) {
  const cur = await readConfigFile();
  const next = {
    ...cur,
    ...patch,
    at: new Date().toISOString(),
  };
  await mkdir(dirname(configFile()), { recursive: true });
  await writeFile(configFile(), JSON.stringify(next, null, 2), 'utf8');
}

function dataPath(dir) { return join(dir, DATA_FILE); }

/** 建目录：已存在就跳过（Windows 对盘符根 mkdir 会 EPERM） */
async function ensureDir(dir) {
  if (existsSync(dir)) return;
  await mkdir(dir, { recursive: true });
}

/** 目录信息（给「设置」页显示）；顺带把目录建出来，避免用户第一次写盘才发现路径不存在 */
export async function info() {
  const { dir, source, projectsDir, projectsSource } = await config();
  const file = dataPath(dir);
  let exists = false, savedAt = null, bytes = 0, dirExists = false, error = '';
  try {
    await ensureDir(dir);
    dirExists = true;
  } catch (e) {
    error = '目录不可用：' + (e.message || e);
  }
  try {
    const st = await stat(file);
    exists = true; bytes = st.size; savedAt = st.mtime.toISOString();
  } catch (e) { /* 还没有数据文件 */ }
  let projectsDirExists = false, projectsError = '';
  try {
    await ensureDir(projectsDir);
    projectsDirExists = true;
  } catch (e) {
    projectsError = '项目文件夹根目录不可用：' + (e.message || e);
  }
  return {
    ok: !error, dir, source, defaultDir: DEFAULT_DIR, file, dirExists, exists, bytes, savedAt, error,
    projectsDir, projectsSource, defaultProjectsDir: DEFAULT_PROJECTS_DIR, projectsDirExists, projectsError,
  };
}

/** 切换数据目录：建目录 → 旧目录有数据且新目录为空时顺手搬一份过去 */
export async function setDir(dir) {
  const next = normalizeDir(dir);
  if (!next) return { ok: false, error: '请填写绝对路径，例如 ' + DEFAULT_DIR };
  let prev = null;
  try { prev = (await config()).dir; } catch (e) {}
  try {
    await ensureDir(next);
  } catch (e) {
    return { ok: false, error: '目录不可用：' + (e.message || e) };
  }
  let migrated = false;
  try {
    if (prev && prev.toLowerCase() !== next.toLowerCase()) {
      const from = dataPath(prev), to = dataPath(next);
      if (existsSync(from) && !existsSync(to)) { await copyFile(from, to); migrated = true; }
    }
  } catch (e) { /* 迁移失败不算切换失败，数据还在旧目录里 */ }
  try {
    await writeConfig({ dir: next });
  } catch (e) {
    return { ok: false, error: '保存配置失败：' + (e.message || e) };
  }
  return { ok: true, dir: next, prevDir: prev, migrated, file: dataPath(next) };
}

/** 切换「本地项目文件夹」的根目录（归档库不动） */
export async function setProjectsDir(dir) {
  const next = normalizeDir(dir);
  if (!next) return { ok: false, error: '请填写绝对路径，例如 ' + DEFAULT_PROJECTS_DIR };
  let prev = null;
  try { prev = (await config()).projectsDir; } catch (e) {}
  try {
    await ensureDir(next);
  } catch (e) {
    return { ok: false, error: '目录不可用：' + (e.message || e) };
  }
  try {
    await writeConfig({ projectsDir: next });
  } catch (e) {
    return { ok: false, error: '保存配置失败：' + (e.message || e) };
  }
  return { ok: true, projectsDir: next, prevProjectsDir: prev };
}

/** 读磁盘上的工作台数据；没有就返回 data:null（前端用 localStorage / 默认值） */
export async function readState() {
  const meta = await info();
  if (!meta.exists) return { ...meta, data: null, savedAt: null };
  try {
    const raw = await readFile(meta.file, 'utf8');
    const j = JSON.parse(raw);
    const data = j && typeof j === 'object' && j.data ? j.data : j;
    return { ...meta, data, savedAt: (j && j.savedAt) || meta.savedAt };
  } catch (e) {
    return { ...meta, data: null, error: '数据文件解析失败：' + (e.message || e) };
  }
}

/** 写工作台数据（原子替换 + 保留上一版 .bak） */
export async function writeState(data) {
  const { dir } = await config();
  await ensureDir(dir);
  const file = dataPath(dir);
  const tmp = file + '.tmp';
  const payload = { app: 'dsh-workbench', version: 1, savedAt: new Date().toISOString(), data: data || {} };
  await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
  try { if (existsSync(file + '.bak')) await unlink(file + '.bak'); } catch (e) {}
  try { if (existsSync(file)) await rename(file, file + '.bak'); } catch (e) {}
  await rename(tmp, file);
  return { ok: true, dir, file, savedAt: payload.savedAt };
}

/** 用资源管理器打开数据目录（只允许当前配置的那个目录，不开任意路径） */
export async function openDir() {
  const { dir } = await config();
  try { await ensureDir(dir); } catch (e) { return { ok: false, error: '目录不可用：' + (e.message || e) }; }
  if (!existsSync(dir)) return { ok: false, error: '目录不存在：' + dir };
  // 打开动作统一走 opener.js：那里不传 windowsHide，否则资源管理器窗口会以隐藏状态建出来
  const r = await openShell(dir);
  if (!r.ok) return { ok: false, error: r.error || '打开失败', dir };
  return { ok: true, dir };
}

/** 用资源管理器打开「本地项目」根目录（00项目ing） */
export async function openProjectsDir() {
  const { projectsDir } = await config();
  try { await ensureDir(projectsDir); } catch (e) { return { ok: false, error: '项目文件夹根目录不可用：' + (e.message || e) }; }
  if (!existsSync(projectsDir)) return { ok: false, error: '目录不存在：' + projectsDir };
  const r = await openShell(projectsDir);
  if (!r.ok) return { ok: false, error: r.error || '打开失败', dir: projectsDir };
  return { ok: true, dir: projectsDir };
}

// ---------- 本地项目文件夹 ----------
// 规则与用户约定一致：<项目目录>\\<项目编号> <项目简称>，例如「20261104002 示例子公司子公司股权转让」。
const ILLEGAL_NAME = /[<>:"/\\|?*\x00-\x1f]/g;

export function projectFolderName(year, name) {
  const y = String(year || '').trim() || String(new Date().getFullYear());
  let n = String(name || '')
    .replace(ILLEGAL_NAME, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
  if (!n) n = '未命名项目';
  return y + ' ' + n;
}

/** 项目文件夹可能落在的根目录：新目录（00项目ing）优先，其次老数据目录（升级前建的项目） */
export async function projectRoots() {
  const c = await config();
  const roots = [c.projectsDir];
  if (c.dir && c.dir.toLowerCase() !== c.projectsDir.toLowerCase()) roots.push(c.dir);
  return roots;
}

function checkFolderName(folder) {
  const name = String(folder || '').trim();
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) return '';
  return name;
}

/** 在任一项目根目录里找已存在的项目文件夹；找不到返回 null */
export async function findProjectDir(folder) {
  const name = checkFolderName(folder);
  if (!name) return null;
  for (const root of await projectRoots()) {
    const p = join(root, name);
    try {
      const st = await stat(p);
      if (st.isDirectory()) return { path: p, root, name, existed: true, created: false };
    } catch (e) { /* 这个根目录下没有 */ }
  }
  return null;
}

/**
 * 取项目文件夹（创建/复用）。
 * 已存在的（不管在 00项目ing 还是老数据目录）优先复用；不存在才在项目根目录下新建。
 */
export async function projectDir(folder, create) {
  const name = checkFolderName(folder);
  if (!name) return { ok: false, error: '项目文件夹名不合法' };
  const hit = await findProjectDir(name);
  if (hit) return { ok: true, ...hit };
  const { projectsDir } = await config();
  if (create === false) return { ok: false, error: '文件夹不存在：' + join(projectsDir, name) };
  const target = join(projectsDir, name);
  try {
    await ensureDir(projectsDir);
    await mkdir(target, { recursive: true });
  } catch (e) {
    return { ok: false, error: '创建文件夹失败：' + (e.message || e) };
  }
  return { ok: true, path: target, root: projectsDir, name, existed: false, created: true };
}

// ---------- 绑定的项目目录（项目 ↔ 本地文件夹的强关联） ----------
// 为什么需要这一层：上面的 findProjectDir 只认「项目目录根 + 名字」，
// 但用户会把项目放在任意位置（比如 OneDrive 里的客户目录、D:\客户\某某项目），
// 这种目录不在 00项目ing 下面，按名字永远找不到。绑定的路径记在这里，
// 由前端在项目记录上存 folderPath，每次调用项目目录时带过来。
export async function describeFolder(abs, create) {
  const raw = String(abs == null ? '' : abs).trim().replace(/^"|"$/g, '');
  if (!raw || !isAbsolute(raw)) return null;
  const path = raw.replace(/[\\/]+$/, '') || raw;
  const name = basename(path) || path;
  const root = dirname(path) || path;
  try {
    const st = await stat(path);
    if (!st.isDirectory()) return { ok: false, error: '这个路径不是文件夹：' + path, path, name, root };
    return { ok: true, path, name, root, existed: true, created: false, bound: true };
  } catch (e) {
    if (create === false) return { ok: false, error: '目录不存在：' + path, path, name, root };
    try {
      await mkdir(path, { recursive: true });
      return { ok: true, path, name, root, existed: false, created: true, bound: true };
    } catch (e2) {
      return { ok: false, error: '创建目录失败：' + (e2.message || e2), path, name, root };
    }
  }
}

/** 建出（或复用）项目文件夹，返回绝对路径；create=false 时只探测 */
export async function projectFolder(year, name, create) {
  const folder = projectFolderName(year, name);
  const r = await projectDir(folder, create !== false);
  if (!r.ok) return r;
  return { ok: true, path: r.path, name: folder, created: !!r.created };
}

/** 建出项目文件夹并用资源管理器打开 */
export async function openProjectFolder(year, name, create) {
  const r = await projectFolder(year, name, create !== false);
  if (!r.ok) return r;
  // 同上：不传 windowsHide，否则窗口建出来但隐藏（提示已打开、桌面却没反应）
  const o = await openShell(r.path);
  if (!o.ok) return { ...r, ok: false, error: (o.error || '打开失败') + '；文件夹已建好：' + r.path };
  return r;
}

export default {
  DATA_FILE, DEFAULT_DIR, DEFAULT_PROJECTS_DIR,
  config, info, setDir, setProjectsDir,
  readState, writeState, openDir, openProjectsDir,
  projectFolderName, projectRoots, findProjectDir, projectDir, projectFolder, openProjectFolder,
  describeFolder,
};

import { readdir, stat, mkdir, rename, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import * as store from './store.js';
import * as lib from './library.js';

/**
 * 项目归档：把「本地项目」的整个文件夹移进文件库。
 *
 * 目录约定：
 *   本地项目：<项目目录>\\<项目编号> <项目简称>        默认 D:\\天源评估\\00项目ing
 *   归档库：  <归档根>\\{年份}年\\<项目编号> <项目简称> 默认 D:\\天源评估\\已归档
 *
 * 规则（用户口径）：
 *  1. 点「归档」先只读预览：列出项目里「04项目归档」的内容，由用户确认；
 *  2. 确认后移动的是**整个项目文件夹**（不只 04项目归档），并在归档库里保留
 *     「项目编号 项目简称」的目录名；年份取项目的年份（p.year）；
 *  3. 目标已存在时拒绝覆盖——宁可报错，也不要把两个项目混进一个目录；
 *  4. 移动完成后由 index.js 触发一次增量扫描，文件库（索引/知识库/Excel）随之更新。
 */

export const ARCHIVE_SUBDIR = '04项目归档';
/** 预览列出条目上限：底稿目录上千个文件时，界面只展示前一部分，计数仍是全量 */
const PREVIEW_LIMIT = 600;
const BAD_SEGMENT = /[<>:"/\\|?*\x00-\x1f]/g;

function cleanSegment(s, max) {
  return String(s == null ? '' : s)
    .replace(BAD_SEGMENT, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, max || 120);
}
function safeFolderName(s) {
  const raw = String(s == null ? '' : s).trim();
  if (!raw || raw === '.' || raw === '..' || /[\\/]/.test(raw)) return '';
  const n = cleanSegment(raw, 160);
  return (n && n !== '.' && n !== '..') ? n : '';
}
function yearOf(v) {
  const y = String(v == null ? '' : v).trim();
  const m = /^(\d{4})$/.exec(y);
  return m ? m[1] : String(new Date().getFullYear());
}
/** 归档库里的目录名：项目编号 + 项目简称 */
export function archiveFolderName(input) {
  const code = cleanSegment(input && input.code, 40).replace(/\s+/g, '');
  const shortName = cleanSegment(input && (input.shortName || input.name), 120);
  return [code, shortName].filter(Boolean).join(' ') || '未命名项目';
}

/** 递归列出目录内容；返回全量计数 + 前 PREVIEW_LIMIT 条（目录在前、按中文名排序） */
async function treeOf(dir) {
  const empty = { exists: false, dirs: 0, files: 0, bytes: 0, items: [], truncated: false, total: 0 };
  if (!existsSync(dir)) return empty;
  let dirs = 0, files = 0, bytes = 0, total = 0;
  const items = [];
  async function walk(abs, rel, level) {
    let ents = [];
    try { ents = await readdir(abs, { withFileTypes: true }); } catch (e) { return; }
    ents = ents
      .filter(d => !d.name.startsWith('.') && !d.name.startsWith('~$'))
      .sort((a, b) => (a.isDirectory() === b.isDirectory()
        ? a.name.localeCompare(b.name, 'zh', { numeric: true })
        : a.isDirectory() ? -1 : 1));
    for (const d of ents) {
      total += 1;
      const r = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory()) {
        dirs += 1;
        if (items.length < PREVIEW_LIMIT) items.push({ rel: r, name: d.name, dir: true, level, size: null });
        await walk(join(abs, d.name), r, level + 1);
      } else {
        files += 1;
        let size = null;
        try { const st = await stat(join(abs, d.name)); size = st.size; bytes += st.size; } catch (e) {}
        if (items.length < PREVIEW_LIMIT) items.push({ rel: r, name: d.name, dir: false, level, size });
      }
    }
  }
  await walk(dir, '', 0);
  return { exists: true, dirs, files, bytes, items, truncated: total > items.length, total };
}

/**
 * 归档预览（只读）。
 * body: { folder, code, shortName, name, year }
 */
export async function preview(input) {
  const opts = input || {};
  const folder = safeFolderName(opts.folder);
  const legacy = safeFolderName(opts.legacy);
  if (!folder && !legacy) return { ok: false, error: '项目文件夹名不合法（先填项目编号与项目简称）' };

  // 新名字（编号 简称）优先，其次老的「年份 项目名」目录；两者都找不到才算没有
  let src = null;
  for (const name of [folder, legacy].filter(Boolean)) {
    src = await store.findProjectDir(name);
    if (src) break;
  }
  if (!src) {
    return {
      ok: false, notFound: true,
      error: '没有找到项目文件夹「' + (folder || legacy) + '」：它可能已经归档，或目录被手工移走了。'
        + '可以在「文件库」里搜索确认。',
    };
  }

  const year = yearOf(opts.year);
  const yearFolder = year + '年';
  const targetName = archiveFolderName(opts);
  const archiveRoot = lib.rootPath();
  const target = join(archiveRoot, yearFolder, targetName);
  const subPath = join(src.path, ARCHIVE_SUBDIR);
  const sub = await treeOf(subPath);

  return {
    ok: true,
    folder: src.name,
    source: src.path,
    sourceRoot: src.root,
    sourceName: src.name,
    archiveRoot,
    year,
    yearFolder,
    targetName,
    target,
    targetExists: existsSync(target),
    sub: { name: ARCHIVE_SUBDIR, path: subPath, ...sub },
  };
}

/**
 * 执行归档：把整个项目文件夹移动到 归档根\{年份}年\{项目编号 项目简称}。
 * 目标已存在 / 源目录不存在 / 源就是归档库内部目录时一律拒绝。
 */
export async function commit(input) {
  const pre = await preview(input);
  if (!pre.ok) return pre;
  if (pre.targetExists) {
    return { ok: false, error: '归档目录已存在，未做任何移动：' + pre.target, target: pre.target, targetExists: true };
  }
  const srcLower = pre.source.toLowerCase();
  // macOS 移植：原实现按 Windows 反斜杠裁尾与判界，非 Windows 下永远匹配不上。
  const S = process.platform === 'win32' ? '\\' : '/';
  const rootLower = pre.archiveRoot.toLowerCase().replace(/[\\/]+$/, '');
  if (srcLower === rootLower || srcLower.startsWith(rootLower + S)) {
    return { ok: false, error: '源目录在归档库内部，拒绝移动：' + pre.source };
  }
  if (pre.source.toLowerCase() === pre.target.toLowerCase()) {
    return { ok: false, error: '源目录与目标目录相同：' + pre.source };
  }

  try { await mkdir(dirname(pre.target), { recursive: true }); } catch (e) {
    return { ok: false, error: '创建归档年份目录失败：' + (e.message || e) };
  }

  let movedBy = 'rename';
  try {
    await rename(pre.source, pre.target);
  } catch (e) {
    // 跨卷（EXDEV）才走「复制 + 删除」；其它错误（文件被占用、权限）直接报，别删源目录。
    if (e && e.code === 'EXDEV') {
      movedBy = 'copy';
      try {
        await cp(pre.source, pre.target, { recursive: true, errorOnExist: true, force: false });
        await rm(pre.source, { recursive: true, force: true });
      } catch (e2) {
        return {
          ok: false,
          error: '跨盘复制归档失败：' + (e2.message || e2) + '（源目录未删除）',
          from: pre.source, to: pre.target,
        };
      }
    } else {
      return {
        ok: false,
        error: '移动文件夹失败：' + ((e && e.message) || e)
          + '。常见原因是资源管理器窗口还开着、或目录里有文件被占用；关掉后重试。',
        from: pre.source, to: pre.target,
      };
    }
  }

  return {
    ok: true,
    moved: true,
    movedBy,
    from: pre.source,
    to: pre.target,
    targetName: pre.targetName,
    year: pre.year,
    yearFolder: pre.yearFolder,
    archiveRoot: pre.archiveRoot,
    sub: pre.sub,
  };
}

/** 打开归档目录（只允许归档根之内的路径） */
export async function openArchived(rel) {
  return lib.openPath(rel || '', false);
}

export default { ARCHIVE_SUBDIR, archiveFolderName, preview, commit, openArchived };

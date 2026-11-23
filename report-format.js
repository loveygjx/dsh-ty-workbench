import { open, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const REPORT_FORMAT_PATH = join(homedir(), '.tycpv', 'report-format.json');
export const MAX_REPORT_FORMAT_BYTES = 64 * 1024;
const fonts = ['cover_title', 'cover_docno', 'heading1', 'heading2', 'heading3', 'heading4', 'body', 'table'];
const edges = ['top', 'bottom', 'insideH', 'insideV'];
export const REPORT_FORMAT_DEFAULTS = {
  page: { width_twips: 11907, height_twips: 16839, top_twips: 1440, right_twips: 1588, bottom_twips: 1440, left_twips: 1440 },
  cover_title: { font: '黑体', size_half_points: 36 }, cover_docno: { font: '黑体', size_half_points: 21 },
  heading1: { font: '黑体', size_half_points: 36 }, heading2: { font: '黑体', size_half_points: 24 },
  heading3: { font: '宋体', size_half_points: 24 }, heading4: { font: '宋体', size_half_points: 24 },
  body: { font: '宋体', size_half_points: 24 }, table: { font: '宋体', size_half_points: 21, border: {
    top: { style: 'single', size: 12, space: 12, color: 'auto' }, bottom: { style: 'single', size: 12, space: 12, color: 'auto' },
    insideH: { style: 'single', size: 4, space: 4, color: 'auto' }, insideV: { style: 'single', size: 4, space: 4, color: 'auto' },
  } },
};
export class ReportFormatError extends Error {}
function fail(message) { throw new ReportFormatError(message); }
// 段落级格式（契约 v2）：仅 body/heading1..4；line_multiple 与 line_points 互斥。
function validateParagraph(p, path) {
  object(p, ['line_multiple','line_points','first_line_indent_chars','space_before_points','space_after_points'], path);
  if ('line_multiple' in p && (typeof p.line_multiple !== 'number' || typeof p.line_multiple === 'boolean' || !(p.line_multiple >= 0.5 && p.line_multiple <= 5))) fail(path + '.line_multiple 必须为 0.5..5 的数字');
  if ('line_points' in p) integer(p.line_points, 2, 3276, path + '.line_points');
  if ('line_multiple' in p && 'line_points' in p) fail(path + ' 的 line_multiple 与 line_points 只能设置其一');
  if ('first_line_indent_chars' in p) integer(p.first_line_indent_chars, 0, 10, path + '.first_line_indent_chars');
  if ('space_before_points' in p) integer(p.space_before_points, 0, 1000, path + '.space_before_points');
  if ('space_after_points' in p) integer(p.space_after_points, 0, 1000, path + '.space_after_points');
}
function object(v, keys, path) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(path + ' 必须是对象');
  for (const k of Object.keys(v)) if (!keys.includes(k)) fail(path + ' 含未知字段 ' + k);
}
function integer(v, min, max, path) { if (!Number.isSafeInteger(v) || v < min || v > max) fail(path + ` 必须为 ${min}..${max} 的整数`); }
function font(v, path) { if (typeof v !== 'string' || !v.trim() || [...v].length > 100 || /[\x00-\x1f\x7f-\x9f]/u.test(v)) fail(path + ' 字体名称无效'); }
export function validateReportFormat(config) {
  object(config, ['page', ...fonts], '配置');
  if ('page' in config) {
    const p = config.page, keys = ['width_twips','height_twips','top_twips','right_twips','bottom_twips','left_twips'];
    object(p, keys, 'page');
    for (const k of Object.keys(p)) integer(p[k], k === 'width_twips' || k === 'height_twips' ? 1 : 0, 31680, 'page.' + k);
    const page = { ...REPORT_FORMAT_DEFAULTS.page, ...p };
    if (page.left_twips + page.right_twips >= page.width_twips || page.top_twips + page.bottom_twips >= page.height_twips) fail('page 页边距之和必须小于页面尺寸');
  }
  for (const name of fonts) if (name in config) {
    const f = config[name];
    const paraAllowed = name === 'body' || /^heading[1-4]$/.test(name);
    object(f, name === 'table' ? ['font','size_half_points','ascii_font','min_row_height_twips','repeat_header','numeric_align_right','clear_shading','autofit','single_line','border'] : paraAllowed ? ['font','size_half_points','ascii_font','paragraph'] : ['font','size_half_points'], name);
    if ('font' in f) font(f.font, name + '.font');
    if ('size_half_points' in f) integer(f.size_half_points, 2, 3276, name + '.size_half_points');
    if (paraAllowed && 'paragraph' in f) validateParagraph(f.paragraph, name + '.paragraph');
    // 正文/标题的西文字体（含数字）：留空表示跟随该类别的中文字体。
    if (paraAllowed && 'ascii_font' in f) font(f.ascii_font, name + '.ascii_font');
    if (name !== 'table') continue;
    if ('ascii_font' in f) font(f.ascii_font, 'table.ascii_font');
    if ('min_row_height_twips' in f) integer(f.min_row_height_twips, 1, 31680, 'table.min_row_height_twips');
    for (const k of ['repeat_header','numeric_align_right','clear_shading','autofit','single_line']) if (k in f && typeof f[k] !== 'boolean') fail('table.' + k + ' 必须为布尔值');
    if ('border' in f) {
      object(f.border, edges, 'table.border');
      for (const k of Object.keys(f.border)) {
        const b = f.border[k], path = 'table.border.' + k;
        object(b, ['style','size','space','color'], path);
        if ('style' in b && !['single','double','dashed','dotted','nil','none'].includes(b.style)) fail(path + '.style 无效');
        if ('size' in b) integer(b.size, 2, 96, path + '.size');
        if ('space' in b) integer(b.space, 0, 31, path + '.space');
        if ('color' in b && (typeof b.color !== 'string' || !/^(?:auto|[0-9a-fA-F]{6})$/.test(b.color))) fail(path + '.color 无效');
      }
    }
  }
  return config;
}

// 先由 JSON.parse 验证语法，再扫描对象键以拒绝重复（包括转义后的同名键）。
export function parseReportFormat(text) {
  let result;
  try { result = JSON.parse(text); } catch (_) { fail('不是有效 JSON'); }
  let i = 0;
  const ws = () => { while (/\s/.test(text[i] || '') && i < text.length) i++; };
  function string() {
    const start = i++;
    while (i < text.length) { if (text[i] === '\\') { i += 2; continue; } if (text[i++] === '"') break; }
    return JSON.parse(text.slice(start, i));
  }
  function value(depth = 0) {
    if (depth > 32) fail('JSON 嵌套过深');
    ws();
    if (text[i] === '{') {
      i++; ws(); const keys = new Set();
      if (text[i] === '}') { i++; return; }
      while (true) {
        ws(); const key = string(); if (keys.has(key)) fail('JSON 对象含重复字段 ' + key); keys.add(key);
        ws(); i++; value(depth + 1); ws(); if (text[i++] === '}') return;
      }
    }
    if (text[i] === '[') { i++; ws(); if (text[i] === ']') { i++; return; } while (true) { value(depth + 1); ws(); if (text[i++] === ']') return; } }
    if (text[i] === '"') { string(); return; }
    const start = i;
    while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
    const token = text.slice(start, i);
    // 小数在此放行（line_multiple 等字段契约允许 0.5..5）；整数字段由 validateReportFormat 按字段拒绝
  }
  value();
  return validateReportFormat(result);
}

export async function readReportFormat(file = REPORT_FORMAT_PATH) {
  let data;
  try { data = await readFile(file); } catch (e) { if (e.code === 'ENOENT') return structuredClone(REPORT_FORMAT_DEFAULTS); throw e; }
  if (data.length > MAX_REPORT_FORMAT_BYTES) fail('配置文件过大');
  const config = parseReportFormat(new TextDecoder('utf-8', { fatal: true }).decode(data));
  return config;
}
export async function saveReportFormat(config, file = REPORT_FORMAT_PATH) {
  validateReportFormat(config);
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, '.report-format-' + randomBytes(16).toString('hex') + '.tmp');
  let handle;
  try {
    handle = await open(tmp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(config, null, 2) + '\n', 'utf8');
    await handle.sync(); await handle.close(); handle = null;
    await rename(tmp, file);
  } finally { if (handle) await handle.close(); await unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  return config;
}

export async function reportFormatRequest(req, file = REPORT_FORMAT_PATH) {
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  try {
    if (req.method === 'GET') return json(await readReportFormat(file));
    if (req.method !== 'POST') return json({ error: '方法不支持' }, 405);
    const length = req.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_REPORT_FORMAT_BYTES)) return json({ error: '请求体过大或长度无效' }, 413);
    const reader = req.body?.getReader(); const chunks = []; let size = 0;
    if (reader) try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > MAX_REPORT_FORMAT_BYTES) { await reader.cancel(); return json({ error: '请求体过大' }, 413); } chunks.push(value); } } finally { reader.releaseLock(); }
    let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch (_) { fail('请求体不是有效 UTF-8'); }
    return json(await saveReportFormat(parseReportFormat(text), file));
  } catch (e) { return json({ error: e instanceof ReportFormatError ? e.message : '报告格式配置读写失败' }, e instanceof ReportFormatError && req.method === 'POST' ? 400 : 500); }
}

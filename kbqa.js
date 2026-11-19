/**
 * 知识库问答：检索本地归档库 + 调用宿主 LLM 生成答案（带出处引用）。
 *
 * 检索：复用 library.js 的全文检索（文件名 / 正文），命中片段拼成上下文。
 * 生成：通过注入的 ctx.llm.stream(GenerateOptions) 走当前默认模型。
 * 兜底：模型不可用时返回检索摘要，让用户至少看到命中的原文片段。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as lib from './library.js';

const KB_DIR = join(lib.rootPath(), '_知识库');
// llm-wiki 编译层：_wiki\wiki\{projects,topics,years,index.md}
const WIKI_DIR = join(lib.rootPath(), '_wiki', 'wiki');
const WIKI_INDEX = join(WIKI_DIR, 'index.md');
const WIKI_TTL = 15000;
let wikiCache = { at: 0, entries: null };

/** a 的字片段有多大比例出现在 b 里：短标题配长问题用这个方向 */
function cover(a, b) {
  const ga = grams(a);
  if (!ga.size) return 0;
  const gb = grams(b);
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return hit / ga.size;
}

/** 公共前缀长度：用户常只打项目名前半截（「勾庄批发市场」而不是全称） */
function commonPrefixLen(a, b) {
  const x = String(a || ''), y = String(b || '');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

/** 在正文里截一段带命中词的片段，供出处展示 */
function pickSnippet(text, question, n) {
  const body = String(text || '').replace(/\r/g, '');
  const toks = (String(question).match(/[\u4e00-\u9fa5A-Za-z]{2,8}/g) || [])
    .filter(t => t.length >= 2).slice(0, 12);
  for (const t of toks) {
    const i = body.indexOf(t);
    if (i >= 0) {
      const seg = body.slice(Math.max(0, i - 160), i + 260).replace(/\s+/g, ' ').trim();
      if (seg) return seg.slice(0, n || 400);
    }
  }
  return body.replace(/^---[\s\S]*?---/, '').replace(/\s+/g, ' ').trim().slice(0, n || 400);
}

/**
 * 读 wiki/index.md 建「页面目录」：项目页 / 主题页 / 年度页。
 * 目录由 build_wiki.py 生成，一行一条，格式固定，正则解析足够稳。
 */
export async function wikiIndex(force) {
  const now = Date.now();
  if (!force && wikiCache.entries && now - wikiCache.at < WIKI_TTL) return wikiCache.entries;
  const entries = [];
  let raw = '';
  try { raw = await readFile(WIKI_INDEX, 'utf8'); } catch (e) { raw = ''; }
  const re = /\[\[(projects|topics|years)\/([^|\]]+)\|([^\]]+)\]\]/;
  for (const line of raw.split(/\r?\n/)) {
    const m = line.trim().match(re);
    if (!m) continue;
    entries.push({
      kind: m[1], slug: m[2], name: m[3].trim(), meta: '',
      rel: join('_wiki', 'wiki', m[1], m[2] + '.md'),
    });
  }
  wikiCache = { at: now, entries };
  return entries;
}

/**
 * 编译层检索：先找 wiki 页面（项目页/主题页），命中就直接读页面。
 * 这是「先读编译过的结论，再回原文」的那一步，比纯原文检索稳。
 */
export async function wikiRetrieve(question, opts) {
  const topK = Math.max(1, Math.min(6, (opts && opts.topK) || 3));
  const q = String(question || '').trim();
  if (!q) return [];
  const entries = await wikiIndex();
  if (!entries.length) return [];
  const digits = q.match(/\d{6,12}/g) || [];
  const qg = grams(q);
  const scored = [];
  for (const e of entries) {
    const title = e.name.replace(/^\d{6,12}\s*/, '');
    let s = 0;
    if (e.kind === 'projects') {
      const code = (e.name.match(/^\d{6,12}/) || [])[0];
      const byCode = !!(code && digits.includes(code));        // 受理号精确命中
      const byTitle = title.length >= 4 && q.includes(title);  // 项目名整体出现在问题里
      const byPrefix = commonPrefixLen(title, q) >= 6;         // 只打了前半截名字
      const c = cover(title, q);
      // 项目页门槛高一点：不然「XX商誉减值」这种同类项目会互相污染
      if (!byCode && !byTitle && !byPrefix && c < 0.75) continue;
      if (byCode) s += 30;
      if (byTitle) s += 18;
      if (byPrefix) s += 14;
      if (c >= 0.6) s += 10 * c;                               // 项目名大部分字被问题覆盖
      s += overlap(qg, e.name) * 3;
    } else if (e.kind === 'topics') {
      const c = cover(e.name, q);
      if (c >= 0.5) s += 16 * c;                              // 「商誉减值」→ 商誉减值测试
      // 标题里的整词出现在问题里（「土地使用权」）比字片段更像真命中
      for (const part of e.name.split(/[与、/（）()\-—]+/)) {
        if (part.length >= 3 && q.includes(part)) s += 12;
      }
      s += overlap(qg, e.name) * 4;
    } else {
      s += overlap(qg, e.name) * 2;
    }
    if (s > 2) scored.push({ e, s });
  }
  scored.sort((a, b) => b.s - a.s);
  const picked = [];
  const seen = new Set();
  for (const { e, s } of scored) {
    if (picked.length >= topK) break;
    if (seen.has(e.rel)) continue;
    seen.add(e.rel);
    picked.push({ e, s });
  }
  const out = [];
  for (const { e, s } of picked) {
    let text = '';
    try { text = await readFile(join(WIKI_DIR, e.kind, e.slug + '.md'), 'utf8'); } catch (err) { continue; }
    out.push({
      rel: e.rel,
      project: e.kind === 'topics' ? '知识库主题' : (e.kind === 'years' ? '知识库年度' : '知识库项目页'),
      file: e.name, subdir: e.kind,
      snippet: pickSnippet(text, q, 400),
      score: Math.min(99, s), chars: text.length,
      wiki: true, where: 'wiki',
      text: text.slice(0, 8000),
    });
  }
  return out;
}

/** 中文按 2 字、英文按词切分，用于简单重叠打分 */
function grams(s) {
  const t = String(s || '').toLowerCase().replace(/[\s\u3000]+/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

function overlap(q, text) {
  if (!q.size || !text) return 0;
  const t = String(text).toLowerCase().replace(/[\s\u3000]+/g, '');
  let hit = 0;
  for (const g of q) if (t.includes(g)) hit++;
  return hit / q.size;
}

/**
 * 多路召回：整句 → 拆分关键词 → 逐词检索，合并去重并按相关度排序。
 * 返回 [{rel, project, file, subdir, snippet, score, chars}]
 */
export async function retrieve(question, opts) {
  const topK = Math.max(3, Math.min(20, (opts && opts.topK) || 8));
  const maxCharsPerDoc = (opts && opts.maxCharsPerDoc) || 6000;
  const q = String(question || '').trim();
  if (!q) return [];

  // 拆关键词：按标点/空格切，再按疑问词、结构助词切，最后去掉无意义的词
  const stop = new Set(['什么', '怎么', '如何', '哪些', '哪个', '是否', '可以', '请问', '一下', '多少',
    '为什么', '以及', '还有', '需要', '我们', '这个', '那个', '的是', '有没有', '告诉', '帮我', '查一下', '找一下']);
  const raw = String(q)
    .split(/[\s,，。；;、？?！!：:（）()【】\[\]"'']/)
    .flatMap(s => s.split(/(?:是什么|是啥|怎么样|如何|的|呢|吗|呀|吧|有没|多少|为什么|哪些|哪个)/))
    .map(s => s.trim())
    .filter(Boolean);
  const keys = [];
  for (const p of raw) {
    if (p.length >= 2 && !stop.has(p) && !keys.includes(p)) keys.push(p);
  }
  // 再按滑窗切出 2~4 字片段：中文没有空格，整句没有疑问词时上面切不开，
  // 只用整句做子串匹配经常 0 命中（如「千年舟减值测试」），必须补这一层。
  // 2 字片段也要保留：专名常常就是两个字（杭氧、中拓、镇洋）。
  const longKeys = keys.filter(k => k.length >= 3);
  const slide = [];
  for (const k of longKeys) {
    for (const size of [2, 3, 4]) {
      for (let i = 0; i + size <= k.length; i++) {
        const piece = k.slice(i, i + size);
        if (!stop.has(piece) && !keys.includes(piece) && !slide.includes(piece)) slide.push(piece);
      }
    }
  }
  // 排序：先用「项目稀有度」挑检索词 —— 只覆盖少数项目的词区分度最高
  //（「学而思」「杭氧」这类专名优先），「评估/报告/底稿」这类覆盖上百个项目的通用词靠后。
  const queries = keys.length
    ? [...keys.filter(k => k.length <= 6), ...slide, ...keys.filter(k => k.length > 6), q]
    : [q];
  const uniq = [];
  for (const t of queries) if (t && !uniq.includes(t)) uniq.push(t);

  // 算稀有度（按项目名覆盖数）
  const spread = new Map();
  let kbRows = [];
  try {
    kbRows = await lib.getKb();
    for (const k of uniq) {
      const projs = new Set();
      for (const r of kbRows) {
        if ((r.project || '').includes(k)) projs.add(r.project);
      }
      spread.set(k, projs.size);
    }
  } catch (e) {}

  // 稀有度优先：但要区分「命中项目名的稀有词」（真专名）与「覆盖 0 个项目的碎片」
  // —— 「而思评」这种切出来的碎片 spread=0，不能排在最前，否则会拉进大量噪声。
  const rankOf = (t) => {
    const s = spread.get(t) || 0;
    const len = t.length;
    if (s >= 1 && s <= 3) return 0;          // 只对应少数项目：最强信号
    if (s >= 4 && s <= 12) return 1;         // 中等常见
    if (s > 12) return 3;                    // 通用词（评估/报告）
    // spread == 0：不在任何项目名里，多半是碎片；长一点的还有可能是业务词
    return len >= 4 ? 2 : 4;
  };
  const ranked = uniq.slice().sort((a, b) => {
    if (a === q) return 1;
    if (b === q) return -1;
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    // 同档时：覆盖项目少的优先，其次词长的优先
    const sa = spread.get(a) || 0;
    const sb = spread.get(b) || 0;
    if (sa !== sb) return sa - sb;
    return b.length - a.length;
  });
  // 保留最多 6 路：整句（精确匹配）+ 稀有词
  const finalQueries = [q, ...ranked.filter(t => t !== q)].slice(0, 6);

  const qg = grams(q);
  const bucket = new Map();   // rel -> hit
  // 专名候选：参与检索且稀有的词；是否加权由 spread 决定
  const pinned = finalQueries.filter(k => k.length >= 2 && k !== q).slice(0, 10);

  // 多路查询并行（串行跑 8 次 search 要好几秒）
  const results = await Promise.all(finalQueries.map(async (term) => {
    try { return { term, res: await lib.search(term, { limit: 30 }) }; }
    catch (e) { return { term, res: null }; }
  }));
  for (const { term, res } of results) {
    if (!res) continue;
    // 词越长越可信：2 字滑窗噪声大，权重压低
    const termWeight = term === q ? 1.6 : Math.min(1.4, 0.2 + term.length * 0.22);
    for (const hit of res.hits || []) {
      let score = (hit.where === 'content' ? 2 : 1) * termWeight;
      score += overlap(qg, hit.snippet || '') * 3;
      score += overlap(qg, hit.file || '') * 1;
      // 「取数表」这类模板化表格，正文是空壳列名，对问答价值低；模板次之
      if (/取数表/.test(hit.file || '')) score -= 1.2;
      if (/^模板|【模板】/.test(hit.file || '')) score -= 1.0;
      // 真正的底稿/报告/说明才是问答想要的内容，适当加权
      if (/(底稿|评估说明|资产评估报告|结论|汇总)/.test(hit.file || '')) score += 0.8;
      // 只保留「单路最高分」：命中多个通用词的无关文档不应靠堆分数胜出
      const prev = bucket.get(hit.rel);
      if (!prev || score > prev.baseScore) {
        bucket.set(hit.rel, { ...hit, baseScore: Math.max(score, prev ? prev.baseScore : 0) });
      }
    }
  }

  // 再乘「专名归属」权重：只按项目名判定（文件名里常有委托方字样，不能当归属依据）
  for (const item of bucket.values()) {
    const projName = item.project || '';
    let pinBonus = 0;
    for (const k of pinned) {
      if (!projName.includes(k)) continue;
      const n = spread.get(k) || 200;
      if (k.length <= 2 && n > 3) continue;
      const w = n <= 3 ? 12 : (n <= 12 ? 3 : 0.8);
      if (w > pinBonus) pinBonus = w;
    }
    item.score = item.baseScore * (1 + pinBonus);
  }

  let list = [...bucket.values()].sort((a, b) => b.score - a.score).slice(0, topK);

  // 命中太少时，退回按关键词直接命中文件名/项目的文档
  if (list.length < 2) {
    try {
      const kbRows = await lib.getKb();
      const extra = [];
      for (const r of kbRows) {
        const hay = (r.project + ' ' + r.file + ' ' + (r.subdir || ''));
        if (keys.some(k => hay.includes(k)) || hay.includes(q)) {
          extra.push({ rel: r.rel, project: r.project, file: r.file, subdir: r.subdir,
                       snippet: '', score: 0.5, chars: r.chars || 0, where: 'name' });
        }
      }
      const seen = new Set(list.map(x => x.rel));
      for (const e of extra) if (!seen.has(e.rel) && list.length < topK) list.push(e);
    } catch (e) {}
  }

  // 补正文（截断），供模型阅读。并行读取，避免一个个等。
  const CANDIDATES = Math.min(list.length, topK);
  await Promise.all(list.map(async (item, i) => {
    if (i >= CANDIDATES && item.where !== 'content') { item.text = ''; return; }
    try {
      const t = await lib.docText(item.rel, maxCharsPerDoc);
      item.text = t.text || '';
      item.totalChars = t.totalChars || (t.text || '').length;
      item.note = t.note || '';
    } catch (e) {
      item.text = '';
    }
  }));

  // 编译层优先：wiki 项目页/主题页排在最前，原文片段作为证据补充
  try {
    const wiki = await wikiRetrieve(q, { topK: 3 });
    if (wiki.length) {
      const seen = new Set(wiki.map(x => x.rel));
      list = wiki.concat(list.filter(x => !seen.has(x.rel))).slice(0, topK + wiki.length);
    }
  } catch (e) { /* wiki 层不可用就退回纯原文检索 */ }

  return list;
}

/** 把命中组装成给模型的上下文 */
export function buildContext(items) {
  const blocks = [];
  items.forEach((it, i) => {
    const tag = it.wiki ? '（知识库页面·编译层）' : '';
    const head = `【资料${i + 1}】${it.project} › ${it.file}${tag}`
      + (it.subdir && it.subdir !== '.' && !it.wiki ? `（${it.subdir}）` : '');
    let body = String(it.text || '');
    // wiki 页面带 frontmatter，喂给模型前先剥掉
    body = body.replace(/^---[\s\S]*?\n---\n/, '');
    body = body.replace(/\n{3,}/g, '\n\n').slice(0, it.wiki ? 5000 : 6000);
    blocks.push(`${head}\n${body || '（该文件无可抽取正文）'}`);
  });
  return blocks.join('\n\n---\n\n');
}

const SYSTEM_PROMPT = [
  '你是天源资产评估公司的资料库助手，帮评估师在已归档的历史项目库里查资料。',
  '规则：',
  '1. 只依据下面提供的【资料】回答，不要编造评估数据、文号、金额或结论。',
  '2. 引用时用 [资料N] 标注来源；同一句话可引用多条。',
  '3. 如果资料不足以回答，明确说「库里没找到直接依据」，并指出还差什么资料、可能在哪类底稿里。',
  '4. 回答用简体中文，先给结论，再给依据；需要罗列时用短列表，不要长篇大论。',
  '5. 涉及金额、评估值、比率时原样引用，不要换算或四舍五入。',
].join('\n');

/** 调模型：返回 {answer, usage, model, provider} */
export async function ask(ctx, question, items, opts) {
  const o = opts || {};
  // 模型来源优先级：调用方显式传的（问答界面选的）→ 宿主默认模型
  const sel = (o.selection && o.selection.provider && o.selection.model)
    ? o.selection
    : readSelection(ctx);
  if (!sel || !sel.provider || !sel.model) {
    return { answer: null, error: '没有可用的模型：请在问答面板的模型下拉里选一个，或在 DSH 设置里设置默认模型', items };
  }
  let llm = o.llm || null;
  if (!llm) { try { llm = typeof ctx.get === 'function' ? ctx.get('llm') : null; } catch (e) { llm = null; } }
  if (!llm) { try { llm = ctx.llm; } catch (e) { llm = null; } }
  if (!llm || typeof llm.stream !== 'function') {
    return { answer: null, error: '宿主 llm 服务不可用（插件作用域里取不到 llm）', items };
  }

  const history = (opts && opts.history) || [];
  const messages = [];
  for (const h of history.slice(-6)) {
    if (!h || !h.content) continue;
    messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: [{ type: 'text', text: String(h.content).slice(0, 4000) }] });
  }
  const ctxText = buildContext(items);
  messages.push({
    role: 'user',
    content: [{ type: 'text', text: `【资料】\n${ctxText}\n\n【问题】\n${question}` }],
  });

  const options = {
    provider: sel.provider,
    model: sel.model,
    system: SYSTEM_PROMPT,
    messages,
    temperature: 0.2,
    maxTokens: (opts && opts.maxTokens) || 1600,
    sessionId: (opts && opts.sessionId) || undefined,
    purpose: 'workbench-kb-qa',
  };
  if (sel.reasoningEffort) options.reasoningEffort = sel.reasoningEffort;

  let answer = '';
  let usage = null;
  let finish = null;
  try {
    for await (const chunk of llm.stream(options)) {
      if (chunk.type === 'text-delta') answer += chunk.text;
      else if (chunk.type === 'usage') usage = chunk.usage;
      else if (chunk.type === 'finish') {
        finish = chunk.reason;
        if (chunk.reason && chunk.reason.kind === 'error') {
          return { answer, error: (chunk.reason.failure && chunk.reason.failure.message) || '模型返回错误', usage, items };
        }
      }
    }
  } catch (e) {
    return { answer, error: String((e && e.message) || e), usage, items };
  }
  return { answer, usage, finish, model: sel.model, provider: sel.provider, items };
}

/** 读当前默认模型（兼容服务对象与 plain 字段） */
function readSelection(ctx) {
  try {
    // 先走 ctx.get：直接读 ctx.xxx 在未 inject 的服务上会抛错，被 catch 吞掉就显得「没有模型」
    let svc = null;
    try { svc = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null; } catch (e) { svc = null; }
    if (!svc) { try { svc = ctx.agentDefaultModel; } catch (e) { svc = null; } }
    if (svc && typeof svc.currentSelection === 'function') {
      const s = svc.currentSelection();
      if (s && s.provider && s.model) return s;
    }
  } catch (e) {}
  return null;
}

/** 无模型时的兜底回答：直接把检索结果整理成带出处的摘要 */
export function fallbackAnswer(question, items) {
  if (!items.length) {
    return `没有在库里找到与「${question}」相关的资料。可以换个说法，或只输入关键信息（如项目名、报告文号、科目名）。`;
  }
  const lines = [`没连上模型，先按检索结果给你原始片段（共 ${items.length} 条）：`];
  items.forEach((it, i) => {
    const snip = (it.snippet || it.text || '').replace(/\s+/g, ' ').slice(0, 220);
    lines.push(`\n[资料${i + 1}] ${it.file}（${it.project}）\n${snip || '（无正文片段）'}`);
  });
  return lines.join('\n');
}

export { KB_DIR };

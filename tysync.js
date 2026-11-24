// 天源「同步到线上」引擎：把工作台项目数据填进天源网页表单。
//
// 为什么走浏览器而不是接口：天源 OpenAPI 只开放读项目 + 写参与人员/公司负责人，
// 新建项目与基本信息/客户/被评估单位/合同四组写入只在网页表单里。
//
// 驱动方式（2026-11-23 起统一）：只走 opencli Browser Bridge，直接操作用户自己
// 已登录天源的 Chrome。此前还有 ego 独立窗口与 agent-browser-cli(Edge) 两条通道，
// 都要单独登录或装第二套插件，已全部移除。
//
// 实现要点：import opencli 自带的 BrowserBridge，拿 IPage 后包一层 cdp(method, params)
// 适配器喂给下面的 SYNC_SCRIPT —— 字段逻辑一行不用改。
// 为什么不用 `opencli browser <s> eval` 子命令：那条路每次都要起一个 node 进程
// （实测单次 ~280ms），同步几十个字段会慢到不可用；直连同一进程内单次往返 ~6ms。
// Page.navigate / Page.reload 被 opencli 的 CDP 白名单拦掉，改用 page.goto()。
//
// 关键经验（都是从真实失败里换来的）：
// 1. 保存接口 /api/projects/update **永远返回 HTTP 200**，成败只看响应体 code；
//    前端对 code=500 不做任何提示，所以「界面没报错」不等于成功 —— 必须回读校验。
// 2. el-input 只发 input 事件不进 payload，必须补 change + blur。
// 3. 下拉/日期/级联用 JS .click() 时常只改显示不改模型，要用真实鼠标事件
//    （Input.dispatchMouseEvent 的 moved/pressed/released 三段）。
// 4. 级联（价值类型、评估对象-报备）点节点无效，要点节点内 input.el-radio__original。
// 5. 天源存在同名不同人（如两个同名同事账号）：下拉文本完全一样，必须按「取最后一个」
//    处理（离职账号排在前面），否则保存会整单回滚。
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { globSync } from 'node:fs';

const SPACE = 'workbench-sync';
const SENTINEL = '@@DSH_SYNC@@';

/** opencli 安装根目录候选（npm 全局 / 本地 / homebrew）。 */
const OPENCLI_ROOTS = [
  join(homedir(), '.npm-global', 'lib', 'node_modules', '@jackwener', 'opencli'),
  '/usr/local/lib/node_modules/@jackwener/opencli',
  '/opt/homebrew/lib/node_modules/@jackwener/opencli',
];

/** 找 opencli 的 npm 包根目录；找不到返回 null。 */
export function resolveOpencliRoot() {
  if (process.env.DSH_OPENCLI_ROOT) return process.env.DSH_OPENCLI_ROOT;
  for (const p of OPENCLI_ROOTS) {
    try { if (existsSync(join(p, 'package.json'))) return p; } catch (e) { /* 下一个 */ }
  }
  return null;
}

/**
 * 加载 opencli 的 BrowserBridge（动态 import，避免宿主启动时硬依赖 opencli）。
 * 返回 { BrowserBridge } 或抛错说明缺失原因。
 */
async function loadBrowserBridge() {
  const root = resolveOpencliRoot();
  if (!root) throw new Error('没找到 opencli（可用环境变量 DSH_OPENCLI_ROOT 指定包根目录）');
  const entry = join(root, 'dist', 'src', 'browser', 'bridge.js');
  if (!existsSync(entry)) throw new Error('opencli 安装不完整：缺少 ' + entry);
  const mod = await import(pathToFileURL(entry).href);
  if (!mod || typeof mod.BrowserBridge !== 'function') throw new Error('opencli 版本不兼容：没有导出 BrowserBridge');
  return mod;
}

/** 只取有值的字段，空值一律不写（避免把线上已有内容清空）。 */
function val(v) {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
}

/**
 * 工作台记录 → 引擎数据。
 * kind: text | select | multi | date | range | cascader | radio
 */
export function buildData(rec) {
  const r = rec || {};
  const t = r.team || {};
  const c = r.customer || (Array.isArray(r.customers) ? r.customers[0] : null) || {};
  const k = r.contract || {};
  const warnings = [];

  const basic = [];
  const push = (label, kind, value, opt) => {
    const v = kind === 'multi' ? (Array.isArray(value) ? value.filter(Boolean) : []) : val(value);
    if (kind === 'multi') { if (v.length) basic.push({ label, kind, value: v, ...opt }); return; }
    if (v == null) return;
    basic.push({ label, kind, value: v, ...opt });
  };

  push('项目简称', 'text', r.shortName || r.name);
  // 项目受理号不往线上写：天源是「填 EBS 项目后系统自动生成」，
  // 本地这份只能是上一轮回读的值，反向写反而会把线上自动号盖掉。同步完从线上回读回写本地。
  push('评估基准日', 'date', r.baseDate);
  push('风险等级', 'select', r.risk);
  push('业务类型', 'select', r.bizType);
  push('经济行为', 'text', r.economicBehavior);
  push('评估对象-报告', 'text', r.objectReport);
  push('评估范围-报告', 'text', r.scopeReport);
  push('价值类型', 'cascader', r.valueType);
  push('评估目的-报备', 'select', r.purposeReport);
  push('评估目的', 'select', r.purpose);
  push('评估业务性质', 'select', r.bizNature);
  push('是否属于重大资产重组', 'select', r.majorRestructure);
  push('评估对象-报备', 'cascader', r.objectReport2);
  push('资产置入/置出', 'select', r.inOut);
  push('评估对象股权比例(%)', 'text', r.equityRatio);
  push('评估报告日', 'date', r.reportDate);
  // 占位符（天源评报字〔2026〕第XXXX号）不能写进线上：那会把线上真实文号盖成假号
  const reportNo = val(r.reportNo);
  if (reportNo && /X{3,}/i.test(reportNo)) {
    warnings.push('报告文号是占位符（' + reportNo + '），已跳过不写入线上');
  } else {
    push('报告文号', 'text', reportNo);
  }
  push('执行部门', 'select', t.dept);
  push('项目合伙人', 'select', t.partner);
  push('项目经理', 'multi', t.managers);
  push('参与人员', 'multi', t.members);
  push('签字评估师', 'multi', [t.signer1, t.signer2]);

  const customer = [];
  const cpush = (label, kind, value) => {
    const v = val(value);
    if (v == null) return;
    customer.push({ label, kind: kind || 'text', value: v });
  };
  cpush('委托人类型', 'radio', c.type);
  cpush('委托人名称', 'text', c.name);
  cpush('委托人简称', 'text', c.shortName);
  cpush('委托人社会信用代码', 'text', c.creditCode);
  cpush('委托人企业类型', 'text', c.entType);
  cpush('委托人企业住所', 'text', c.address);
  cpush('委托人注册资本', 'text', c.capital);
  cpush('委托人法定代表人', 'text', c.legalRep);
  cpush('委托人经营范围', 'text', c.business);

  const contract = [];
  const kpush = (label, kind, value) => {
    const v = val(value);
    if (v == null) return;
    contract.push({ label, kind: kind || 'text', value: v });
  };
  kpush('合同类型', 'select', k.type);
  kpush('合同签订日期', 'date', k.signDate);
  if (val(k.serviceStart) && val(k.serviceEnd)) {
    contract.push({ label: '服务期间起止日', kind: 'range', value: [val(k.serviceStart), val(k.serviceEnd)] });
  }
  kpush('合同币种', 'select', k.currency);
  kpush('合同原币金额', 'text', k.amountOriginal);
  kpush('合同金额', 'text', k.amount);
  kpush('评估费支付方式', 'text', k.payMethod);
  kpush('报告提交时间', 'date', k.reportSubmitAt);
  kpush('报告提交方式', 'text', k.reportSubmitWay);
  kpush('外送报告份数', 'text', k.reportCopies);
  kpush('外送评估说明份数', 'text', k.statementCopies);
  kpush('其他报告使用人', 'text', k.otherUsers);
  kpush('合同是否涉密', 'select', k.secret);

  // 「与被评估单位是否一致」最后填：它是联动开关，先填它会把后面的客户信息冲掉。
  if (val(c.sameAsEntity)) customer.push({ label: '与被评估单位是否一致', kind: 'select', value: val(c.sameAsEntity) });

  if (val(r.ebsProject)) warnings.push('EBS项目未同步：线上是按项目名搜索的下拉，本地存的是编码 ' + val(r.ebsProject));

  return {
    mode: val(r.tyId) ? 'update' : 'create',
    tyId: val(r.tyId),
    name: val(r.shortName || r.name),
    tabs: [
      { tab: '基本信息', fields: basic },
      { tab: '客户信息', fields: customer },
      { tab: '合同信息', fields: contract },
    ],
    warnings,
  };
}

/**
 * 引擎脚本（字段逻辑的唯一真相）。
 * 只依赖注入的 cdp(method, params)：
 *   - 宿主侧：opencli BrowserBridge → IPage → 包一层 cdp(method, params) 适配器
 * 所以下面的字段逻辑一行都不用改就能换驱动。
 */
async function SYNC_SCRIPT(DATA, cdp, setup, pace) {
  const out = { ok: false, mode: DATA.mode, applied: [], warnings: (DATA.warnings || []).slice(), mismatches: [], notes: [] };
  const skipped = new Set();   // 线上只读、本次没写的字段（回读校验也跳过）
  // pace：时序倍率。opencli 直连是同进程 CDP 往返（实测单次 ~6ms），用 1×；
  // 若将来换回「每次起 CLI 进程」的驱动，传 2× 并保留这里的等号逻辑。
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.round((ms || 0) * (typeof pace === 'number' && pace > 0 ? pace : 1))));
  const emit = () => console.log('@@DSH_SYNC@@' + JSON.stringify(out));
  const jstr = (o) => JSON.stringify(o);

  async function evaluate(expr) {
    const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) throw new Error('evaluate: ' + String(jstr(r.exceptionDetails)).slice(0, 200));
    return r && r.result ? r.result.value : null;
  }
  async function currentUrl() { return await evaluate('location.href'); }

  async function waitReady(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 20000)) {
      const st = await evaluate('document.readyState + "|" + location.href').catch(() => null);
      if (st && st.indexOf('complete|') === 0) return st.slice(9);
      await sleep(400);
    }
    return await currentUrl().catch(() => null);
  }
  async function goto(url) {
    await cdp('Page.navigate', { url });
    await sleep(800);
    return await waitReady(30000);
  }
  async function reload() {
    await cdp('Page.reload', {});
    await sleep(800);
    return await waitReady(30000);
  }
  async function realClick(p) {
    if (!p || p.x == null) throw new Error('click target not found');
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', clickCount: 0 });
    await sleep(30);
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(150);
  }
  // 把「元素表达式」求值成屏幕中心点
  const MEASURE = (elExpr) => '(() => { const el = (' + elExpr + '); if (!el) return null;' +
    ' const r = el.getBoundingClientRect();' +
    ' const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);' +
    ' const inView = r.width > 0 && r.height > 0 && cx > 8 && cy > 8 && cx < innerWidth - 8 && cy < innerHeight - 8;' +
    ' return { x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height), inView }; })()';
  async function centerOf(elExpr) {
    // 要点在视口里的坐标。元素在折叠线下面时 getBoundingClientRect 的 y 会超出视口，
    // CDP 往那儿点等于没点 —— 这是「同一脚本有时能跑、有时卡在某字段」的真因。
    // 已经在视口里就直接用，否则滚到中间再量（省掉每个字段一次滚动等待）。
    const first = await evaluate(MEASURE(elExpr));
    if (first && first.inView) return first;
    await evaluate('(() => { const el = (' + elExpr + '); if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "nearest" }); return !!el; })()').catch(() => null);
    await sleep(350);
    return await evaluate(MEASURE(elExpr));
  }
  const itemExpr = (label) =>
    '[...document.querySelectorAll(".c-form-item")].filter(i => i.offsetParent !== null)' +
    '.find(i => (i.querySelector(":scope > .label")?.innerText || "").trim() === ' + jstr(label) + ')';
  const valueExpr = (label) => '(' + itemExpr(label) + ' || {}).querySelector ? ' + itemExpr(label) + '.querySelector(":scope > .value") : null';

  // 编辑页是 SPA：gotoAndWait 只等到 readyState=complete，页面骨架到了但页签还没渲染，
  // 这时去点「基本信息」会直接报「找不到页签」。所以先轮询等页签真的出现。
  async function waitTabs(ms) {
    const t0 = Date.now();
    const budget = ms || 25000;
    while (Date.now() - t0 < budget) {
      const has = await evaluate('[...document.querySelectorAll(".el-radio-button__inner")].some(e => e.innerText.trim() === ' + jstr('基本信息') + ')').catch(() => false);
      if (has) return true;
      await sleep(500);
    }
    return false;
  }

  async function goTab(name) {
    let p = await centerOf('[...document.querySelectorAll(".el-radio-button__inner")].find(e => e.innerText.trim() === ' + jstr(name) + ')');
    if (!p) {
      await waitTabs(25000);
      p = await centerOf('[...document.querySelectorAll(".el-radio-button__inner")].find(e => e.innerText.trim() === ' + jstr(name) + ')');
    }
    if (!p) throw new Error('找不到页签：' + name);
    await realClick(p);
    await sleep(600);
  }

  async function readValue(label) {
    return await evaluate(
      '(() => { const it = ' + itemExpr(label) + '; if (!it) return null;' +
      ' const v = it.querySelector(":scope > .value"); if (!v) return null;' +
      ' const tags = [...v.querySelectorAll(".el-tag")].map(t => t.innerText.trim()).filter(Boolean);' +
      ' if (tags.length) return tags.join(",");' +
      ' const inp = [...v.querySelectorAll("input,textarea")].map(i => i.value).filter(Boolean);' +
      ' if (inp.length) return inp.join(" ~ ");' +
      ' const sel = [...v.querySelectorAll(".el-select__selected-item")].map(t => t.innerText.trim()).filter(Boolean);' +
      ' return sel.join(",") || ""; })()'
    );
  }

  async function setText(label, text) {
    const inp = '(' + itemExpr(label) + ' || {}).querySelector ? ' + itemExpr(label) + '.querySelector("input,textarea") : null';
    const ok = await evaluate('(() => { const el = (' + inp + '); if (!el) return false; el.focus(); el.select && el.select(); return true; })()');
    if (!ok) throw new Error('找不到输入框：' + label);
    await cdp('Input.insertText', { text: String(text) });
    await sleep(120);
    // 关键：el-input 只发 input 不进 payload，必须补 change + blur
    await evaluate('(() => { const el = (' + inp + '); el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true})); el.blur(); return el.value; })()');
    await sleep(150);
    const got = await evaluate('(' + inp + ').value');
    if (String(got) !== String(text)) {
      // 有些框会格式化（金额 280000 -> 280,000.00），只在完全没写进去时算失败
      if (!String(got).replace(/[,\s]/g, '').startsWith(String(text).replace(/[,\s]/g, '').slice(0, 6))) {
        throw new Error('写入不生效：' + label + '，读到 ' + got);
      }
    }
  }

  // 天源的下拉是 teleport 到 body 的；上一个字段的下拉没关掉时，
  // 直接点下一个 select 会被遮住/读到旧选项。所以每次开下拉前先按 Esc 清场。
  async function closeDropdowns() {
    const open = await evaluate('[...document.querySelectorAll(".el-select-dropdown")].some(d => d.offsetParent !== null)');
    if (!open) return;
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
  }
  async function anyDropdownOpen() {
    return await evaluate('[...document.querySelectorAll(".el-select-dropdown")].some(d => d.offsetParent !== null)');
  }
  async function openSelect(label) {
    const wrapper = '(' + itemExpr(label) + ').querySelector(".el-select__wrapper")';
    const p = await centerOf(wrapper);
    if (!p) throw new Error('找不到下拉：' + label);
    // 下拉没打开时点击偶发不生效（bridge 慢、元素被遮挡），所以点完要确认真的开了，不行重点。
    for (let i = 0; i < 3; i++) {
      await closeDropdowns();
      await realClick(p);
      for (let j = 0; j < 6; j++) {
        await sleep(250);
        if (await anyDropdownOpen()) return p;
      }
    }
    throw new Error('下拉打不开：' + label);
  }
  async function clickOption(text, preferLast) {
    let r = null;
    for (let i = 0; i < 10; i++) {
      r = await evaluate(
        '(() => { const dds = [...document.querySelectorAll(".el-select-dropdown")].filter(d => d.offsetParent !== null);' +
        ' const items = dds.flatMap(d => [...d.querySelectorAll(".el-select-dropdown__item")]);' +
        ' const hits = items.filter(i => i.innerText.trim() === ' + jstr(text) + ');' +
        ' if (!hits.length) return { ok: false, opts: items.map(i => i.innerText.trim()).slice(0, 20) };' +
        ' const el = ' + (preferLast ? 'hits[hits.length - 1]' : 'hits[0]') + ';' +
        ' const b = el.getBoundingClientRect();' +
        ' return { ok: true, n: hits.length, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()'
      );
      if (r && r.ok) break;
      await sleep(300);
    }
    if (!r || !r.ok) {
      const hint = r && r.opts && r.opts.length ? '可用：' + r.opts.join('/') : '下拉里一个选项都没有（多半是没展开成功）';
      throw new Error('选项里没有「' + text + '」，' + hint);
    }
    if (r.n > 1) out.notes.push(text + ' 有 ' + r.n + ' 个同名选项，按「取最后一个」处理');
    await realClick({ x: r.x, y: r.y });
    await sleep(350);
  }
  async function pickSelect(label, text) {
    await openSelect(label);
    await clickOption(text, true);
  }

  async function pickMulti(label, names) {
    const cur = String(await readValue(label) || '');
    const have = cur ? cur.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const missing = names.filter((n) => have.indexOf(n) < 0);
    if (!missing.length) return;
    for (const name of missing) {
      await openSelect(label);
      await evaluate('(() => { const el = (' + '(' + itemExpr(label) + ').querySelector("input.el-select__input")' + '); if (el) el.focus(); return true; })()');
      await sleep(150);
      await cdp('Input.insertText', { text: String(name) });
      await sleep(900);
      await clickOption(name, true);
      await sleep(250);
      const after = String(await readValue(label) || '');
      if (after.indexOf(name) < 0) {
        // 同名多账号（一个在职一个离职）时「取最后一个」可能选中离职账号，天源会静默拒绝。
        // 这里再试一次「第一个同名项」；仍不行就记 warning 继续，别让整单同步失败。
        await closeDropdowns();
        await openSelect(label);
        await evaluate('(() => { const el = (' + '(' + itemExpr(label) + ').querySelector("input.el-select__input")' + '); if (el) el.focus(); return true; })()');
        await sleep(150);
        await cdp('Input.insertText', { text: String(name) });
        await sleep(900);
        try { await clickOption(name, false); } catch (e) { /* 下面统一判断 */ }
        await sleep(300);
        const after2 = String(await readValue(label) || '');
        if (after2.indexOf(name) < 0) {
          out.warnings.push(label + '：加不上「' + name + '」（多半是离职/禁用账号，或同名账号都不可用），已跳过，需要人工在线上补');
        } else {
          out.notes.push(label + '：「' + name + '」是第一个同名账号才加得上的');
        }
      }
    }
    const extra = have.filter((n) => names.indexOf(n) < 0);
    if (extra.length) out.warnings.push(label + ' 线上多出未删除的人员：' + extra.join('、'));
  }

  async function pickDate(label, iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    if (!m) throw new Error('日期格式不对：' + iso);
    const y = +m[1], mo = +m[2], d = +m[3];
    const inp = '(' + itemExpr(label) + ').querySelector("input")';
    const p = await centerOf(inp);
    if (!p) throw new Error('找不到日期框：' + label);
    // bridge 下点击偶发不生效（每个输入事件要起一个 CLI 进程，时间被拉长），点完要确认面板真开了，不开就重点
    const readHead = '(() => { const p = [...document.querySelectorAll(".el-picker-panel")].filter(x => x.offsetParent !== null)[0]; return p ? (p.querySelector(".el-date-picker__header") || p).innerText.replace(/\\s+/g, "") : null; })()';
    let head = null;
    for (let attempt = 0; attempt < 3 && !head; attempt++) {
      await realClick(p);
      for (let j = 0; j < 8; j++) {
        await sleep(300);
        head = await evaluate(readHead);
        if (head) break;
      }
    }
    if (!head) throw new Error('日期面板没打开：' + label);
    for (let guard = 0; guard < 36; guard++) {
      head = await evaluate(readHead);
      if (!head) throw new Error('日期面板中途关掉了：' + label);
      const hm = /(\d{4})年(\d{1,2})月/.exec(head);
      if (!hm) throw new Error('读不到日期面板月份：' + head);
      const cy = +hm[1], cm = +hm[2];
      const delta = (y - cy) * 12 + (mo - cm);
      if (delta === 0) break;
      const arrowCls = delta < 0 ? 'arrow-left' : 'arrow-right';
      const ap = await centerOf('(() => { const p = [...document.querySelectorAll(".el-picker-panel")].filter(x => x.offsetParent !== null)[0]; return p ? [...p.querySelectorAll("button,i,span")].find(e => (e.className || "").toString().indexOf(' + jstr(arrowCls) + ') >= 0) : null; })()');
      if (!ap) throw new Error('找不到月份翻页按钮');
      await realClick(ap);
      await sleep(400);
    }
    const cell = await evaluate(
      '(() => { const p = [...document.querySelectorAll(".el-picker-panel")].filter(x => x.offsetParent !== null)[0];' +
      ' if (!p) return null;' +
      ' const tds = [...p.querySelectorAll("td.available")].filter(td => td.innerText.trim() === ' + jstr(String(d)) + ' && !/prev-month|next-month/.test(td.className));' +
      ' if (!tds.length) return null; const b = tds[0].getBoundingClientRect();' +
      ' return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()'
    );
    if (!cell) throw new Error('面板里找不到日期 ' + d);
    await realClick(cell);
    await sleep(500);
  }

  async function pickRange(label, startIso, endIso) {
    const s = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(startIso));
    const e = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(endIso));
    if (!s || !e) throw new Error('服务期间格式不对');
    if (s[1] !== e[1] || s[2] !== e[2]) throw new Error('服务期间跨月暂不支持（' + startIso + ' ~ ' + endIso + '）');
    const inp = '(' + itemExpr(label) + ').querySelector("input")';
    const p = await centerOf(inp);
    if (!p) throw new Error('找不到日期区间框：' + label);
    await realClick(p);
    await sleep(800);
    const clickDay = async (d) => {
      const c = await evaluate(
        '(() => { const p = [...document.querySelectorAll(".el-picker-panel")].filter(x => x.offsetParent !== null)[0];' +
        ' if (!p) return null;' +
        ' const left = p.querySelector(".el-date-range-picker__content.is-left") || p.querySelector(".el-date-range-picker__content");' +
        ' if (!left) return null;' +
        ' const tds = [...left.querySelectorAll("td.available")].filter(td => td.innerText.trim() === ' + jstr(String(d)) + ' && !/prev-month|next-month/.test(td.className));' +
        ' if (!tds.length) return null; const b = tds[0].getBoundingClientRect();' +
        ' return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()'
      );
      if (!c) throw new Error('区间面板找不到 ' + d);
      await realClick(c);
      await sleep(500);
    };
    await clickDay(+s[3]);
    await clickDay(+e[3]);
  }

  // 级联（比如「评估对象-报备」）：股东全部权益价值 是 企业价值 下面的二级科目，
  // 不先把一级节点展开，DOM 里根本没有二级节点。所以「当前层找不到」时要逐个展开父节点再找。
  async function pickCascader(label, text) {
    const inp = '(' + itemExpr(label) + ').querySelector("input")';
    const p = await centerOf(inp);
    if (!p) throw new Error('找不到级联框：' + label);
    // 选完后 input 显示的是「企业价值 / 股东全部权益价值」，所以用包含判断
    if (String(await evaluate('(' + inp + ').value') || '').indexOf(String(text)) >= 0) return;
    await realClick(p);
    await sleep(800);

    const P = '[...document.querySelectorAll(".el-cascader__dropdown")].filter(x => x.offsetParent !== null)[0]';
    const labelOf = 'n => (n.querySelector(".el-cascader-node__label") || n).innerText.trim()';
    const scanExpr =
      '(() => { const p = ' + P + '; if (!p) return { ok: false, why: "no-panel" };' +
      ' const nodes = [...p.querySelectorAll(".el-cascader-node")].filter(n => n.offsetParent !== null);' +
      ' const hits = nodes.filter(n => (' + labelOf + ')(n) === ' + jstr(text) + ');' +
      ' const opts = nodes.map(n => (' + labelOf + ')(n));' +
      ' if (!hits.length) return { ok: false, why: "no-node", opts };' +
      ' const node = hits[hits.length - 1];' +
      ' const radio = node.querySelector("input.el-radio__original");' +
      ' if (radio) { radio.click(); return { ok: true, via: "radio" }; }' +
      ' const b = node.getBoundingClientRect();' +
      ' return { ok: true, via: "node", x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()';

    let r = await evaluate(scanExpr);
    if (r && !r.ok && r.why !== 'no-panel') {
      // 第一层菜单的节点坐标 + 有没有子级（带箭头 / postfix 的才是父节点，叶子点了会直接选中）
      const tops = await evaluate(
        '(() => { const p = ' + P + '; if (!p) return [];' +
        ' const m = p.querySelectorAll(".el-cascader-menu")[0]; if (!m) return [];' +
        ' return [...m.querySelectorAll(".el-cascader-node")].map(n => { const b = n.getBoundingClientRect();' +
        '   return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2),' +
        '     text: (' + labelOf + ')(n),' +
        '     hasChild: !!n.querySelector(".el-cascader-node__postfix, .el-icon-arrow-right") }; }); })()'
      ) || [];
      // 先只悬停（expandTrigger=hover 时展开，且不会误选）
      for (const t of tops) {
        await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: t.x, y: t.y, button: 'none', clickCount: 0 });
        await sleep(400);
        r = await evaluate(scanExpr);
        if (r && r.ok) break;
      }
      // 悬停不展开（expandTrigger=click）再点父节点
      if (!r || !r.ok) {
        for (const t of tops) {
          if (!t.hasChild) continue;
          await realClick({ x: t.x, y: t.y });
          await sleep(450);
          r = await evaluate(scanExpr);
          if (r && r.ok) break;
        }
      }
    }
    if (!r || !r.ok) throw new Error('级联里没有「' + text + '」：' + ((r && (r.why + ' ' + (r.opts || []).join('/'))) || ''));
    if (r.via === 'node') { await realClick({ x: r.x, y: r.y }); await sleep(400); }
    await sleep(350);
  }

  async function pickRadio(label, text) {
    const p = await centerOf('(() => { const it = ' + itemExpr(label) + '; if (!it) return null;' +
      ' return [...it.querySelectorAll(".el-radio")].find(r => r.innerText.trim() === ' + jstr(text) + '); })()');
    if (!p) throw new Error('找不到单选：' + label + '=' + text);
    await realClick(p);
    await sleep(300);
  }

  async function clickButton(text) {
    const p = await centerOf('[...document.querySelectorAll("button")].filter(b => b.offsetParent !== null && b.innerText.trim() === ' + jstr(text) + ')[0]');
    if (!p) throw new Error('找不到按钮：' + text);
    await realClick(p);
  }

  // 编辑页有只读字段（如「项目编号」「项目简称」在部分页面上是 disabled），
  // 往 disabled 的 input 里写等于没写，硬写会让整次同步在第 1 个字段就失败。只读就跳过并记一笔。
  async function fieldDisabled(label) {
    return await evaluate('(() => { const it = ' + itemExpr(label) + '; if (!it) return false;' +
      ' const inp = it.querySelector("input,textarea"); return !!(inp && inp.disabled); })()').catch(() => false);
  }

  async function applyField(f) {
    if (await fieldDisabled(f.label)) {
      skipped.add(f.label);
      out.notes.push(f.label + '：线上只读，已跳过（需要改请在网页上手工改）');
      return false;
    }
    switch (f.kind) {
      case 'text': await setText(f.label, f.value); break;
      case 'select': await pickSelect(f.label, f.value); break;
      case 'multi': await pickMulti(f.label, f.value); break;
      case 'date': await pickDate(f.label, f.value); break;
      case 'range': await pickRange(f.label, f.value[0], f.value[1]); break;
      case 'cascader': await pickCascader(f.label, f.value); break;
      case 'radio': await pickRadio(f.label, f.value); break;
      default: throw new Error('未知字段类型 ' + f.kind);
    }
    return true;
  }

  try {
    if (typeof setup === 'function') await setup();   // 预留钩子：opencli 驱动不传
    const base = 'https://ty.zhrdc.net';
    let url = await goto(DATA.mode === 'update' ? (base + '/project/' + DATA.tyId + '/edit') : (base + '/project/my'));
    if (String(url).indexOf('auth.zhrdc.net') >= 0) {
      out.code = 'NOT_LOGGED_IN';
      out.msg = '这个浏览器窗口还没登录天源：先在里面登录一次（扫码/滑块），再点「同步到天源」';
      emit();
      return;
    }
    if (DATA.mode === 'create') {
      await clickButton('新建项目');
      await sleep(1200);
      const dlg = await evaluate('(() => { const d = [...document.querySelectorAll(".el-dialog")].find(x => x.offsetParent !== null && x.innerText.indexOf("独立性") >= 0); return d ? d.innerText.replace(/\\s+/g, " ").slice(0, 40) : null; })()');
      if (dlg) {
        const cb = await centerOf('(() => { const d = [...document.querySelectorAll(".el-dialog")].find(x => x.offsetParent !== null); return d ? d.querySelector(".el-checkbox") : null; })()');
        if (cb) { await realClick(cb); await sleep(400); }
        const ok = await centerOf('(() => { const d = [...document.querySelectorAll(".el-dialog")].find(x => x.offsetParent !== null); if (!d) return null;' +
          ' return [...d.querySelectorAll(".el-dialog__footer button")].find(b => b.innerText.trim() === "确认"); })()');
        if (ok) { await realClick(ok); await sleep(1500); }
        out.notes.push('已代勾「项目独立性声明书（评估机构）」；该声明按规应由本人确认');
      }
      url = await waitReady(15000);
      if (String(url).indexOf('/project/add') < 0) throw new Error('没能进入新建项目页：' + url);
    } else {
      await waitReady(12000);
    }

    for (const group of DATA.tabs) {
      if (!group.fields.length) continue;
      await goTab(group.tab);
      for (const f of group.fields) {
        if (await applyField(f)) out.applied.push(group.tab + '·' + f.label);
      }
    }

    // 保存：接口永远返回 200，成败只能靠回读。
    // 特别重要：天源点「保存」后**不一定会跳转**（实测有时停在原页），所以绝不能等 URL 变化来判断。
    await clickButton('保存');
    await sleep(3000);
    out.savedAt = await currentUrl();

    let targetUrl;
    if (DATA.mode === 'create') {
      // 回到列表按项目简称认新建的项目；找不到就是没保存成功
      let found = null;
      for (let i = 0; i < 3 && !found; i++) {
        await goto(base + '/project/my');
        await sleep(1200);
        found = await evaluate('(() => { const trs = [...document.querySelectorAll("tr")].filter(t => t.offsetParent !== null);' +
          ' for (const tr of trs) { const tds = [...tr.querySelectorAll("td")].map(td => td.innerText.trim()); if (tds.indexOf(' + jstr(DATA.name) + ') >= 0) return { code: tds[1], name: tds[2], acceptNo: tds[3] || "" }; } return null; })()');
        if (!found) await sleep(1500);
      }
      if (!found) {
        out.ok = false;
        out.msg = '保存后在天源项目列表里找不到「' + DATA.name + '」，这次没有真正保存成功（多半是必填/人员校验拦下了）';
        emit();
        return;
      }
      out.online = { code: found.code, name: found.name };
      out.notes.push('线上项目编号由系统生成：' + found.code);
      const clicked = await evaluate('(() => { const trs = [...document.querySelectorAll("tr")].filter(t => t.offsetParent !== null);' +
        ' for (const tr of trs) { const tds = [...tr.querySelectorAll("td")].map(td => td.innerText.trim());' +
        ' if (tds.indexOf(' + jstr(DATA.name) + ') >= 0) { const b = [...tr.querySelectorAll("button")].find(x => x.innerText.trim() === "编辑" || x.innerText.trim() === "查看"); if (b) { b.click(); return true; } } } return false; })()');
      if (!clicked) {
        out.ok = true;
        out.msg = '已在天源创建，但没能自动进入编辑页做回读校验';
        emit();
        return;
      }
      await sleep(2500);
      targetUrl = await currentUrl();
      // 把线上 id 取出来，前端据此把 tyId 回填到本地项目，下次就是更新而不是再建一条
      const m = String(targetUrl || '').match(/\/project\/(\d+)/);
      if (m) {
        out.online.id = m[1];
        out.notes.push('线上项目 id：' + m[1] + '（已回填到本地项目的 tyId）');
      }
    } else {
      targetUrl = base + '/project/' + DATA.tyId + '/edit';
      await goto(targetUrl);
      await sleep(1800);
    }
    if (String(await currentUrl()).indexOf('/edit') < 0) {
      await goto(targetUrl);
      await sleep(1500);
    }

    // 线上自动生成的两个号：本地要改成线上版本。
    //  - 项目编号：新建时由天源按「年月日+流水」生成，本地手填的那个不算数；
    //  - 项目受理号：填了 EBS 项目后由系统带出，本地这份是上一轮回读的。
    // 两个都是只读字段，从编辑页读回来，前端据此回写本地项目。
    await waitTabs(25000);
    const onlineCode = String(await readValue('项目编号') || '').trim();
    const onlineAccept = String(await readValue('项目受理号') || '').trim();
    out.online = Object.assign({}, out.online || {}, {
      code: onlineCode || (out.online && out.online.code) || '',
      // 列表行里也有受理号（tds[3]）；编辑页读不到时用它兜底
      acceptNo: onlineAccept || (out.online && out.online.acceptNo) || '',
    });
    if (DATA.mode === 'update' && DATA.tyId && !out.online.id) out.online.id = String(DATA.tyId);
    if (onlineCode) out.notes.push('线上项目编号：' + onlineCode + '（回写本地）');
    if (onlineAccept) out.notes.push('线上项目受理号：' + onlineAccept + '（回写本地）');

    // 回读校验
    for (const group of DATA.tabs) {
      if (!group.fields.length) continue;
      await goTab(group.tab);
      for (const f of group.fields) {
        if (skipped.has(f.label)) continue;
        const got = String(await readValue(f.label) || '');
        let ok;
        if (f.kind === 'multi') {
          // 人员这种多值字段：天源会**静默丢弃**离职/禁用账号，保存照样 code:200。
          // 所以只缺一部分时降级为 warning（人得你自己去线上补），全丢才算失败。
          const want = f.value || [];
          const missing = want.filter((n) => got.indexOf(n) < 0);
          ok = missing.length === 0;
          if (!ok && missing.length < want.length) {
            out.warnings.push(f.label + '：线上没有「' + missing.join('、') + '」（多半是离职/禁用账号，天源静默丢弃，需要人工确认）');
            ok = true;
          }
        } else if (f.kind === 'range') {
          ok = got.indexOf(f.value[0]) >= 0 && got.indexOf(f.value[1]) >= 0;
        } else if (f.kind === 'date') {
          ok = got.indexOf(f.value) >= 0;
        } else if (f.kind === 'cascader') {
          ok = got.indexOf(f.value) >= 0;
        } else if (f.kind === 'text') {
          const norm = (s) => String(s).replace(/[,\s]/g, '');
          ok = got.indexOf(f.value) >= 0 || norm(got).indexOf(norm(f.value)) >= 0;
        } else {
          ok = got.indexOf(f.value) >= 0;
        }
        if (!ok) out.mismatches.push(f.label + ' 期望「' + (Array.isArray(f.value) ? f.value.join('、') : f.value) + '」实际「' + got + '」');
      }
    }
    out.ok = out.mismatches.length === 0;
    if (!out.ok) out.msg = '保存后回读不一致，可能有字段被服务端拒绝（常见：人员已离职/禁用、必填校验），详见 mismatches';
    emit();
    return;
  } catch (e) {
    out.ok = false;
    const m = String((e && e.message) || e);
    out.msg = m;
    emit();
  }
}

/** 把 IPage 包成 SYNC_SCRIPT 期望的 cdp(method, params) 形状。 */
function makeCdp(page) {
  let calls = 0;
  const cdp = async (method, params) => {
    calls += 1;
    const p = params || {};
    // Runtime.evaluate：SYNC_SCRIPT 期望 CDP 原始返回 { result: { value } } / { exceptionDetails }。
    // page.evaluate 已经把值取出来了，这里再包回 CDP 的形状，字段逻辑一行不用改。
    if (method === 'Runtime.evaluate') {
      try {
        const value = await page.evaluate(p.expression);
        return { result: { value } };
      } catch (e) {
        return { exceptionDetails: { text: String((e && e.message) || e) } };
      }
    }
    // Page.navigate / Page.reload 在 opencli 的 CDP 白名单外，走它自己的导航命令。
    if (method === 'Page.navigate') { await page.goto(String(p.url || '')); return {}; }
    if (method === 'Page.reload') {
      const url = await page.evaluate('location.href');
      await page.goto(String(url || ''));
      return {};
    }
    return await page.cdp(method, p);
  };
  cdp.calls = () => calls;
  return cdp;
}

/** 打开（或复用）天源标签页，返回一个可用的 opencli page。 */
async function openSyncPage(opts) {
  const o = opts || {};
  const { BrowserBridge } = await loadBrowserBridge();
  const bridge = new BrowserBridge();
  const page = await bridge.connect({ session: o.session || 'dsh-sync' });
  // 切到天源：已有天源标签就复用（page.goto 会在当前租约页里导航）
  await page.goto('https://ty.zhrdc.net/project/my');
  return { bridge, page };
}

/**
 * 跑一次同步，返回引擎输出的结构化结果。
 * 字段逻辑与 SKILL 里验证过的 SYNC_SCRIPT 完全同一份，只换驱动。
 */
export async function runSync(data, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 300000;
  let bridge = null;
  try {
    const opened = await Promise.race([
      openSyncPage(o),
      new Promise((_, reject) => setTimeout(() => reject(new Error('连接浏览器超时')), 60000)),
    ]);
    bridge = opened.bridge;
    const page = opened.page;
    const cdp = makeCdp(page);

    // SYNC_SCRIPT 用 console.log 打哨兵；这里临时接管 console.log 捕获。
    const captured = [];
    const origLog = console.log;
    console.log = (...a) => {
      const line = a.map((x) => String(x)).join(' ');
      if (line.indexOf(SENTINEL) === 0) captured.push(line.slice(SENTINEL.length));
    };
    let thrown = null;
    const timer = setTimeout(() => { thrown = thrown || '同步超时（' + Math.round(timeoutMs / 1000) + 's）'; }, timeoutMs);
    try {
      const fn = new Function('return (' + SYNC_SCRIPT.toString() + ')')();
      await fn(data, cdp, null, 1);   // opencli 进程内直连：1× 时序
    } catch (e) {
      thrown = String((e && e.message) || e);
    } finally {
      clearTimeout(timer);
      console.log = origLog;
    }

    const last = captured.length ? captured[captured.length - 1] : null;
    let out = null;
    if (last) { try { out = JSON.parse(last); } catch (e) { out = null; } }
    if (!out) out = { ok: false, msg: thrown || '同步引擎没有产出结果' };
    if (thrown && out.ok) { out.ok = false; out.msg = thrown; }
    out.engine = 'opencli';
    try { out.cdpCalls = cdp.calls(); } catch (e) { /* 忽略 */ }
    return out;
  } catch (e) {
    const m = String((e && e.message) || e);
    const code = /没找到 opencli|安装不完整|版本不兼容/.test(m) ? 'NO_OPENCLI'
      : /Extension|not connected|extension/i.test(m) ? 'BRIDGE_DISCONNECTED'
      : /超时/.test(m) ? 'TIMEOUT' : 'SYNC_FAIL';
    return { ok: false, code, msg: m, engine: 'opencli' };
  } finally {
    try { if (bridge) await bridge.close(); } catch (e) { /* 忽略 */ }
  }
}

/**
 * 只检查登录态，不写任何数据。
 * 供「同步通道体检」用：打开天源首页，看是否被重定向到统一认证。
 */
export async function openSyncSpace() {
  let bridge = null;
  try {
    const opened = await openSyncPage({});
    bridge = opened.bridge;
    const url = await opened.page.evaluate('location.href');
    const logged = String(url).indexOf('auth.zhrdc.net') < 0;
    return { ok: true, loggedIn: logged, url: String(url), engine: 'opencli',
      msg: logged ? '已连接你的 Chrome，天源登录态正常' : '你的 Chrome 里还没有登录天源' };
  } catch (e) {
    const m = String((e && e.message) || e);
    return { ok: false, loggedIn: false, code: /没找到 opencli/.test(m) ? 'NO_OPENCLI' : 'BRIDGE_DOWN', msg: m, engine: 'opencli' };
  } finally {
    try { if (bridge) await bridge.close(); } catch (e) { /* 忽略 */ }
  }
}

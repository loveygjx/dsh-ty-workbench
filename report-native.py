#!/usr/bin/env python3
"""
天源报告原生导出引擎（playwright 驱动）

通过持久化浏览器 profile 复用天源登录态，在页面上下文里调天源接口：
  列表 → (可选生成) → 轮询 → 下载 → 校验 → 落盘

约定：
  - 不做任何 Cookie 读取/导出/打印，全部请求走页面内 fetch（自动带凭据）
  - 一律按 companyId + reportType + version 三重比对
  - refresh 模式先记录基线最高版本，只认「版本更高 且 jobState=2 且 attachId 非空」
  - 每份下载立刻校验 ZIP 头，不合格即判该项失败
  - 单项失败不影响其余；全部成功才 ok

用法：
  python3 report-native.py '<JSON 参数>'
参数 JSON：
  {
    "projectId": "121295375958018",
    "items": [{"companyId":"...","companyName":"...","type":2,"mode":"current|refresh"}],
    "outDir": "/绝对/路径",
    "profileDir": "~/.tianyuan-workbench/pw-profile",
    "pollMs": 8000, "maxWaitMs": 600000,
    "action": "probe|export"        # probe 只返回登录态+报告列表
  }

输出：最后一行 `@@DSH_NATIVE@@<JSON>`
"""
import json
import os
import sys
import time
import glob

SENTINEL = '@@DSH_NATIVE@@'
TYPE_LABEL = {1: '评估报告', 2: '评估说明', 3: '长投说明'}

LIST_JS = """async (pid) => {
  const r = await fetch('/ty/api/report/project?pageNum=1&limit=200&projectId=' + encodeURIComponent(pid) + '&reportType=&companyId=', {credentials:'include'});
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return {code:-1, msg:'非JSON:' + t.slice(0,120)}; }
}"""

BUILD_JS = """async (args) => {
  const r = await fetch('/ty/api/report/build/' + encodeURIComponent(args.pid) + '/' + encodeURIComponent(args.cid) + '/' + args.type,
    {method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}});
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return {code:-1, msg:'非JSON:' + t.slice(0,120)}; }
}"""

# 下载：页面内转 base64（返回 {ok, b64} 或 {ok:false, reason}）
DL_JS = """async (aid) => {
  const r = await fetch('/ty/api/attach/' + encodeURIComponent(aid) + '/download', {credentials:'include'});
  if (!r.ok) return {ok:false, reason:'HTTP ' + r.status};
  const ct = r.headers.get('content-type') || '';
  if (ct.indexOf('json') >= 0) {
    const t = await r.text();
    return {ok:false, reason:'接口返回JSON:' + t.slice(0,160)};
  }
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) return {ok:false, reason:'非ZIP:' + buf.length + '字节'};
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  return {ok:true, b64: btoa(s)};
}"""


def find_chromium():
    """定位 playwright 自带 Chromium 可执行文件。"""
    env = os.environ.get('DSH_PW_CHROMIUM')
    if env and os.path.isfile(env):
        return env
    pats = [
        '~/Library/Caches/ms-playwright/chromium-*/chrome-mac-*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        '~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium',
        '~/.cache/ms-playwright/chromium-*/chrome-linux/chrome',
    ]
    for pat in pats:
        hits = sorted(glob.glob(os.path.expanduser(pat)))
        for h in reversed(hits):          # 取版本号最大的
            if os.path.isfile(h):
                return h
    return None


def emit(out):
    print(SENTINEL + json.dumps(out, ensure_ascii=False), flush=True)


def main():
    raw = sys.argv[1] if len(sys.argv) > 1 else '{}'
    try:
        cfg = json.loads(raw)
    except Exception as e:
        emit({'ok': False, 'code': 'BAD_ARGS', 'msg': '参数不是合法 JSON: %s' % e})
        return 1

    action = cfg.get('action', 'export')
    pid = str(cfg.get('projectId') or '')
    if not pid.isdigit():
        emit({'ok': False, 'code': 'BAD_ARGS', 'msg': 'projectId 必须是数字'})
        return 1

    profile_dir = os.path.expanduser(cfg.get('profileDir') or '~/.tianyuan-workbench/pw-profile')
    os.makedirs(profile_dir, exist_ok=True)

    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        emit({'ok': False, 'code': 'NO_PLAYWRIGHT', 'msg': '未安装 playwright（pip install playwright）: %s' % e})
        return 1

    exe = find_chromium()

    out = {'ok': False, 'files': [], 'errors': [], 'logs': []}

    def log(m):
        out['logs'].append(m)

    with sync_playwright() as pw:
        launch_kw = dict(
            headless=True,
            args=['--disable-blink-features=AutomationControlled'],
            viewport={'width': 1440, 'height': 900},
        )
        if exe:
            launch_kw['executable_path'] = exe
        try:
            ctx = pw.chromium.launch_persistent_context(profile_dir, **launch_kw)
        except Exception as e:
            emit({'ok': False, 'code': 'LAUNCH_FAIL', 'msg': '浏览器启动失败: %s' % e})
            return 1

        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.goto('https://excel.zhrdc.net/ty/operation/%s/report' % pid,
                      wait_until='domcontentloaded', timeout=60000)

            def list_reports():
                j = page.evaluate(LIST_JS, pid)
                if not j or j.get('code') != 200:
                    err = RuntimeError('NOT_LOGGED_IN')
                    msg = (j or {}).get('msg') or ('code %s' % (j or {}).get('code'))
                    if msg and msg.startswith('非JSON:'):
                        msg = '页面被重定向到登录页（未登录）'
                    err.ty_msg = msg
                    raise err
                rows = j.get('data') if isinstance(j.get('data'), list) else ((j.get('data') or {}).get('list') or [])
                return [{
                    'companyId': str(x.get('companyId')),
                    'companyName': x.get('companyName') or '',
                    'type': int(x.get('reportType') or 0),
                    'version': int(x.get('version') or 0),
                    'jobState': int(x.get('jobState') or 0),
                    'attachId': str(x['attachId']) if x.get('attachId') else None,
                } for x in rows]

            # 登录态探测
            try:
                before = list_reports()
            except RuntimeError as e:
                if str(e) == 'NOT_LOGGED_IN':
                    emit({'ok': False, 'code': 'NOT_LOGGED_IN',
                          'msg': '这个浏览器 profile 还没登录天源（接口返回 %s）。请在「天源登录」里扫码一次。' % getattr(e, 'ty_msg', '未知')})
                    return 0
                raise

            if action == 'probe':
                out.update({'ok': True, 'logged': True, 'reports': [
                    dict(r, downloadable=bool(r['attachId'] and r['jobState'] == 2)) for r in before]})
                emit(out)
                return 0

            items = cfg.get('items') or []
            out_dir = cfg.get('outDir')
            if not out_dir or not os.path.isabs(out_dir):
                emit({'ok': False, 'code': 'BAD_ARGS', 'msg': 'outDir 必须是绝对路径'})
                return 1
            os.makedirs(out_dir, exist_ok=True)
            poll_ms = int(cfg.get('pollMs') or 8000)
            max_wait = int(cfg.get('maxWaitMs') or 600000)

            for idx, it in enumerate(items):
                cid = str(it.get('companyId') or '')
                typ = int(it.get('type') or 0)
                mode = it.get('mode') or 'current'
                cname = it.get('companyName') or cid
                label = TYPE_LABEL.get(typ, '类型%s' % typ)
                tag = '[%d/%d] %s · %s' % (idx + 1, len(items), cname, label)
                try:
                    if mode == 'refresh':
                        log(tag + '：提交生成任务')
                        bj = page.evaluate(BUILD_JS, {'pid': pid, 'cid': cid, 'type': typ})
                        if not bj or bj.get('code') != 200:
                            raise RuntimeError('生成任务提交失败：%s' % ((bj or {}).get('msg') or (bj or {}).get('code')))
                        base_ver = max([r['version'] for r in before
                                        if r['companyId'] == cid and r['type'] == typ] or [0])
                        log(tag + '：任务 %s 已提交（基线 V%d），等待生成…' % (bj.get('data'), base_ver))
                        t0 = time.time()
                        target = None
                        while (time.time() - t0) * 1000 < max_wait:
                            time.sleep(poll_ms / 1000.0)
                            rows = list_reports()
                            mine = [r for r in rows if r['companyId'] == cid and r['type'] == typ
                                    and r['version'] > base_ver and r['attachId'] and r['jobState'] == 2]
                            if mine:
                                mine.sort(key=lambda r: -r['version'])
                                target = mine[0]
                                break
                            newer = [r for r in rows if r['companyId'] == cid and r['type'] == typ
                                     and r['version'] > base_ver]
                            log(tag + '：' + ('新版本 V%d 生成中…' % newer[0]['version'] if newer else '等待调度…'))
                        if not target:
                            raise RuntimeError('等待生成超时（%d 分钟）' % (max_wait // 60000))
                    else:
                        rows = list_reports()
                        mine = [r for r in rows if r['companyId'] == cid and r['type'] == typ
                                and r['attachId'] and r['jobState'] == 2]
                        if not mine:
                            raise RuntimeError('没有已生成的%s（可能从未生成，请改用「生成新版本」）' % label)
                        mine.sort(key=lambda r: -r['version'])
                        target = mine[0]

                    log(tag + '：下载 V%d' % target['version'])
                    dl = page.evaluate(DL_JS, target['attachId'])
                    if not dl or not dl.get('ok'):
                        raise RuntimeError('下载失败：%s' % ((dl or {}).get('reason') or '未知'))

                    import base64
                    buf = base64.b64decode(dl['b64'])
                    if buf[:2] != b'PK':
                        raise RuntimeError('下载内容不是有效 docx')

                    safe = ''.join('_' if ch in '\\/:*?"<>|' else ch for ch in cname)
                    fname = '%s-%s-V%d.docx' % (safe, label, target['version'])
                    fpath = os.path.join(out_dir, fname)
                    with open(fpath, 'wb') as f:
                        f.write(buf)
                    out['files'].append({
                        'file': fpath, 'companyId': cid, 'companyName': cname,
                        'type': typ, 'version': target['version'], 'bytes': len(buf),
                    })
                    log(tag + '：已保存 V%d（%d KB）' % (target['version'], len(buf) // 1024))
                except Exception as e:
                    out['errors'].append('%s：%s' % (tag, e))
                    log(tag + '：失败 %s' % e)

            out['ok'] = len(out['errors']) == 0 and len(out['files']) > 0
            emit(out)
            return 0
        finally:
            try:
                ctx.close()
            except Exception:
                pass


if __name__ == '__main__':
    sys.exit(main())

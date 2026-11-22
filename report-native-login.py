#!/usr/bin/env python3
"""
天源扫码登录（有界面 playwright）

打开有界面浏览器让用户扫码登录天源，登录成功后 cookie 写入持久化 profile，
后续 report-native.py 的无头模式直接复用。

参数 JSON：{ "profileDir": "...", "maxWaitMs": 480000 }
输出最后一行：@@DSH_NATIVE@@<JSON>  { ok, logged, msg }
"""
import json
import os
import sys
import time
import glob

SENTINEL = '@@DSH_NATIVE@@'


def find_chromium():
    env = os.environ.get('DSH_PW_CHROMIUM')
    if env and os.path.isfile(env):
        return env
    pats = [
        '~/Library/Caches/ms-playwright/chromium-*/chrome-mac-*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        '~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium',
        '~/.cache/ms-playwright/chromium-*/chrome-linux/chrome',
    ]
    for pat in pats:
        for h in reversed(sorted(glob.glob(os.path.expanduser(pat)))):
            if os.path.isfile(h):
                return h
    return None


def emit(out):
    print(SENTINEL + json.dumps(out, ensure_ascii=False), flush=True)


PROBE_JS = """async () => {
  const r = await fetch('https://excel.zhrdc.net/ty/api/report/project?pageNum=1&limit=5&reportType=&companyId=&projectId=' + encodeURIComponent(window.__PID || ''), {credentials:'include'});
  const t = await r.text();
  try { const j = JSON.parse(t); return {code: j.code}; } catch (e) { return {code: -1}; }
}"""


def main():
    cfg = {}
    if len(sys.argv) > 1:
        try:
            cfg = json.loads(sys.argv[1])
        except Exception as e:
            emit({'ok': False, 'msg': '参数不是合法 JSON: %s' % e})
            return 1

    profile_dir = os.path.expanduser(cfg.get('profileDir') or '~/.tianyuan-workbench/pw-profile')
    os.makedirs(profile_dir, exist_ok=True)
    max_wait = int(cfg.get('maxWaitMs') or 480000)

    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        emit({'ok': False, 'msg': '未安装 playwright: %s' % e})
        return 1

    exe = find_chromium()
    with sync_playwright() as pw:
        kw = dict(headless=False, args=['--disable-blink-features=AutomationControlled'],
                  no_viewport=True, viewport=None)
        if exe:
            kw['executable_path'] = exe
        try:
            ctx = pw.chromium.launch_persistent_context(profile_dir, **kw)
        except Exception as e:
            emit({'ok': False, 'msg': '浏览器启动失败: %s' % e})
            return 1
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.goto('https://ty.zhrdc.net/project/my', wait_until='domcontentloaded', timeout=60000)

            ok = False
            deadline = time.time() + max_wait / 1000.0
            while time.time() < deadline:
                time.sleep(2)
                try:
                    # 用任一已知项目验证登录态；无项目时退化为检查是否还在登录页
                    r = page.evaluate("""async () => {
                      const r = await fetch('https://excel.zhrdc.net/ty/api/page_data', {credentials:'include'});
                      const t = await r.text();
                      try { const j = JSON.parse(t); return {code: j.code}; } catch (e) { return {code: -1}; }
                    }""")
                    if r and r.get('code') == 200:
                        ok = True
                        break
                except Exception:
                    pass

            if ok:
                page.wait_for_timeout(1200)   # 让 cookie 落盘
            emit({'ok': True, 'logged': ok, 'msg': '已登录' if ok else '等待扫码超时，请重试'})
            return 0
        finally:
            try:
                ctx.close()
            except Exception:
                pass


if __name__ == '__main__':
    sys.exit(main())

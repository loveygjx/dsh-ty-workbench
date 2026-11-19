import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// CLI 和工作台 MCP 使用独立凭据；这里只检查本地文件，不返回凭据或授权链接。
export function createCliAuth({ home = homedir(), spawnProcess = spawn, paths = ['/usr/local/bin/tycpv', '/opt/homebrew/bin/tycpv'], open = null } = {}) {
  let child = null, state = 'idle', reason = '', timer = null, output = '';
  const binary = () => [process.env.TYCPV_BIN, ...paths, ...String(process.env.PATH || '').split(':').filter(Boolean).map(p => join(p, 'tycpv'))].find(p => p && existsSync(p));
  function localStatus() {
    if (!binary()) return { installed: false, authenticated: false, state: 'unavailable', reason: '未找到 tycpv，请先安装 CLI' };
    let authenticated = false, expiresAt = null;
    try {
      if (existsSync(join(home, '.tycpv', 'token.secret.json'))) {
        const auth = JSON.parse(readFileSync(join(home, '.tycpv', 'auth.json'), 'utf8'));
        const secret = JSON.parse(readFileSync(join(home, '.tycpv', 'token.secret.json'), 'utf8'));
        const readableToken = secret.provider === 'plain-file' && typeof secret.value === 'string' && !!Buffer.from(secret.value, 'base64url').toString('utf8').trim();
        expiresAt = auth.expiresAt || null;
        authenticated = !!readableToken && (!expiresAt || (Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > Date.now()));
      }
    } catch (_) {}
    return { installed: true, authenticated, expiresAt, state: child || state === 'failed' ? state : (authenticated ? 'authenticated' : state), reason };
  }
  function extractUrl(text) {
    for (const raw of text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').match(/https?:\/\/[^\s"'<>]+/gi) || []) {
      try {
        const u = new URL(raw.replace(/[),.;]+$/, ''));
        if (u.protocol === 'https:' && (u.hostname === 'mcp.zhrdc.net' || u.hostname.endsWith('.mcp.zhrdc.net')) && u.pathname === '/connect' && (u.searchParams.get('auth') === 'login' || u.searchParams.size >= 3)) return u.toString();
      } catch (_) {}
    }
    return '';
  }
  function start() {
    const current = localStatus();
    if (!current.installed) return { ok: false, ...current };
    if (child) return { ok: true, ...current };
    // 即使文件存在也交给 CLI 自己验证远端状态，避免损坏或失效凭据阻止重新授权。
    state = 'starting'; reason = ''; output = '';
    try { child = spawnProcess(binary(), ['login'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env }); }
    catch (_) { state = 'failed'; reason = '无法启动 CLI 授权，请在终端运行 tycpv login'; return { ok: false, ...localStatus() }; }
    const active = child;
    const onData = chunk => {
      output = (output + String(chunk)).slice(-32768);
      const url = extractUrl(output);
      if (!url || state !== 'starting') return;
      output = ''; state = 'waiting';
      if (open) open(url);
      else {
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? null : 'xdg-open';
        if (!cmd) { reason = '请在终端运行 tycpv login 完成授权'; return; }
        const browser = spawnProcess(cmd, [url], { stdio: 'ignore', detached: true });
        browser.on('error', () => { if (child === active) { child = null; active.kill(); clearTimeout(timer); state = 'failed'; reason = '无法自动打开浏览器，请在终端运行 tycpv login'; } });
        browser.unref();
      }
    };
    active.stdout?.on('data', onData); active.stderr?.on('data', onData);
    active.once('error', () => { if (child !== active) return; child = null; state = 'failed'; reason = 'CLI 启动失败，请在终端运行 tycpv login'; clearTimeout(timer); });
    active.once('close', code => { if (child !== active) return; child = null; clearTimeout(timer); const auth = localStatus(); const ok = code === 0 && auth.authenticated; state = ok ? 'authenticated' : 'failed'; reason = ok ? '' : 'CLI 授权未完成或进程已退出（退出码 ' + code + '）'; });
    timer = setTimeout(() => { if (child !== active) return; child = null; state = 'failed'; reason = 'CLI 授权等待超时，请重试'; active.kill(); }, 5 * 60 * 1000);
    timer.unref?.();
    return { ok: true, ...localStatus() };
  }
  function dispose() { if (timer) clearTimeout(timer); if (child) { child.kill(); child = null; } }
  return { status: localStatus, start, dispose };
}

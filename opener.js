import { spawn } from 'node:child_process';

/**
 * 把「用系统资源管理器/Finder 打开文件或文件夹」收在一处。
 *
 * 为什么单独成文件：store.js（数据目录、项目文件夹）和 library.js（知识库里的
 * 文件/文件夹）原来各抄了一份 spawn(explorer.exe) 的实现，两边都踩了同一个坑。
 *
 * 那个坑（2026-11 实测，Windows 11 26200）：
 *   spawn('explorer.exe', [dir], { windowsHide: true })
 *   → Node 在 Windows 把 windowsHide 写进 STARTUPINFO.wShowWindow = SW_HIDE，
 *     explorer.exe 尊重这个隐藏标志，新建的 CabinetWClass（文件资源管理器）窗口
 *     建出来但保持隐藏：窗口标题、大小、位置都正常，只有 IsWindowVisible() 为 false。
 *   用户看到的现象因此是「提示已打开：D:\...」而桌面上什么都没出现。
 *   验证方式：点一次 → 用 EnumWindows 抓 CabinetWClass，标题正是目标文件夹，
 *   vis=False；同一条命令去掉 windowsHide 再点一次 → 立刻 vis=True、窗口可见。
 *
 * 所以：**这里永远不要传 windowsHide**。explorer.exe 是 GUI 子系统程序，不传也
 * 不会闪黑框；cmd /c start 那类（index.js 打开系统浏览器）才需要 windowsHide。
 */

const PLATFORM = process.platform;

function explorerCmd() {
  if (PLATFORM === 'win32') return 'explorer.exe';
  if (PLATFORM === 'darwin') return 'open';
  return 'xdg-open';
}

function explorerArgs(target, reveal) {
  if (PLATFORM === 'win32') return reveal ? ['/select,' + target] : [target];
  if (PLATFORM === 'darwin') return reveal ? ['-R', target] : [target];
  return [target];
}

/**
 * 起一个「交给系统 shell」的进程，并把「到底起没起来」如实报出来。
 * 返回值是真结论：spawn 的失败（ENOENT / EPERM）是异步 error 事件、不同步抛，
 * 原来不听这个事件，任何失败都会被报成 ok:true。
 */
export function launchShell(cmd, args) {
  return new Promise(resolve => {
    let settled = false;
    const done = r => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      // detached + stdio:ignore：不占宿主进程的管道，宿主退出也不连带把窗口带走
      child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    } catch (e) {
      return done({ ok: false, error: '启动失败：' + ((e && e.message) || e) });
    }
    child.on('error', e => done({ ok: false, error: '启动失败：' + ((e && e.message) || e) }));
    // explorer.exe 成功时也会立刻以退出码 1 退出（把请求转交给已在跑的 shell 实例），
    // 所以退出码不能当判据。监听 error 之后再等一个窗口创建周期，没报错就算交出去了。
    setTimeout(() => {
      try { child.unref(); } catch (e) { /* 已经退出 */ }
      done({ ok: true });
    }, 600);
  });
}

/** 用资源管理器打开文件夹（或文件）；reveal=true 时在资源管理器里定位并选中 */
export function openShell(target, reveal) {
  return launchShell(explorerCmd(), explorerArgs(String(target || ''), !!reveal));
}

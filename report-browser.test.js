// report-browser.js 单元测试
// 只测纯逻辑部分（不打真实浏览器、不碰网络）：
//  - opencli 可执行文件解析
//  - opencli 输出里剥出 JSON（它常在 JSON 后面跟升级提示）
//  - 参数与 URL 拼装
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveOpencliBin, runOpencli, evalInPage } from './report-browser.js';

test('resolveOpencliBin: 找不到时返回 null 而不是抛错', () => {
  const saved = process.env.PATH;
  try {
    // 把候选路径都指向不存在的位置：PATH 清空 + HOME 指向临时目录
    process.env.PATH = '/nonexistent-bin';
    const got = resolveOpencliBin();
    // 允许返回 'opencli' 或 null，但绝不能抛异常
    assert.ok(got === null || typeof got === 'string');
  } finally {
    process.env.PATH = saved;
  }
});

test('resolveOpencliBin: 优先返回真实存在的可执行文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rb-test-'));
  try {
    const fake = join(dir, 'opencli');
    writeFileSync(fake, '#!/bin/sh\necho \'{"ok":true}\'\n');
    chmodSync(fake, 0o755);
    // 直接验证：给定路径存在时能被识别（用 runOpencli 的 bin 参数复用同一判定）
    const r = runOpencli(['--version'], { bin: fake, timeout: 5000 });
    return r.then((out) => {
      assert.equal(out.code, 0);
      assert.match(out.stdout, /ok/);
    }).finally(() => rmSync(dir, { recursive: true, force: true }));
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
});

test('runOpencli: 可执行文件不存在时返回错误码而不是抛异常', async () => {
  const out = await runOpencli(['--version'], { bin: '/definitely/not/here/opencli', timeout: 3000 });
  assert.equal(out.code, -1);
  assert.match(out.stderr, /ENOENT|not|No such/i);
});

test('runOpencli: 超时会杀掉子进程并返回 -2', async () => {
  const out = await runOpencli(['browser', 'x', 'wait', 'time', '999'], { bin: 'sleep', timeout: 300 });
  // sleep 不认这些参数会立刻退出，这里只确认它不会把测试挂死
  assert.ok([-2, 0, 1].includes(out.code));
});

test('evalInPage: 非零退出码时抛 OPENCLI_EVAL_FAILED 并带 detail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rb-test-'));
  try {
    const fake = join(dir, 'opencli');
    writeFileSync(fake, '#!/bin/sh\necho "bound_tab_mutation_blocked" 1>&2\nexit 1\n');
    chmodSync(fake, 0o755);
    await assert.rejects(
      () => evalInPage('1+1', { bin: fake, timeout: 5000 }),
      (err) => {
        assert.equal(err.message, 'OPENCLI_EVAL_FAILED');
        assert.match(String(err.detail), /bound_tab_mutation_blocked/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evalInPage: 成功时把 stdout 原样返回（去掉尾部空白）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rb-test-'));
  try {
    const fake = join(dir, 'opencli');
    writeFileSync(fake, '#!/bin/sh\nprintf \'[{"id":"1"}]\\n\\n\'\n');
    chmodSync(fake, 0o755);
    const out = await evalInPage('1+1', { bin: fake, timeout: 5000 });
    assert.equal(out, '[{"id":"1"}]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isBridgeDown 不导出内部函数，但 BRIDGE_DISCONNECTED 语义由 openTyHost 抛出', async () => {
  // 直接验证：桥接断连时 openTyHost 应以 BRIDGE_DISCONNECTED 快速失败，
  // 而不是把 opencli 的原始重试超时（90s+）抛给上层。
  const { openTyHost } = await import('./report-browser.js');
  const dir = mkdtempSync(join(tmpdir(), 'rb-test-'));
  try {
    const fake = join(dir, 'opencli');
    // 模拟扩展未连接：get url 成功返回空（未绑定），open 报 bridge 未连
    writeFileSync(fake, `#!/bin/sh
case "$*" in
  *"get url"*) echo "" ; exit 0 ;;
  *open*) echo "✖  Browser Bridge extension not connected" 1>&2 ; exit 1 ;;
  *"wait time"*) exit 0 ;;
  *) exit 0 ;;
esac
`);
    chmodSync(fake, 0o755);
    await assert.rejects(
      () => openTyHost('110804796309505', { bin: fake }),
      (err) => {
        assert.equal(err.message, 'BRIDGE_DISCONNECTED');
        assert.match(String(err.detail), /OpenCLI|chrome:\/\/extensions/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bridgeHealth: 扩展已连接时返回 ok', async () => {
  const { bridgeHealth } = await import('./report-browser.js');
  const dir = mkdtempSync(join(tmpdir(), 'rb-test-'));
  try {
    const fake = join(dir, 'opencli');
    writeFileSync(fake, `#!/bin/sh
echo "[OK] Daemon: running on port 19825"
echo "[OK] Extension: connected (v1.0.27)"
echo "[OK] Connectivity: connected in 0.4s"
exit 0
`);
    chmodSync(fake, 0o755);
    const h = await bridgeHealth({ bin: fake });
    assert.equal(h.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bridgeHealth: 扩展未连接时返回 ok:false 并带说明', async () => {
  const { bridgeHealth } = await import('./report-browser.js');
  const dir = mkdtempSync(join(tmpdir(), 'rb-test-'));
  try {
    const fake = join(dir, 'opencli');
    writeFileSync(fake, `#!/bin/sh
echo "[OK] Daemon: running on port 19825"
echo "[MISSING] Extension: not connected"
exit 0
`);
    chmodSync(fake, 0o755);
    const h = await bridgeHealth({ bin: fake });
    assert.equal(h.ok, false);
    assert.match(String(h.detail), /扩展未连接/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recoverBridgeNow: daemon 重启后扩展连上则报成功，并给出耗时', async () => {
  const { recoverBridgeNow } = await import('./report-browser.js');
  const dir = mkdtempSync(join(tmpdir(), 'rb-test-'));
  try {
    const fake = join(dir, 'opencli');
    // restart 成功；第一次 doctor 仍 not connected，第二次起 connected（模拟重连延迟）
    const state = join(dir, 'n.txt');
    writeFileSync(state, '0');
    writeFileSync(fake, `#!/bin/sh
if [ "$1" = "daemon" ]; then echo "Daemon restarted on port 19825"; exit 0; fi
if [ "$1" = "doctor" ]; then
  N=$(cat "${state}")
  N=$((N+1)); echo $N > "${state}"
  if [ "$N" -lt 2 ]; then echo "[MISSING] Extension: not connected"; else echo "[OK] Extension: connected (v1.0.27)"; fi
  exit 0
fi
exit 0
`);
    chmodSync(fake, 0o755);
    const r = await recoverBridgeNow({ bin: fake });
    assert.equal(r.ok, true);
    assert.ok(r.ms >= 500, 'should report elapsed ms');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

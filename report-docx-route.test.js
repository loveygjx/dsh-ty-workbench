import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, readdir, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

// Exercise the actual route in isolation: no real CLI, credentials, or network.
const source = await readFile(new URL('./index.js', import.meta.url), 'utf8');
const start = source.indexOf("path: PREFIX + '/ty/report-docx'");
const end = source.indexOf('\n      },', start);
assert.ok(start >= 0 && end > start);
const routeCode = '({' + source.slice(start, end) + '\n})';

async function run(mode) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-report-route-test-'));
  const oldDir = join(root, '评估报告');
  await mkdir(oldDir);
  await writeFile(join(oldDir, 'old.docx'), 'old');
  const progress = new Map();
  const context = { PREFIX: '/api/workbench', exportProgress: progress, mkdir, mkdtemp, readdir, join, dirname, stat, realpath, isAbsolute,
    existsSync: () => true, homedir: () => root, process: { env: { TYCPV_BIN: 'fake-cli' } },
    safeFolderName: s => s, store: { config: async () => ({ dir: root }) }, rememberExportBatch: () => {},
    json: (body, status = 200) => ({ body, status }),
    spawn: (_bin, args) => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(async () => {
        if (mode === 'produced') await writeFile(join(args[args.indexOf('--out') + 1], 'new.docx'), 'new');
        child.emit('close', mode === 'failed' ? 1 : 0);
      });
      return child;
    }, queueMicrotask, Date, String, Number, Array, Promise, Error, RegExp };
  const route = vm.runInNewContext(routeCode, context);
  const result = await route.fetch({ json: async () => ({ jobId: 'job123', types: [1], projectId: '123', outputDir: root }) });
  assert.equal(result.body.ok, true);
  let final;
  for (let i = 0; i < 100; i++) { await new Promise(resolve => setTimeout(resolve, 5)); final = progress.get('job123'); if (final && final.status !== 'running') break; }
  assert.ok(final && final.status !== 'running', 'job finishes');
  assert.equal(await readFile(join(oldDir, 'old.docx'), 'utf8'), 'old');
  return final;
}

test('exit zero without new Word does not reuse an old file', async () => {
  const result = await run('empty');
  assert.equal(result.status, 'failed'); assert.equal(result.files.length, 0); assert.match(result.message, /未生成 Word/);
});
test('a newly generated Word is the only reported file', async () => {
  const result = await run('produced');
  assert.equal(result.status, 'done'); assert.equal(result.files.length, 1); assert.match(result.files[0], /批次-.*\/new\.docx$/);
});
test('nonzero CLI exit is a failure even with an old file', async () => {
  const result = await run('failed'); assert.equal(result.status, 'failed'); assert.equal(result.files.length, 0);
});

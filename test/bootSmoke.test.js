import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-boot-'));
process.env.MSR_DATA_DIR = tmpDir;
process.env.MSR_DISABLE_BROWSER_FETCH = '1';

test('调度器可以完整启动（防止启动期 ReferenceError）', async () => {
  const { default: scheduler } = await import('../src/scheduler.js');
  const { default: configManager } = await import('../src/config.js');

  configManager.update({
    schedule: { enabled: true }
  });

  // 不应该抛异常
  assert.doesNotThrow(() => scheduler.start());
  scheduler.stop();

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('调度器可以停止并重启', async () => {
  const { default: scheduler } = await import('../src/scheduler.js');
  assert.doesNotThrow(() => scheduler.stop());
  assert.doesNotThrow(() => scheduler.start());
  scheduler.stop();
});

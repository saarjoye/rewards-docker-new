import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-config-auth-'));
process.env.MSR_DATA_DIR = tmpDir;

const {
  default: configManager,
  SECRET_PLACEHOLDER,
  SECRET_CLEAR
} = await import('../src/config.js');

test('通用配置接口不能覆盖管理员认证字段', () => {
  configManager.setAdminAuth({
    username: 'admin',
    passwordHash: 'hash-value',
    salt: 'salt-value',
    sessionSecret: 'session-secret',
    createdAt: 1234567890
  });

  configManager.update({
    server: {
      auth: { username: 'hacker', passwordHash: 'x', salt: 'y', sessionSecret: 'z' },
      authPassword: 'legacy-password',
      port: 5308
    }
  });

  const auth = configManager.getAdminAuth();
  assert.equal(auth.username, 'admin');
  assert.equal(auth.passwordHash, 'hash-value');
  assert.equal(auth.salt, 'salt-value');
  assert.equal(auth.sessionSecret, 'session-secret');
  assert.notEqual(configManager.get().server.authPassword, 'legacy-password');
});

test('公开配置不下发管理员敏感字段', () => {
  const pub = configManager.getPublicConfig();
  assert.equal(pub.server.auth.username, 'admin');
  assert.equal(pub.server.auth.initialized, true);
  assert.equal(pub.server.auth.passwordHash, undefined);
  assert.equal(pub.server.auth.salt, undefined);
  assert.equal(pub.server.auth.sessionSecret, undefined);
  assert.equal(pub.server.authPassword, '');
});

test('企业微信应用 Secret 遮蔽与保留语义正确', () => {
  configManager.update({
    notify: {
      weworkApp: {
        enabled: true,
        baseUrl: '',
        corpId: 'ww-test',
        agentId: '1000002',
        secret: 'super-secret',
        toUser: '@all',
        maxRetries: 3
      }
    }
  });

  // 公开配置遮蔽 Secret，但暴露 hasSecret
  let pub = configManager.getPublicConfig();
  assert.equal(pub.notify.weworkApp.secret, SECRET_PLACEHOLDER);
  assert.equal(pub.notify.weworkApp.hasSecret, true);

  // 前端回传占位符：保留原值
  configManager.update({ notify: { weworkApp: { secret: SECRET_PLACEHOLDER, toUser: 'zhangsan' } } });
  let raw = configManager.get().notify.weworkApp;
  assert.equal(raw.secret, 'super-secret');
  assert.equal(raw.toUser, 'zhangsan');

  // 前端留空：也保留原值
  configManager.update({ notify: { weworkApp: { secret: '' } } });
  raw = configManager.get().notify.weworkApp;
  assert.equal(raw.secret, 'super-secret');

  // 显式清空
  configManager.update({ notify: { weworkApp: { secret: SECRET_CLEAR } } });
  raw = configManager.get().notify.weworkApp;
  assert.equal(raw.secret, '');
});

test('ensureAdminSessionSecret 只在缺失时生成', () => {
  configManager.setAdminAuth({ username: 'admin', passwordHash: 'h', salt: 's', sessionSecret: '', createdAt: 1 });
  const first = configManager.ensureAdminSessionSecret();
  const second = configManager.ensureAdminSessionSecret();
  assert.ok(first && first.length >= 32);
  assert.equal(first, second, '已有密钥时不得重复生成');
});
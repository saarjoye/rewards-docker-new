import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-wework-app-'));
process.env.MSR_DATA_DIR = tmpDir;

const {
  default: notifier,
  Notifier,
  buildWeWorkAppBaseUrl,
  buildWeWorkAppTokenUrl,
  buildWeWorkAppSendUrl,
  computeWeWorkAppBackoffMs
} = await import('../src/core/notifier.js');
const { default: networkClient } = await import('../src/network.js');

const BASE_CONFIG = {
  enabled: true,
  baseUrl: '',
  corpId: 'ww-test-corp',
  agentId: '1000002',
  secret: 'test-secret',
  toUser: '@all',
  maxRetries: 2
};

test('Base URL 校验与拼接', () => {
  assert.equal(buildWeWorkAppBaseUrl(''), 'https://qyapi.weixin.qq.com');
  assert.equal(buildWeWorkAppBaseUrl('https://qyapi.weixin.qq.com/'), 'https://qyapi.weixin.qq.com');
  assert.equal(buildWeWorkAppBaseUrl('https://proxy.example.com/qyapi/'), 'https://proxy.example.com/qyapi');
  assert.throws(() => buildWeWorkAppBaseUrl('http://qyapi.weixin.qq.com'), /HTTPS/);
  assert.throws(() => buildWeWorkAppBaseUrl('https://user:pass@qyapi.weixin.qq.com'), /账号密码/);
  assert.throws(() => buildWeWorkAppBaseUrl('https://qyapi.weixin.qq.com/?a=1'), /查询参数/);
  assert.throws(() => buildWeWorkAppBaseUrl('not a url'), /无效/);

  const tokenUrl = buildWeWorkAppTokenUrl('https://proxy.example.com', 'corp id', 'sec ret');
  assert.equal(tokenUrl, 'https://proxy.example.com/cgi-bin/gettoken?corpid=corp%20id&corpsecret=sec%20ret');
  assert.equal(buildWeWorkAppSendUrl('https://proxy.example.com/qyapi/', 'tok en'), 'https://proxy.example.com/qyapi/cgi-bin/message/send?access_token=tok%20en');
});

test('退避时间为指数增长且封顶 16 秒', () => {
  assert.equal(computeWeWorkAppBackoffMs(0), 1000);
  assert.equal(computeWeWorkAppBackoffMs(1), 2000);
  assert.equal(computeWeWorkAppBackoffMs(2), 4000);
  assert.equal(computeWeWorkAppBackoffMs(3), 8000);
  assert.equal(computeWeWorkAppBackoffMs(4), 16000);
  assert.equal(computeWeWorkAppBackoffMs(9), 16000);
});

test('access_token 有缓存，发送成功后不重复获取', async () => {
  const n = new Notifier();
  n.sleep = async () => {};
  let tokenCalls = 0;
  let sendCalls = 0;
  const origRequest = networkClient.request;
  networkClient.request = async (options) => {
    if (options.url.includes('/gettoken')) {
      tokenCalls += 1;
      return { errcode: 0, errmsg: 'ok', access_token: 'token-1', expires_in: 7200 };
    }
    sendCalls += 1;
    return { errcode: 0, errmsg: 'ok' };
  };
  try {
    assert.equal(await n.sendWeWorkApp(BASE_CONFIG, 'hello'), true);
    assert.equal(await n.sendWeWorkApp(BASE_CONFIG, 'hello again'), true);
    assert.equal(tokenCalls, 1, 'token 应命中缓存');
    assert.equal(sendCalls, 2);
  } finally {
    networkClient.request = origRequest;
  }
});

test('token 失效时清缓存并重发一次', async () => {
  const n = new Notifier();
  n.sleep = async () => {};
  let tokenCalls = 0;
  let sendCalls = 0;
  const origRequest = networkClient.request;
  networkClient.request = async (options) => {
    if (options.url.includes('/gettoken')) {
      tokenCalls += 1;
      return { errcode: 0, errmsg: 'ok', access_token: `token-${tokenCalls}`, expires_in: 7200 };
    }
    sendCalls += 1;
    return sendCalls === 1 ? { errcode: 42001, errmsg: 'access_token expired' } : { errcode: 0, errmsg: 'ok' };
  };
  try {
    assert.equal(await n.sendWeWorkApp(BASE_CONFIG, 'hello'), true);
    assert.equal(tokenCalls, 2, '应强制刷新一次 token');
    assert.equal(sendCalls, 2);
  } finally {
    networkClient.request = origRequest;
  }
});

test('网络失败按 maxRetries 重试并最终抛错', async () => {
  const n = new Notifier();
  n.sleep = async () => {};
  let attempts = 0;
  const origRequest = networkClient.request;
  networkClient.request = async (options) => {
    if (options.url.includes('/gettoken')) {
      return { errcode: 0, errmsg: 'ok', access_token: 'token-1', expires_in: 7200 };
    }
    attempts += 1;
    throw new Error('network down');
  };
  try {
    await assert.rejects(() => n.sendWeWorkApp({ ...BASE_CONFIG, maxRetries: 2 }, 'hello'), /network down/);
    assert.equal(attempts, 3, 'maxRetries=2 时应共尝试 3 次');
  } finally {
    networkClient.request = origRequest;
  }
});

test('缺少必填配置时明确报错', async () => {
  await assert.rejects(() => notifier.sendWeWorkApp({ ...BASE_CONFIG, corpId: '' }, 'x'), /CorpID/);
  await assert.rejects(() => notifier.sendWeWorkApp({ ...BASE_CONFIG, agentId: 'abc' }, 'x'), /必须为数字/);
  await assert.rejects(() => notifier.sendWeWorkApp({ ...BASE_CONFIG, secret: '' }, 'x'), /Secret/);
});
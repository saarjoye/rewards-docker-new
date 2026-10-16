import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-auth-flow-'));
process.env.MSR_DATA_DIR = tmpDir;

const { createServer } = await import('../src/web/server.js');

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function readCookie(setCookie) {
  return String(setCookie || '').split(';')[0];
}

test('管理员首次初始化、登录保护与登出全流程', async () => {
  const app = createServer();
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. 首次访问：未初始化
    let res = await fetch(`${base}/api/auth/status`);
    let body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.initialized, false);
    assert.equal(body.data.authenticated, false);

    // 2. 未登录访问受保护接口应 401
    res = await fetch(`${base}/api/config`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).success, false);

    // 3. 未登录访问页面应 302 到登录页
    res = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login.html');

    // 4. 密码不一致应 400
    res = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password123', confirmPassword: 'password124' })
    });
    assert.equal(res.status, 400);

    // 5. 首次创建管理员成功，并下发会话 Cookie
    res = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password123', confirmPassword: 'password123' })
    });
    assert.equal(res.status, 200);
    body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.authenticated, true);
    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /msr_admin_session=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    const sessionCookie = readCookie(setCookie);

    // 6. 重复初始化应 409
    res = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'other', password: 'password123', confirmPassword: 'password123' })
    });
    assert.equal(res.status, 409);

    // 7. 携带会话 Cookie 可访问受保护接口
    res = await fetch(`${base}/api/config`, { headers: { Cookie: sessionCookie } });
    assert.equal(res.status, 200);
    body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.server.auth.initialized, true);
    assert.equal(body.data.server.auth.username, 'admin');
    assert.equal(body.data.server.auth.passwordHash, undefined, '不得下发密码哈希');
    assert.equal(body.data.server.auth.sessionSecret, undefined, '不得下发会话密钥');
    assert.equal(body.data.server.authPassword, '', '不得下发旧 Basic 密码');

    // 8. 状态接口识别已登录
    res = await fetch(`${base}/api/auth/status`, { headers: { Cookie: sessionCookie } });
    body = await res.json();
    assert.equal(body.data.initialized, true);
    assert.equal(body.data.authenticated, true);

    // 9. 错误密码应 401，正确密码可登录
    res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong-password' })
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).message, '账号或密码错误');

    res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password123' })
    });
    assert.equal(res.status, 200);
    const loginCookie = readCookie(res.headers.get('set-cookie'));
    assert.match(loginCookie, /msr_admin_session=/);

    // 10. 登出后原会话仍有效（无状态 Token），但登出响应清 Cookie
    res = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: loginCookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});

test('错误 Token 无法通过认证', async () => {
  const app = createServer();
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/config`, { headers: { Cookie: 'msr_admin_session=forged.token' } });
    assert.equal(res.status, 401);
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});
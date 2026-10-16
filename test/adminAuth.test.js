import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  normalizeAdminUsername,
  validateAdminCredentials,
  hashAdminPassword,
  verifyAdminPassword,
  createAdminSessionToken,
  verifyAdminSessionToken,
  parseCookies,
  getAdminSessionCookieName,
  buildAdminSessionCookie,
  buildAdminLogoutCookie
} from '../src/core/adminAuth.js';

test('账号规范化与校验', () => {
  assert.equal(normalizeAdminUsername('  admin  '), 'admin');
  assert.equal(validateAdminCredentials('admin', 'password123'), 'admin');
  assert.throws(() => validateAdminCredentials('ab', 'password123'), /3-64/);
  assert.throws(() => validateAdminCredentials('含中文', 'password123'), /仅支持/);
  assert.throws(() => validateAdminCredentials('admin', 'short'), /8-128/);
  assert.throws(() => validateAdminCredentials('admin', 'password123', 'password124'), /不一致/);
});

test('密码哈希使用随机盐，且能正确校验', async () => {
  const a = await hashAdminPassword('password123');
  const b = await hashAdminPassword('password123');
  assert.notEqual(a.salt, b.salt, '两次生成的盐必须不同');
  assert.notEqual(a.passwordHash, b.passwordHash, '相同密码不同盐的哈希必须不同');
  assert.equal(await verifyAdminPassword('password123', a.salt, a.passwordHash), true);
  assert.equal(await verifyAdminPassword('wrong-password', a.salt, a.passwordHash), false);
  assert.equal(await verifyAdminPassword('password123', a.salt, 'not-hex'), false);
});

test('会话 Token 可校验，篡改与过期不可通过', () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const token = createAdminSessionToken(secret);
  assert.ok(verifyAdminSessionToken(token, secret));
  assert.equal(verifyAdminSessionToken(token + 'x', secret), null, '篡改签名应失败');
  assert.equal(verifyAdminSessionToken(token, 'other-secret'), null, '错误密钥应失败');
  assert.equal(verifyAdminSessionToken('bad.token', secret), null);
  assert.equal(verifyAdminSessionToken(token, ''), null);

  const parts = token.split('.');
  const expiredPayload = Buffer.from(JSON.stringify({ exp: Date.now() - 1000, nonce: 'x' })).toString('base64url');
  const forged = `${expiredPayload}.${crypto.createHmac('sha256', secret).update(expiredPayload).digest('base64url')}`;
  assert.equal(verifyAdminSessionToken(forged, secret), null, '过期 Token 应失败');
});

test('Cookie 解析容错，畸形转义不抛异常', () => {
  assert.deepEqual(parseCookies('a=1; b=hello%20world'), { a: '1', b: 'hello world' });
  assert.deepEqual(parseCookies('bad=%E0%A4%A'), { bad: '%E0%A4%A' });
  assert.deepEqual(parseCookies(''), {});
});

test('登录 Cookie 属性正确', () => {
  const cookie = buildAdminSessionCookie('token-value', { secure: false, headers: {} });
  assert.match(cookie, new RegExp(`^${getAdminSessionCookieName()}=token-value`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /Secure/);

  const secureCookie = buildAdminSessionCookie('t', { secure: true, headers: {} });
  assert.match(secureCookie, /Secure/);

  const proxyCookie = buildAdminSessionCookie('t', { secure: false, headers: { 'x-forwarded-proto': 'https' } });
  assert.match(proxyCookie, /Secure/);

  assert.match(buildAdminLogoutCookie(), /Max-Age=0/);
});
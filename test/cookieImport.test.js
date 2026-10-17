import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCookieInput,
  parseHeaderString,
  parseCookieJson,
  cookieHeaderFor
} from '../src/core/cookieImport.js';

test('Header String：解析出单域 Cookie（保持旧行为）', () => {
  const parsed = parseCookieInput('_U=abc; MUID=def; _EDGE_S=drop', '.bing.com');
  assert.equal(parsed.format, 'header');
  assert.equal(parsed.cookies.length, 2, '_EDGE_S 必须被剔除');
  assert.ok(parsed.cookies.every(c => c.domain === '.bing.com'));
});

test('JSON：保留每个 Cookie 各自的 domain（跨域登录态的关键）', () => {
  const json = JSON.stringify([
    { name: 'MSPAuth', value: 'x', domain: '.live.com', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction' },
    { name: 'rn_S', value: 'y', domain: 'rewards.bing.com', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction' },
    { name: 'SRCHD', value: 'z', domain: '.bing.com', path: '/', secure: true, sameSite: 'lax' }
  ]);
  const parsed = parseCookieInput(json, '.bing.com');
  assert.equal(parsed.format, 'json');
  assert.equal(parsed.cookies.length, 3);
  assert.deepEqual(parsed.domains, ['.bing.com', '.live.com', 'rewards.bing.com']);
  assert.equal(parsed.cookies.find(c => c.name === 'MSPAuth').sameSite, 'None');
});

test('JSON：__Host- Cookie 使用 url 形式且不带 domain', () => {
  const json = JSON.stringify([
    { name: '__Host-MSAAUTHP', value: 'v', domain: 'login.live.com', path: '/', secure: true, httpOnly: true }
  ]);
  const cookies = parseCookieJson(json);
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].domain, undefined, '__Host- 不能带 domain');
  assert.match(cookies[0].url, /^https:\/\/login\.live\.com\//);
  assert.equal(cookies[0].path, undefined, '__Host- 不能同时带 path 与 url');
});

test('cookieHeaderFor：按目标域名精确筛选，避免把 live.com 凭据发给 bing.com', () => {
  const parsed = parseCookieInput(JSON.stringify([
    { name: 'MSPAuth', value: 'x', domain: '.live.com', path: '/' },
    { name: 'SRCHD', value: 'z', domain: '.bing.com', path: '/' }
  ]));
  assert.equal(cookieHeaderFor(parsed, 'https://rewards.bing.com/earn'), 'SRCHD=z');
  assert.equal(cookieHeaderFor(parsed, 'https://login.live.com/x'), 'MSPAuth=x');
});

test('无效输入不会抛异常', () => {
  assert.equal(parseCookieInput(''), null);
  assert.equal(parseCookieInput(null), null);
  assert.equal(parseCookieInput('not-a-json-array'), null);
  assert.equal(parseCookieJson('{"a":1}'), null);
});

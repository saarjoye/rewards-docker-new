import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MSR_DATA_DIR ||= 'data';

const { default: browserManager } = await import('../src/core/browser.js');

test('Header String Cookie 解析：剔除 Path/Domain/Expires 等属性字段', () => {
  const header = [
    'MUID=36AE7B3059EA689620DD6E8158C269DF',
    'SRCHD=AF=NOFORM',
    '__Host-MSAR=host-value',
    '_EDGE_S=skip-me',
    'bad name=oops',
    'Expires=Wed, 21 Oct 2015 07:28:00 GMT',
    'Max-Age=3600',
    'Path=/',
    'Domain=.bing.com',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Priority=High',
    'Partitioned',
    '$Version=1',
    '_U="quoted-auth-value"'
  ].join('; ');

  const parsed = browserManager.parseCookies(header);
  const names = parsed.map(c => c.name);

  assert.deepEqual(names, ['MUID', 'SRCHD', '__Host-MSAR', '_U']);

  const hostCookie = parsed.find(c => c.name === '__Host-MSAR');
  assert.ok(hostCookie, '__Host- Cookie 必须保留');
  assert.equal(hostCookie.url, 'https://cn.bing.com/');
  assert.equal(hostCookie.secure, true);
  assert.equal(hostCookie.domain, undefined, '__Host- 不允许带 domain 字段');
  assert.equal(hostCookie.path, undefined, '__Host- 用 url 推导 path，不能显式带 path');

  const authCookie = parsed.find(c => c.name === '_U');
  assert.equal(authCookie.value, 'quoted-auth-value', '双引号应被剥离');
  assert.equal(authCookie.domain, '.bing.com');

  for (const c of parsed) {
    assert.equal(typeof c.value, 'string');
    assert.ok(c.value.length > 0);
  }
});

test('Cookie 解析：同名 Cookie 保留最后一次出现的值且保持首次插入顺序', () => {
  const parsed = browserManager.parseCookies('MUID=old; foo=1; MUID=new; bar=2');
  assert.deepEqual(parsed.map(c => c.name), ['MUID', 'foo', 'bar']);
  assert.equal(parsed.find(c => c.name === 'MUID').value, 'new');
});

test('Cookie 解析：非法名 / 控制字符 / 超长值一律跳过', () => {
  const parsed = browserManager.parseCookies(
    `ok=1; bad\x01name=2; ctrl=ab\x02cd; ${'long'.repeat(1500)}=3; also-ok=4`
  );
  assert.deepEqual(parsed.map(c => c.name), ['ok', 'also-ok']);
});

test('Cookie 解析：Safari 表格格式与 Netscape cookie-jar 格式', () => {
  const safari = browserManager.parseCookies('MUID\tABC123\n_U\t"TOKEN"\n_RwBf\trc=180&rb=180');
  assert.deepEqual(safari.map(c => c.name), ['MUID', '_U', '_RwBf']);
  assert.equal(safari[1].value, 'TOKEN');

  const jar = [
    '# Netscape HTTP Cookie File',
    '.bing.com\tTRUE\t/\tTRUE\t2147483647\tMUID\tJAR-VALUE',
    '#HttpOnly_.bing.com\tTRUE\t/\tTRUE\t2147483647\t_U\tJAR-AUTH'
  ].join('\n');
  const parsedJar = browserManager.parseCookies(jar);
  assert.deepEqual(parsedJar.map(c => c.name), ['MUID', '_U']);
  assert.equal(parsedJar[0].value, 'JAR-VALUE');
  assert.equal(parsedJar[1].value, 'JAR-AUTH');
});

test('Cookie 解析：注入结构必须是 Chromium 可接受的字段', () => {
  const parsed = browserManager.parseCookies('MUID=abc; __Host-MSAR=def; _U=ghi');
  const allowed = new Set(['name', 'value', 'domain', 'path', 'url', 'secure', 'sameSite', 'expires']);
  for (const cookie of parsed) {
    for (const key of Object.keys(cookie)) {
      assert.ok(allowed.has(key), `不允许的 Cookie 字段: ${key}`);
    }
    assert.ok(typeof cookie.name === 'string' && cookie.name.length > 0);
    assert.ok(typeof cookie.value === 'string' && cookie.value.length > 0);
    assert.ok(cookie.path === '/' || cookie.url);
    assert.equal(cookie.secure, true);
  }
});
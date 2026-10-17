import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-identity-'));
process.env.MSR_DATA_DIR = tmpDir;

const {
  default: configManager
} = await import('../src/config.js');
const {
  default: networkClient
} = await import('../src/network.js');
const {
  default: authManager,
  compareIdentityEvidence,
  createIdentityEvidence,
  hasCookie,
  isCookieUserLoggedIn,
  attachIdentityEvidence
} = await import('../src/core/auth.js');

function cookieWithU(value = 'cookie-user') {
  return `_U=${value}; WLS=1; SRCHHPGUSR=test`;
}

function loggedInIdentity(ruid = 'ruid-1', epuid = 'epuid-1') {
  return {
    userInfo: {
      isRewardsUser: true,
      profile: {
        ruid,
        attributes: { epuid }
      }
    }
  };
}

async function withNetworkStub(stub, fn) {
  const original = networkClient.request;
  networkClient.request = stub;
  try {
    return await fn();
  } finally {
    networkClient.request = original;
  }
}

test('Cookie 必须包含 _U，KievRPSSecAuth 不能替代', () => {
  assert.equal(hasCookie(cookieWithU(), '_U'), true);
  assert.equal(hasCookie('KievRPSSecAuth=abc; WLS=1', '_U'), false);
  assert.equal(hasCookie('_U=; KievRPSSecAuth=abc', '_U'), false);
});

test('有效 Cookie 身份从 cn.bing.com panelflyout 提取，且不会泄露身份原文', async () => {
  const calls = [];
  const result = await withNetworkStub(async (options) => {
    calls.push(options.url);
    if (options.url.includes('panelflyout/getuserinfo')) return loggedInIdentity('RUID-ABC', 'EPUID-ABC');
    return '<script>self.__next_f.push([1,"x:\\"pointsCounters\\":{\\"pc\\":{\\"max\\":60,\\"progress\\":12},\\"totalPoints\\":321}"])</script>';
  }, () => authManager.checkCookieStatus(cookieWithU('cookie-user'), null));

  assert.equal(calls[0], 'https://cn.bing.com/rewards/panelflyout/getuserinfo');
  assert.equal(result.valid, true);
  assert.equal(result.hasU, true);
  assert.equal(result.identityMatch, 'unknown');
  assert.ok(!Object.keys(result).includes('ruid'), '身份字段不能出现在公开响应中');
  assert.ok(!JSON.stringify(result).includes('RUID-ABC'), '身份值不能出现在 JSON 响应中');
});

test('Cookie 与 OAuth 身份字段相同为 match，不同为 mismatch，缺失为 unknown', () => {
  const cookie = attachIdentityEvidence({ valid: true }, createIdentityEvidence({ profile: { ruid: 'same-ruid', attributes: { epuid: 'same-epuid' } } }));
  const same = attachIdentityEvidence({ valid: true }, createIdentityEvidence({ profile: { ruid: 'same-ruid' } }));
  const other = attachIdentityEvidence({ valid: true }, createIdentityEvidence({ profile: { ruid: 'other-ruid' } }));
  const missing = attachIdentityEvidence({ valid: true }, new Map());

  assert.equal(compareIdentityEvidence(cookie, same).identityMatch, 'match');
  assert.equal(compareIdentityEvidence(cookie, same).sameAccount, true);
  assert.equal(compareIdentityEvidence(cookie, other).identityMatch, 'mismatch');
  assert.equal(compareIdentityEvidence(cookie, other).sameAccount, false);
  assert.equal(compareIdentityEvidence(cookie, missing).identityMatch, 'unknown');
  assert.equal(compareIdentityEvidence(cookie, missing).sameAccount, null);
});

test('未登录身份接口不能返回有效 Cookie 或一致结果', async () => {
  const result = await withNetworkStub(async () => ({
    userInfo: {
      isRewardsUser: false,
      profile: { ruid: 'null-null', attributes: { nonuser: 'True' } }
    }
  }), () => authManager.checkCookieStatus(cookieWithU(), null));

  assert.equal(isCookieUserLoggedIn({
    userInfo: { isRewardsUser: false, profile: { ruid: 'null-null', attributes: { nonuser: 'True' } } }
  }), false);
  assert.equal(result.valid, false);
  assert.equal(result.identityMatch, 'unknown');
});

test('HTTP 503 只能返回 unknown，不能误判为身份不一致', async () => {
  const result = await withNetworkStub(async () => {
    throw new Error('HTTP 503');
  }, () => authManager.checkCookieStatus(cookieWithU(), null));

  assert.equal(result.valid, false);
  assert.equal(result.identityMatch, 'unknown');
  assert.equal(result.sameAccount, null);
  assert.match(result.identityMessage, /暂时不可用|无法确认/);
});

test('缺少 _U 时 Cookie 身份仍可验证，但不能判定完全有效', async () => {
  const result = await withNetworkStub(async (options) => {
    if (options.url.includes('panelflyout/getuserinfo')) return loggedInIdentity('ruid-no-u', 'epuid-no-u');
    return '<script>self.__next_f.push([1,"x:\\"pointsCounters\\":{\\"pc\\":{\\"max\\":60,\\"progress\\":1},\\"totalPoints\\":1}"])</script>';
  }, () => authManager.checkCookieStatus('WLS=1; SRCHHPGUSR=test', null));

  assert.equal(result.valid, true);
  assert.equal(result.hasU, false);
  assert.equal(result.warning, true);
  assert.match(result.warningMessage, /cn\.bing\.com/);
});

test('体检同时比较 Cookie 与 OAuth，身份不一致时 allValid 必须为 false', async () => {
  const originalCookie = authManager.checkCookieStatus;
  const originalToken = authManager.checkTokenStatus;
  authManager.checkCookieStatus = async () => attachIdentityEvidence({
    valid: true,
    hasU: true,
    warning: false,
    message: 'cookie ok'
  }, createIdentityEvidence({ profile: { ruid: 'cookie-ruid' } }));
  authManager.checkTokenStatus = async () => attachIdentityEvidence({
    valid: true,
    message: 'token ok'
  }, createIdentityEvidence({ profile: { ruid: 'oauth-ruid' } }));

  try {
    const result = await authManager.testAccount('acc_identity_test');
    assert.equal(result.identityMatch, 'mismatch');
    assert.equal(result.cookie.identityMatch, 'mismatch');
    assert.equal(result.token.identityMatch, 'mismatch');
    assert.equal(result.allValid, false);
    assert.equal(result.warning, true);
    assert.match(result.warningMessage, /不一致/);
  } finally {
    authManager.checkCookieStatus = originalCookie;
    authManager.checkTokenStatus = originalToken;
  }
});

test('命名的诊断字段可以正常落盘并保留身份结论', () => {
  configManager.update({ accounts: [
    { id: 'acc_diag_identity', name: '身份诊断', enabled: true, cookie: '', refreshToken: '', accessToken: '' }
  ] });
  const diagnosis = configManager.recordAuthDiagnosis('acc_diag_identity', {
    cookieValid: true,
    tokenValid: true,
    overallValid: true,
    warning: true,
    warningMessage: '身份不一致',
    balance: 12,
    identityMatch: 'mismatch',
    sameAccount: false,
    identityMessage: '身份不一致',
    matchMethod: 'identity'
  });
  assert.equal(diagnosis.identityMatch, 'mismatch');
  assert.equal(diagnosis.sameAccount, false);
  assert.equal(diagnosis.matchMethod, 'identity');
});
test('parseWlsInfo 能正确提取 WLS Cookie 中的 CID 与解码用户名', async () => {
  const { parseWlsInfo } = await import('../src/core/auth.js');
  const info1 = parseWlsInfo('WLS=C=58f47b6d3bea1c91&N=Octavia');
  assert.equal(info1.cid, '58f47b6d3bea1c91');
  assert.equal(info1.name, 'Octavia');

  const info2 = parseWlsInfo('WLS=C=00000000-0000-0000-2349-0617d0e5bebf&N=%e5%a3%b0%e5%bc%ba+%e5%88%98');
  assert.equal(info2.cid, '23490617d0e5bebf');
  assert.equal(info2.name, '声强 刘');
});

test('compareIdentityEvidence：CID 一致时为 match 并携带账号信息，CID 冲突时为 mismatch 并阻止通过', () => {
  const cookieMatched = {
    valid: true,
    userCid: '58f47b6d3bea1c91',
    userName: 'Octavia',
    userEmail: 'joanoctavian2930@hotmail.com'
  };
  const tokenMatched = {
    valid: true,
    userId: '58f47b6d3bea1c91',
    balance: 4061
  };
  const tokenConflict = {
    valid: true,
    userId: '23490617d0e5bebf',
    balance: 13555
  };

  const resMatch = compareIdentityEvidence(cookieMatched, tokenMatched);
  assert.equal(resMatch.identityMatch, 'match');
  assert.equal(resMatch.sameAccount, true);
  assert.match(resMatch.identityMessage, /joanoctavian2930@hotmail.com/i);
  assert.match(resMatch.identityMessage, /Octavia/i);

  const resMismatch = compareIdentityEvidence(cookieMatched, tokenConflict);
  assert.equal(resMismatch.identityMatch, 'mismatch');
  assert.equal(resMismatch.sameAccount, false);
  assert.match(resMismatch.identityMessage, /账号不一致/);
  assert.match(resMismatch.identityMessage, /58f47b6d3bea1c91/i);
  assert.match(resMismatch.identityMessage, /23490617d0e5bebf/i);
});

test('compareIdentityEvidence：epuid 与 ruid 大小写不同时，仍然判定为 match，不得误判为 mismatch', () => {
  const cookie = {
    valid: true,
    userCid: '58f47b6d3bea1c91',
    userName: 'Octavia',
    userEmail: 'joanoctavian2930@hotmail.com',
    epuid: 'dz9oamqc00dexpgpja1hltpbzimugqwnb1haipj3chrtygmud3fvixikeeqndoryuein6ridan7ezmbc3mpqusnlypmuqxby5jr2x5igg3c'
  };
  const token = {
    valid: true,
    userId: '58f47b6d3bea1c91',
    epuid: 'dZ9OAmqC00dEXpGpjA1hLtPBziMuGqwNB1HAipJ3CHrtyGmuD3FVIxiKeEQNdORyuEIN6RIDaN7eZmBc3MpQusNLyPMuQXby5JR2X5IGG3c',
    balance: 4073
  };
  const res = compareIdentityEvidence(cookie, token);
  assert.equal(res.identityMatch, 'match');
  assert.equal(res.sameAccount, true);
});

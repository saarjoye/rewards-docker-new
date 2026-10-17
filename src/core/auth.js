import configManager from '../config.js';
import networkClient from '../network.js';
import logger from '../logger.js';
import { APP_USER_AGENT, pcPageHeaders } from './fingerprint.js';
import { parseCookieInput, cookieHeaderFor } from './cookieImport.js';

export const AUTH_CONFIG = {
  clientId: '0000000040170455',
  scope: 'service::prod.rewardsplatform.microsoft.com::MBI_SSL',
  redirectUri: 'https://login.live.com/oauth20_desktop.srf',
  authorizeUrl: 'https://login.live.com/oauth20_authorize.srf?client_id=0000000040170455&response_type=code&scope=service::prod.rewardsplatform.microsoft.com::MBI_SSL&redirect_uri=https://login.live.com/oauth20_desktop.srf',
  tokenUrl: 'https://login.live.com/oauth20_token.srf'
};

const IDENTITY_EVIDENCE = Symbol('msr.identityEvidence');
const IDENTITY_FIELD_NAMES = new Set([
  'ruid', 'epuid', 'cimsid', 'userid', 'user_id', 'uid', 'memberid',
  'profileid', 'puid', 'accountid', 'account_id', '_u'
]);
const INVALID_IDENTITY_VALUES = new Set(['', 'null', 'null-null', 'undefined', 'false']);

/**
 * 统一身份值格式。比较过程只在服务端内存中进行，绝不返回给前端。
 */

function normalizeCid(cid) {
  if (!cid) return '';
  return String(cid).replace(/[^a-zA-Z0-9]/g, '').toLowerCase().replace(/^0+/, '');
}

function normalizeRuid(ruid) {
  if (!ruid) return '';
  const text = String(ruid).trim().toUpperCase();
  return text.replace(/^(?:HK|USW|US|EU|SG|JP|AU|CN|IN|EA|CANARY)-/, '');
}

export function parseWlsInfo(cookie) {
  if (!cookie) return { cid: '', name: '' };
  const parsed = parseCookieInput(cookie, '.bing.com');
  const wls = parsed?.cookies?.find(c => c.name === 'WLS');
  if (!wls || !wls.value) return { cid: '', name: '' };
  const val = String(wls.value);
  const mC = val.match(/(?:^|[&?])C=([^&;]+)/i);
  const mN = val.match(/(?:^|[&?])N=([^&;]+)/i);
  let name = '';
  if (mN) {
    try {
      name = decodeURIComponent(mN[1].replace(/\+/g, ' ')).trim();
    } catch {
      name = mN[1].trim();
    }
  }
  const cid = mC ? normalizeCid(mC[1]) : '';
  return { cid, name };
}

export async function fetchBingUserEmail(cookie) {
  if (!cookie) return null;
  const parsed = parseCookieInput(cookie, '.bing.com');
  if (!parsed || !parsed.cookies.length) return null;
  try {
    const html = await networkClient.request({
      url: 'https://cn.bing.com/',
      headers: pcPageHeaders({
        cookie: cookieHeaderFor(parsed, 'https://cn.bing.com/')
      }),
      timeout: 10000
    });
    const m = String(html).match(/"UserEmail"\s*:\s*"([^"]+@[^"]+)"/i);
    return m ? m[1].toLowerCase().trim() : null;
  } catch {
    return null;
  }
}

export function normalizeIdentityValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' || typeof value === 'function' || typeof value === 'symbol') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;

  let text = String(value).trim();
  if (!text) return null;
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  try {
    const decoded = decodeURIComponent(text);
    if (decoded !== text) text = decoded;
  } catch {}
  const normalized = text.trim().toLowerCase();
  if (INVALID_IDENTITY_VALUES.has(normalized)) return null;
  return normalized;
}

function addIdentityValue(fields, key, value) {
  const normalized = normalizeIdentityValue(value);
  if (!normalized) return;
  if (!fields.has(key)) fields.set(key, new Set());
  fields.get(key).add(normalized);
}

export function collectIdentityFields(source, target = new Map(), depth = 0, seen = new WeakSet()) {
  if (source === null || source === undefined || depth > 8) return target;

  if (typeof source === 'string') {
    const trimmed = source.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return collectIdentityFields(JSON.parse(trimmed), target, depth + 1, seen);
      } catch {}
    }
    return target;
  }
  if (typeof source !== 'object') return target;
  if (seen.has(source)) return target;
  seen.add(source);

  if (source instanceof Map) {
    for (const [key, value] of source.entries()) {
      const normalizedKey = String(key).toLowerCase();
      if (IDENTITY_FIELD_NAMES.has(normalizedKey)) addIdentityValue(target, normalizedKey, value);
      if (value && typeof value === 'object') collectIdentityFields(value, target, depth + 1, seen);
    }
    return target;
  }

  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = String(key).toLowerCase();
    if (IDENTITY_FIELD_NAMES.has(normalizedKey)) addIdentityValue(target, normalizedKey, value);
    if (value && typeof value === 'object') collectIdentityFields(value, target, depth + 1, seen);
  }
  return target;
}

export function mergeIdentityFields(...fieldMaps) {
  const merged = new Map();
  for (const fieldMap of fieldMaps) {
    if (!fieldMap || typeof fieldMap.forEach !== 'function') continue;
    fieldMap.forEach((values, key) => {
      if (!merged.has(key)) merged.set(key, new Set());
      const iterable = values instanceof Set ? values : [values];
      for (const value of iterable) {
        const normalized = normalizeIdentityValue(value);
        if (normalized) merged.get(key).add(normalized);
      }
    });
  }
  return merged;
}

export function createIdentityEvidence(...sources) {
  let fields = new Map();
  for (const source of sources) {
    if (source instanceof Map) {
      fields = mergeIdentityFields(fields, source);
    } else {
      fields = mergeIdentityFields(fields, collectIdentityFields(source));
    }
  }
  return fields;
}

export function attachIdentityEvidence(target, evidence) {
  if (!target || typeof target !== 'object') return target;
  const value = evidence instanceof Map ? evidence : createIdentityEvidence(evidence);
  Object.defineProperty(target, IDENTITY_EVIDENCE, {
    value,
    enumerable: false,
    configurable: true,
    writable: false
  });
  return target;
}

export function getIdentityEvidence(target) {
  return target && typeof target === 'object' ? target[IDENTITY_EVIDENCE] : undefined;
}

export function parseCookieValue(cookie, name) {
  if (!cookie || !name) return null;
  for (const part of String(cookie).split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key !== name) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return null;
}

export function hasCookie(cookie, name) {
  if (!cookie) return false;
  const text = typeof cookie === 'string' ? cookie.trim() : '';
  if (text.startsWith('[')) {
    const parsed = parseCookieInput(text, '.bing.com');
    return !!parsed && parsed.cookies.some(c => c.name === name && c.value !== '');
  }
  const value = parseCookieValue(cookie, name);
  return value !== null && value !== '';
}

/**
 * 判断 Cookie 是否覆盖 rewards.bing.com 登录所需的跨域会话。
 * JSON 导出应包含 .live.com / rewards.bing.com 的会话；Header String 天然不包含。
 */
function describeCookieScope(cookie) {
  const text = typeof cookie === 'string' ? cookie.trim() : '';
  if (!text.startsWith('[')) {
    return { format: 'header', domains: ['.bing.com'], crossDomainReady: false };
  }
  const parsed = parseCookieInput(text, '.bing.com');
  if (!parsed) return { format: 'json', domains: [], crossDomainReady: false };
  const domains = parsed.domains;
  const hasLive = domains.some(d => d === '.live.com' || d.endsWith('live.com'));
  const hasRewards = domains.some(d => d === 'rewards.bing.com' || d.endsWith('.rewards.bing.com'));
  return { format: 'json', domains, crossDomainReady: hasLive && hasRewards };
}

/** 把配置里的 Cookie 转成某站点可直接发送的 Cookie 头 */
function cookieHeaderForUrl(cookie, url) {
  if (!cookie) return '';
  const text = typeof cookie === 'string' ? cookie.trim() : '';
  if (text.startsWith('[')) {
    const parsed = parseCookieInput(text, '.bing.com');
    return parsed ? cookieHeaderFor(parsed, url) : '';
  }
  return cookie;
}

export function isCookieUserLoggedIn(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch { return false; }
  }
  if (!data || typeof data !== 'object') return false;

  const userInfo = data.userInfo || data;
  const profile = userInfo.profile || data.profile || data.response?.profile || {};
  const attributes = profile.attributes || userInfo.attributes || data.attributes || {};
  const nonUser = normalizeIdentityValue(attributes.nonuser);
  if (nonUser === 'true') return false;
  if (userInfo.isRewardsUser === false) return false;

  return createIdentityEvidence(data).size > 0;
}

function getFirstEvidenceValue(obj, key) {
  if (!obj) return null;
  const ev = getIdentityEvidence(obj);
  if (!ev) return null;
  const set = ev.get(String(key).toLowerCase());
  if (!set || !set.size) return null;
  return [...set][0];
}

export function compareIdentityEvidence(left, right) {
  if (!left || !right) {
    return {
      identityMatch: 'unknown',
      sameAccount: null,
      matchMethod: 'identity',
      identityMessage: '缺少比对对象，暂时无法确认身份一致性'
    };
  }

  // 1. 提取 Cookie 侧关键标识
  const cookieCid = normalizeCid(left.userCid || getFirstEvidenceValue(left, 'cid') || getFirstEvidenceValue(left, 'user_id'));
  const cookieRuid = normalizeRuid(getFirstEvidenceValue(left, 'ruid') || left.ruid);
  const cookieEpuid = String(getFirstEvidenceValue(left, 'epuid') || left.epuid || '').trim().toLowerCase();
  const cookieEmail = String(left.userEmail || '').trim().toLowerCase();
  const cookieName = String(left.userName || '').trim();

  // 2. 提取 OAuth 侧关键标识
  const tokenCid = normalizeCid(right.userId || getFirstEvidenceValue(right, 'cid') || getFirstEvidenceValue(right, 'user_id'));
  const tokenRuid = normalizeRuid(getFirstEvidenceValue(right, 'ruid') || right.ruid);
  const tokenEpuid = String(getFirstEvidenceValue(right, 'epuid') || right.epuid || '').trim().toLowerCase();

  // 3. 冲突判定（mismatch）
  if (cookieCid && tokenCid && cookieCid !== tokenCid) {
    const cLabel = [cookieEmail, cookieName].filter(Boolean).join(' / ');
    const cDesc = cLabel ? (cookieCid ? (cLabel + ' (ID: ' + cookieCid + ')') : cLabel) : ('ID: ' + cookieCid);
    return {
      identityMatch: 'mismatch',
      sameAccount: false,
      matchMethod: 'identity',
      identityMessage: '账号不一致：网页端 Cookie 登录的是 ' + cDesc + '，但移动端 Token 属于账号 ID: ' + tokenCid + (right.balance !== undefined ? '（积分: ' + right.balance + '）' : '') + '！存在严重串号风险，禁止执行任务，请重新配置为同一账号。'
    };
  }

  if (cookieRuid && tokenRuid && cookieRuid !== tokenRuid) {
    const cDesc = [cookieEmail, cookieName].filter(Boolean).join(' / ') || '网页端账号';
    return {
      identityMatch: 'mismatch',
      sameAccount: false,
      matchMethod: 'identity',
      identityMessage: '账号不一致：网页端 Cookie 登录的是 ' + cDesc + '，但移动端 Token 属于另一个微软账号！请重新配置为同一账号。'
    };
  }

  if (cookieEpuid && tokenEpuid && cookieEpuid !== tokenEpuid) {
    const cDesc = [cookieEmail, cookieName].filter(Boolean).join(' / ') || '网页端账号';
    return {
      identityMatch: 'mismatch',
      sameAccount: false,
      matchMethod: 'identity',
      identityMessage: '账号不一致：网页端 Cookie 与移动端 Token 属于不同账号公钥！请重新配置为同一账号。'
    };
  }

  // 4. 一致判定（match）
  const cidMatched = !!(cookieCid && tokenCid && cookieCid === tokenCid);
  const ruidMatched = !!(cookieRuid && tokenRuid && cookieRuid === tokenRuid);
  const epuidMatched = !!(cookieEpuid && tokenEpuid && cookieEpuid === tokenEpuid);

  if (cidMatched || ruidMatched || epuidMatched) {
    const accountLabel = [cookieEmail, cookieName].filter(Boolean).join(' / ') || (cookieCid ? ('ID: ' + cookieCid) : '');
    return {
      identityMatch: 'match',
      sameAccount: true,
      matchMethod: 'identity',
      identityMessage: 'Cookie 与 OAuth Token 属于同一微软账号' + (accountLabel ? ' (' + accountLabel + ')' : '')
    };
  }

  // 5. 无法确认（unknown）
  return {
    identityMatch: 'unknown',
    sameAccount: null,
    matchMethod: 'identity',
    identityMessage: '暂时无法确认 Cookie 与 OAuth 是否为同一账号（缺少可比对的唯一标识）'
  };
}

export class AuthManager {
  constructor() {
    this.accessToken = null;
    this.initFromConfig();
  }

  initFromConfig() {
    const cfg = configManager.get();
    if (cfg.account?.accessToken) {
      this.accessToken = cfg.account.accessToken;
    }
  }

  getAccessToken(accountId = null) {
    // 不传 accountId 时返回全局 token（单账号兼容路径）。
    if (!accountId) return this.accessToken || null;
    // 传了 accountId 就必须精确命中该账号，并且只能用它自己的 token。
    // 旧写法 `acc?.accessToken || this.accessToken` 会在这个账号 token 为空时
    // 回退到「上一个刷新成功的账号」的 token —— 结果副账号的 App 签到 / 阅读
    // 会被算到主账号头上（典型的串号）。
    const acc = configManager.findAccount(accountId);
    if (!acc) return null;
    return acc.accessToken || null;
  }

  /**
   * 从粘贴的 URL 或 code 字符串中提取 code
   */
  extractCode(input) {
    if (!input || typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (trimmed.includes('code=')) {
      try {
        const u = new URL(trimmed);
        return u.searchParams.get('code');
      } catch {
        const m = trimmed.match(/[?&]code=([^&#]+)/);
        return m ? decodeURIComponent(m[1]) : null;
      }
    }
    return trimmed;
  }

  /**
   * 通过授权码换取 Token
   */
  async exchangeCodeForToken(codeOrUrl, accountId = null, accountMeta = {}) {
    const code = this.extractCode(codeOrUrl);
    if (!code) {
      throw new Error('无效的授权码或链接，未找到 code 参数');
    }

    // 必须精确匹配：accountId 不存在时不能用 getAccount()，
    // 它会静默回退到第一个账号，导致「配置向导换 Token」覆盖主账号。
    const targetAccount = configManager.findAccount(accountId);
    const targetId = targetAccount?.id || accountId || `acc_${Date.now()}`;
    const displayName = targetAccount?.name || accountMeta.name || targetId;

    const params = new URLSearchParams({
      client_id: AUTH_CONFIG.clientId,
      code: code,
      redirect_uri: AUTH_CONFIG.redirectUri,
      grant_type: 'authorization_code'
    });

    const prevCtx = logger.getAccountContext();
    logger.setAccountContext(displayName);

    try {
      logger.log('🔑', `正在为账号 [${displayName}] 换取访问令牌 (Token)...`);
      const res = await networkClient.request({
        url: AUTH_CONFIG.tokenUrl,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: params.toString()
      });

      const data = typeof res === 'string' ? JSON.parse(res) : res;
      if (data.error) {
        throw new Error(`${data.error}: ${data.error_description || ''}`);
      }

      if (data.access_token && data.refresh_token) {
        this.accessToken = data.access_token;
        const userId = data.user_id ? String(data.user_id).trim() : '';
        configManager.upsertAccount({
          id: targetId,
          // 新账号（配置向导草稿）需要带上名称与序号，否则会生成名为「账号 N」的占位账号
          ...(targetAccount ? {} : { name: accountMeta.name, order: accountMeta.order }),
          authCodeUrl: codeOrUrl,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          oauthUserId: userId,
          tokenTime: Date.now()
        });
        logger.log('🟢', `账号 [${displayName}] OAuth Token 换取成功并已持久化保存！`);
        let balance = null;
        try {
          const tStatus = await this.checkTokenStatus(targetId);
          if (tStatus?.balance !== undefined) balance = tStatus.balance;
        } catch {}
        const accountInfo = [
          userId ? '账号ID: ' + userId : '',
          balance !== null ? '积分: ' + balance : ''
        ].filter(Boolean).join(' | ');
        return {
          success: true,
          accountId: targetId,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          userId,
          balance,
          accountInfo
        };
      }
      throw new Error('响应中未找到 access_token 或 refresh_token');
    } catch (e) {
      logger.log('🔴', `换取 Token 失败: ${e.message}`);
      throw e;
    } finally {
      logger.setAccountContext(prevCtx);
    }
  }

  /**
   * 使用 Refresh Token 刷新 Access Token
   */
  async refreshToken(force = false, accountId = null) {
    const acc = configManager.resolveAccount(accountId);
    if (!acc) return false;

    // 本函数内的日志统一归属到该账号
    const prevCtx = logger.getAccountContext();
    logger.setAccountContext(acc.name || acc.id);

    let refreshToken = acc.refreshToken;
    const tokenTime = acc.tokenTime || 0;

    // 检查有效期，如果刚刷过且没有强制要求，且已经有 accessToken，则直接复用
    const diffHours = (Date.now() - tokenTime) / (1000 * 60 * 60);
    if (!force && acc.accessToken && acc.oauthUserId && diffHours < 12) {
      this.accessToken = acc.accessToken;
      logger.setAccountContext(prevCtx);
      return true;
    }

    if (!refreshToken) {
      logger.log('🟡', `账号 [${acc.name || acc.id}] 未配置 Refresh Token，跳过 Token 刷新`);
      logger.setAccountContext(prevCtx);
      return false;
    }

    const params = new URLSearchParams({
      client_id: AUTH_CONFIG.clientId,
      refresh_token: refreshToken,
      scope: AUTH_CONFIG.scope,
      grant_type: 'REFRESH_TOKEN'
    });

    try {
      logger.log('🔄', `正在为账号 [${acc.name || acc.id}] 自动续期刷新 OAuth Token...`);
      const res = await networkClient.request({
        url: AUTH_CONFIG.tokenUrl,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: params.toString()
      });

      const data = typeof res === 'string' ? JSON.parse(res) : res;
      if (data.error) {
        logger.log('🔴', `账号 [${acc.name}] 刷新 Token 失败: ${data.error} - ${data.error_description || ''}`);
        if (['invalid_grant', 'invalid_request'].includes(data.error)) {
          configManager.upsertAccount({
            id: acc.id,
            accessToken: null,
            refreshToken: null,
            tokenTime: 0
          });
        }
        return false;
      }

      if (data.access_token && data.refresh_token) {
        this.accessToken = data.access_token;
        configManager.upsertAccount({
          id: acc.id,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          oauthUserId: data.user_id ? String(data.user_id).trim() : (acc.oauthUserId || ''),
          tokenTime: Date.now()
        });
        logger.log('🟢', `账号 [${acc.name}] OAuth Token 续期刷新成功！`);
        return true;
      }
      return false;
    } catch (e) {
      logger.log('🔴', `刷新 Token 请求异常: ${e.message}`);
      return false;
    } finally {
      logger.setAccountContext(prevCtx);
    }
  }

  /**
   * 验证网页端 Cookie 是否有效并拉取账号详情。
   * 登录态只使用 cn.bing.com 的 panelflyout 身份接口验证；
   * rewards.bing.com/earn 仅用于解析积分、任务和印章等业务数据。
   */
  async checkCookieStatus(cookieOverride = null, accountId = null) {
    const acc = configManager.resolveAccount(accountId);
    const cookie = cookieOverride || acc?.cookie;
    if (!cookie) {
      return {
        valid: false,
        hasU: false,
        warning: false,
        identityMatch: 'unknown',
        sameAccount: null,
        matchMethod: 'identity',
        identityMessage: '尚未配置网页端 Cookie',
        message: '尚未配置网页端 Cookie'
      };
    }

    const hasU = hasCookie(cookie, '_U');
    const scope = describeCookieScope(cookie);
    // 诊断：列出配置里实际包含的 Cookie 名称（不含值）
    const cookieNames = scope.format === 'json'
      ? (parseCookieInput(String(cookie), '.bing.com')?.cookies || []).map(c => c.name)
      : String(cookie).split(';').map(part => part.trim().split('=')[0]).filter(Boolean);
    let identityData;
    try {
      const rawIdentity = await networkClient.request({
        url: 'https://cn.bing.com/rewards/panelflyout/getuserinfo',
        headers: pcPageHeaders({
          'referer': 'https://cn.bing.com/',
          'cookie': cookieHeaderForUrl(cookie, 'https://cn.bing.com/rewards/panelflyout/getuserinfo')
        })
      });
      identityData = typeof rawIdentity === 'string' ? JSON.parse(rawIdentity) : rawIdentity;
    } catch (e) {
      const msg = e?.message || String(e);
      const unavailable = /HTTP\s+5\d\d/.test(msg);
      const expired = /HTTP\s+(401|403)/.test(msg);
      return {
        valid: false,
        hasU,
        warning: !hasU,
        identityMatch: 'unknown',
        sameAccount: null,
        matchMethod: 'identity',
        identityMessage: unavailable
          ? '身份接口暂时不可用，Cookie 与 OAuth 身份无法确认'
          : '无法读取 Cookie 登录身份，Cookie 与 OAuth 身份无法确认',
        message: expired
          ? '微软身份接口返回 HTTP 401/403，Cookie 已过期，请在 cn.bing.com 重新登录后获取'
          : `网页端身份接口请求失败: ${msg}`
      };
    }

    if (!isCookieUserLoggedIn(identityData)) {
      return {
        valid: false,
        hasU,
        warning: !hasU,
        identityMatch: 'unknown',
        sameAccount: null,
        matchMethod: 'identity',
        identityMessage: 'Cookie 未提供有效的已登录微软身份',
        message: hasU
          ? 'Cookie 已失效或不是已登录状态，请重新登录后获取'
          : (scope.format === 'header'
              ? 'Cookie 缺少 _U 或已失效。更常见的是：Header String 只有 bing.com 域，拿不到 rewards.bing.com 新版 OAuth 会话，请在 rewards.bing.com 用 Cookie-Editor 导出 JSON 后重新导入'
              : 'JSON 中没有 _U，导出时请确保在已登录的 rewards.bing.com 页面进行'),
        cookieNames,
        cookieFormat: scope.format,
        cookieDomains: scope.domains,
        crossDomainReady: scope.crossDomainReady
      };
    }

    const identityEvidence = createIdentityEvidence(identityData, {
      _U: parseCookieValue(cookie, '_U')
    });
    // JSON 且跨域会话齐全时，浏览器路径不需要 _U（实测 Chrome 里也没有 _U）
    const needsUWarning = !hasU && !scope.crossDomainReady;
    const uWarning = needsUWarning
      ? ' | 缺少 _U 登录标头，必应搜索无法关联账号计分！请用 Cookie-Editor 在 rewards.bing.com 导出 JSON 后重新导入'
      : '';
    const identityStatus = {
      valid: true,
      hasU,
      warning: !hasU,
      warningMessage: needsUWarning ? '缺少 _U 登录标头：必应搜索无法关联账号计分，请在已登录的 rewards.bing.com 用 Cookie-Editor 导出 JSON 后重新导入（Header String 也可从 cn.bing.com 抓取）' : '',
      identityMatch: 'unknown',
      sameAccount: null,
      matchMethod: 'identity',
      identityMessage: 'Cookie 身份有效，等待与 OAuth Token 比对'
    };

    let balance = 0;
    let pcProgress = 0, pcMax = 60;
    let streakDays = 0;
    let userName = '';
    let stampsProgress = 0, stampsMax = 12;
    let businessMessage = '';

    try {
      const earnHtml = await networkClient.request({
        url: 'https://rewards.bing.com/earn',
        headers: pcPageHeaders({
          'referer': 'https://rewards.bing.com/',
          'cookie': cookieHeaderForUrl(cookie, 'https://rewards.bing.com/earn')
        })
      });
      const clean = String(earnHtml).replace(/\\"/g, '"');
      const isAuthValid = clean.includes('pointsCounters') || clean.includes('pointsHistory') || clean.includes('activityCards');

      if (isAuthValid) {
        const pcIdx = clean.indexOf('"pointsCounters":{');
        if (pcIdx !== -1) {
          let start = pcIdx + 17, depth = 0, end = start;
          for (let i = start; i < clean.length && i < start + 500; i++) {
            if (clean[i] === '{') depth++;
            if (clean[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
          }
          try {
            const pts = JSON.parse(clean.substring(start, end));
            pcMax = pts.pc?.max ?? 60;
            pcProgress = pts.pc?.progress ?? 0;
            if (pts.totalPoints != null) balance = Number(pts.totalPoints);
          } catch {}
        }

        const balMatch = clean.match(/"balance":(\d+)/)
          || clean.match(/"availablePoints":(\d+)/)
          || cookie.match(/rc=(\d+)/)
          || cookie.match(/rb=(\d+)/);
        if (balMatch) balance = parseInt(balMatch[1], 10);

        const streakMatch = clean.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').match(/每日连续打卡\s*(\d+)/);
        if (streakMatch) streakDays = parseInt(streakMatch[1], 10);

        // 优先从 WLS Cookie 中解析用户名，避免 JSON 格式下正则跨行误匹配
        const wlsInfo = parseWlsInfo(cookie);
        if (wlsInfo.name) userName = wlsInfo.name;

        const stampMatch = clean.match(/"aria-label":"收集的印章"[^}]*?"aria-valuemax":(\d+)[^}]*?"aria-valuenow":(\d+)/)
          || clean.match(/aria-label="收集的印章"[^>]*?aria-valuemax="(\d+)"[^>]*?aria-valuenow="(\d+)"/);
        if (stampMatch) {
          stampsMax = parseInt(stampMatch[1], 10) || 12;
          stampsProgress = parseInt(stampMatch[2], 10) || 8;
        }
      } else if (clean.includes('login.live.com') || clean.includes('Sign in')) {
        businessMessage = '业务页面要求重新登录，Cookie 登录态可能已失效';
      } else {
        businessMessage = '身份有效，但业务页面暂未返回任务数据';
      }
    } catch (e) {
      businessMessage = `身份有效，但业务页面暂时不可用: ${e.message}`;
    }

    if (!balance && identityData) {
      const flyoutBal = identityData?.flyoutResult?.userStatus?.availablePoints ?? identityData?.userInfo?.balance;
      if (flyoutBal != null && Number.isFinite(Number(flyoutBal))) {
        balance = Number(flyoutBal);
      }
    }
    if (pcProgress === 0 && pcMax === 60 && identityData) {
      const pcSearch = identityData?.flyoutResult?.userStatus?.counters?.PCSearch?.[0];
      if (pcSearch) {
        pcProgress = Number(pcSearch.pointProgress || 0);
        pcMax = Number(pcSearch.pointProgressMax || 60);
      }
    }
    if (identityData?.userInfo?.isRewardsUser && businessMessage.includes('Cookie 登录态可能已失效')) {
      businessMessage = '';
    }

    const wlsInfoFinal = parseWlsInfo(cookie);
    let bingEmail = null;
    try {
      bingEmail = await fetchBingUserEmail(cookie);
    } catch {}

    const resolvedUser = userName || wlsInfoFinal.name || '微软用户';
    const resolvedEmail = bingEmail || '';
    const resolvedCid = wlsInfoFinal.cid || '';

    identityStatus.balance = balance;
    identityStatus.userName = resolvedUser;
    identityStatus.userEmail = resolvedEmail;
    identityStatus.userCid = resolvedCid;
    identityStatus.streakDays = streakDays;
    identityStatus.stamps = { progress: stampsProgress, max: stampsMax };
    identityStatus.pcSearch = `${pcProgress}/${pcMax}`;
    identityStatus.cookieFormat = scope.format;
    identityStatus.cookieDomains = scope.domains;
    identityStatus.crossDomainReady = scope.crossDomainReady;

    const userDesc = [resolvedEmail, resolvedUser !== '微软用户' ? resolvedUser : ''].filter(Boolean).join(' / ') || resolvedUser;
    identityStatus.message = `网页端身份已登录！${userDesc ? `账号: ${userDesc} | ` : ''}积分: ${balance} | 连续签到: ${streakDays}天 | 印章进度: ${stampsProgress}/${stampsMax} | 搜索配额: ${pcProgress}/${pcMax}${uWarning}${businessMessage ? ` | ${businessMessage}` : ''}`;
    return attachIdentityEvidence(identityStatus, identityEvidence);
  }

  /**
   * 实测移动端 OAuth Token 与 DAPI 接口连通性。
   * DAPI 响应中的身份字段只以不可枚举 Symbol 挂在返回对象上，序列化时不会泄露。
   */
  async checkTokenStatus(accountId = null) {
    const acc = configManager.resolveAccount(accountId);
    if (!acc?.refreshToken && !acc?.accessToken) {
      return { valid: false, message: '尚未完成移动端授权 (未配置 Token)' };
    }

    const tokenOk = await this.refreshToken(false, accountId);
    const refreshedAcc = configManager.findAccount(accountId) || configManager.resolveAccount(accountId);
    const token = this.getAccessToken(accountId);
    if (!tokenOk || !token) {
      return { valid: false, message: 'Refresh Token 已过期或失效，请重新授权' };
    }

    try {
      const res = await networkClient.request({
        url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'user-agent': APP_USER_AGENT,
          'authorization': `Bearer ${token}`,
          'x-rewards-appid': 'SAAndroid/32.6.2110003560',
          'x-rewards-ismobile': 'true',
          'x-rewards-country': 'cn',
          'x-rewards-language': 'zh'
        }
      });

      const data = typeof res === 'string' ? JSON.parse(res) : res;
      const tokenIdentity = createIdentityEvidence(data?.response || {});
      const userId = refreshedAcc?.oauthUserId || acc?.oauthUserId || '';
      const ruid = data?.response?.profile?.ruid || '';
      const epuid = data?.response?.profile?.attributes?.epuid || '';
      if (data?.response) {
        const balance = Number(data.response.balance || 0);
        const promos = data.response.promotions || [];
        const readTask = promos.find(x => x.attributes?.offerid === 'ENUS_readarticle3_30points');
        const readProg = readTask ? `${readTask.attributes.progress || 0}/${readTask.attributes.max || 30}` : '就绪';
        return attachIdentityEvidence({
          valid: true,
          balance,
          userId,
          ruid,
          epuid,
          readProgress: readProg,
          message: `移动端已登录${userId ? ` (账号ID: ${userId})` : ''} | 积分: ${balance} | 阅读进度: ${readProg}`
        }, tokenIdentity);
      }
      return attachIdentityEvidence({ valid: true, userId, ruid, epuid, message: `移动端 Token 有效${userId ? ` (账号ID: ${userId})` : ''}` }, tokenIdentity);
    } catch (e) {
      return { valid: false, message: `移动端 DAPI 接口验证失败: ${e.message}` };
    }
  }

  /**
   * 一键全面诊断测试账户在 Docker 中的登录状态。
   * Cookie 有效但无法确认身份时为 unknown；只有明确身份冲突才判为 mismatch。
   */
  async testAccount(accountId = null) {
    const acc = configManager.resolveAccount(accountId);
    const name = acc?.name || accountId || '当前账号';
    const prevCtx = logger.getAccountContext();
    logger.setAccountContext(name);
    logger.log('🔍', `开始检测账号 [${name}] 在 Docker 容器中的登录状态...`);

    const [cookieStatus, tokenStatus] = await Promise.all([
      this.checkCookieStatus(null, accountId),
      this.checkTokenStatus(accountId)
    ]);

    const identity = compareIdentityEvidence(cookieStatus, tokenStatus);
    Object.assign(cookieStatus, identity);
    Object.assign(tokenStatus, identity);

    const hasCode = !!acc?.authCodeUrl;
    const codeStatus = {
      valid: hasCode || tokenStatus.valid,
      message: hasCode ? '授权码链接已配置' : (tokenStatus.valid ? '已通过历史授权码成功获取Token' : '尚未填写授权码链接')
    };

    const balance = cookieStatus.balance || tokenStatus.balance || 0;
    const cookieUsable = cookieStatus.valid && !cookieStatus.warning;
    const identityConflict = identity.identityMatch === 'mismatch';
    const allValid = cookieUsable && tokenStatus.valid && !identityConflict;
    const partialValid = cookieStatus.valid || tokenStatus.valid;
    const warning = !!cookieStatus.warning || identityConflict;
    const warningMessage = [cookieStatus.warningMessage, identityConflict ? identity.identityMessage : '']
      .filter(Boolean).join('；');

    if (identityConflict) {
      logger.log('🔴', `账号 [${name}] Cookie 与 OAuth Token 身份不一致，已阻止判定为完全有效`);
    } else if (allValid) {
      logger.log('🟢', `账号 [${name}] 登录检测完全通过！网页端与移动端均在线，当前总积分: ${balance}`);
    } else if (cookieStatus.valid && cookieStatus.warning) {
      logger.log('🟡', `账号 [${name}] 网页端 Cookie 异常：${cookieStatus.warningMessage}`);
    } else if (partialValid) {
      logger.log('🟡', `账号 [${name}] 部分登录有效：网页端(${cookieStatus.valid ? '正常' : '未就绪'}) / 移动端(${tokenStatus.valid ? '正常' : '未就绪'})`);
    } else {
      logger.log('🔴', `账号 [${name}] 尚未登录或凭证已失效`);
    }

    logger.setAccountContext(prevCtx);

    return {
      accountId: acc?.id || 'acc_1',
      accountName: name,
      cookie: cookieStatus,
      code: codeStatus,
      token: tokenStatus,
      balance,
      allValid,
      overallValid: partialValid,
      warning,
      warningMessage,
      ...identity
    };
  }
}

export const authManager = new AuthManager();
export default authManager;

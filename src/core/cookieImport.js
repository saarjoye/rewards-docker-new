/**
 * Cookie 输入解析：同时支持
 *   1) 传统的 Header String（从 cn.bing.com 复制，单域，只有 name=value）
 *   2) 浏览器扩展导出的 JSON 数组（含 domain / path / secure / httpOnly / sameSite / expirationDate）
 *
 * 为什么需要 JSON：rewards.bing.com 新版走 OAuth（login.live.com -> /auth/callback），
 * 需要 .live.com 的 MSPAuth/WLSSC、rewards.bing.com 的 rn_S/rn_SID、login.live.com 的
 * __Host-MSAAUTHP 等跨域会话 Cookie。Header String 只有 bing.com 域，必然被重定向到登录页。
 *
 * 纯函数，便于单测。
 */

const DROP_COOKIE_NAMES = new Set(['_EDGE_S']);

function normalizeSameSite(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).toLowerCase();
  if (text === 'strict') return 'Strict';
  if (text === 'lax') return 'Lax';
  if (text === 'none' || text === 'no_restriction') return 'None';
  return undefined;
}

/** 解析 Header String（name=value; name2=value2），默认域 .bing.com */
export function parseHeaderString(raw, defaultDomain = '.bing.com') {
  const cookies = [];
  if (!raw || typeof raw !== 'string') return cookies;
  for (const part of raw.split(/[;\r\n]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!name || DROP_COOKIE_NAMES.has(name)) continue;
    const cookie = {
      name,
      value,
      domain: defaultDomain,
      path: '/',
      secure: true,
      sameSite: 'Lax',
      expires: -1
    };
    if (name.startsWith('__Host-')) {
      cookie.domain = undefined;
      cookie.url = 'https://cn.bing.com/';
    }
    cookies.push(cookie);
  }
  return cookies;
}

/** 解析浏览器扩展导出的 JSON 数组 */
export function parseCookieJson(raw) {
  let list;
  try {
    list = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;

  const cookies = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name ?? '').trim();
    const value = String(item.value ?? '');
    if (!name || DROP_COOKIE_NAMES.has(name)) continue;
    if (/[\u0000-\u001f\u007f]/.test(value)) continue;

    const rawDomain = String(item.domain ?? '').trim();
    const domain = rawDomain || undefined;
    const cookie = {
      name,
      value,
      path: String(item.path || '/'),
      secure: item.secure !== false,
      httpOnly: item.httpOnly === true
    };
    const sameSite = normalizeSameSite(item.sameSite);
    if (sameSite) cookie.sameSite = sameSite;

    if (name.startsWith('__Host-') || !domain) {
      // __Host- 不允许 domain；退化为 url 形式
      const host = item.host || item.url || domain || 'cn.bing.com';
      const hostText = host.startsWith('http') ? host : `https://${String(host).replace(/^\./, '')}/`;
      cookie.url = hostText.endsWith('/') ? hostText : hostText + '/';
      delete cookie.path;
    } else {
      cookie.domain = domain;
    }

    const expiresRaw = item.expirationDate ?? item.expires;
    cookie.expires = Number.isFinite(Number(expiresRaw)) ? Number(expiresRaw) : -1;
    if (cookie.expires === 0) cookie.expires = -1;

    cookies.push(cookie);
  }
  return cookies;
}

/**
 * 统一入口：自动识别 JSON / Header String。
 * 返回 { format, cookies, domains }；无法解析返回 null。
 */
export function parseCookieInput(raw, defaultDomain = '.bing.com') {
  if (!raw) return null;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed.startsWith('[')) {
    const cookies = parseCookieJson(trimmed);
    if (cookies) {
      return {
        format: 'json',
        cookies,
        domains: [...new Set(cookies.map(c => c.domain).filter(Boolean))].sort()
      };
    }
  }
  const cookies = parseHeaderString(raw, defaultDomain);
  if (cookies.length === 0) return null;
  return {
    format: 'header',
    cookies,
    domains: [...new Set(cookies.map(c => c.domain || 'url-form').filter(Boolean))].sort()
  };
}

/**
 * 为指定 URL 生成 Cookie 请求头（只包含匹配该域名的 Cookie）。
 * 用于 HTTP 直连路径。
 */
export function cookieHeaderFor(parsed, url) {
  if (!parsed || !Array.isArray(parsed.cookies)) return '';
  let hostname = '';
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
  const matched = parsed.cookies.filter((c) => {
    if (c.url) {
      try {
        return new URL(c.url).hostname.toLowerCase() === hostname;
      } catch {
        return false;
      }
    }
    if (!c.domain) return false;
    const domain = c.domain.replace(/^\./, '').toLowerCase();
    return hostname === domain || hostname.endsWith(`.${domain}`);
  });
  return matched.map(c => `${c.name}=${c.value}`).join('; ');
}

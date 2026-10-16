import configManager from '../config.js';
import networkClient from '../network.js';
import logger from '../logger.js';

const WEWORK_APP_DEFAULT_BASE_URL = 'https://qyapi.weixin.qq.com';
const WEWORK_APP_SECRET_PLACEHOLDER = '__MSR_SECRET_KEEP__';
const WEWORK_APP_TOKEN_REFRESH_AHEAD_MS = 5 * 60 * 1000;
const WEWORK_APP_TOKEN_ERROR_CODES = new Set([40014, 42001, 42007, 42009]);

/**
 * 规整企业微信应用 API 根地址：只允许 HTTPS，禁止携带账号密码、查询参数与片段，
 * 允许配置反向代理路径前缀，例如 https://example.com/qyapi
 */
export function buildWeWorkAppBaseUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return WEWORK_APP_DEFAULT_BASE_URL;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('企业微信应用 Base URL 无效');
  }
  if (url.protocol !== 'https:') throw new Error('企业微信应用 Base URL 必须使用 HTTPS');
  if (url.username || url.password) throw new Error('企业微信应用 Base URL 不能包含账号密码');
  if (url.search || url.hash) throw new Error('企业微信应用 Base URL 不能包含查询参数或片段');
  const prefix = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${prefix}`;
}

export function buildWeWorkAppTokenUrl(baseUrl, corpId, secret) {
  const base = buildWeWorkAppBaseUrl(baseUrl);
  const id = encodeURIComponent(String(corpId || '').trim());
  const key = encodeURIComponent(String(secret || '').trim());
  return `${base}/cgi-bin/gettoken?corpid=${id}&corpsecret=${key}`;
}

export function buildWeWorkAppSendUrl(baseUrl, accessToken) {
  const base = buildWeWorkAppBaseUrl(baseUrl);
  return `${base}/cgi-bin/message/send?access_token=${encodeURIComponent(String(accessToken || '').trim())}`;
}

export function computeWeWorkAppBackoffMs(attempt) {
  const safeAttempt = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(16000, Math.round(1000 * Math.pow(2, safeAttempt)));
}

function parseWeWorkAppResponse(payload) {
  if (payload && typeof payload === 'object') return payload;
  const text = String(payload || '').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { errcode: -1, errmsg: text.slice(0, 200) };
  }
}

function normalizeWeWorkAppConfig(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const maxRetries = Number(raw.maxRetries);
  return {
    enabled: raw.enabled !== false,
    baseUrl: String(raw.baseUrl || '').trim(),
    corpId: String(raw.corpId || '').trim(),
    agentId: String(raw.agentId || '').trim(),
    secret: String(raw.secret || '').trim(),
    toUser: String(raw.toUser || '@all').trim() || '@all',
    maxRetries: Number.isFinite(maxRetries) ? Math.max(0, Math.min(10, Math.floor(maxRetries))) : 5
  };
}

function assertWeWorkAppConfig(cfg) {
  if (!cfg.corpId) throw new Error('企业微信应用 CorpID 未配置');
  if (!cfg.agentId) throw new Error('企业微信应用 AgentId 未配置');
  if (!/^\d+$/.test(cfg.agentId)) throw new Error('企业微信应用 AgentId 必须为数字');
  if (!cfg.secret) throw new Error('企业微信应用 Secret 未配置');
  buildWeWorkAppBaseUrl(cfg.baseUrl);
}

export class Notifier {
  constructor() {
    this.weworkAppTokenCache = new Map();
  }

  // 便于测试替换的等待函数
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getWeWorkAppTokenCacheKey(cfg) {
    return `${buildWeWorkAppBaseUrl(cfg.baseUrl)}|${cfg.corpId}|${cfg.secret}`;
  }

  async getWeWorkAppAccessToken(cfg, forceRefresh = false) {
    const key = this.getWeWorkAppTokenCacheKey(cfg);
    const now = Date.now();
    if (!forceRefresh) {
      const cached = this.weworkAppTokenCache.get(key);
      if (cached && cached.expiresAt > now + WEWORK_APP_TOKEN_REFRESH_AHEAD_MS) {
        return cached.token;
      }
    }
    const response = parseWeWorkAppResponse(await networkClient.request({
      url: buildWeWorkAppTokenUrl(cfg.baseUrl, cfg.corpId, cfg.secret),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: {}
    }));
    if (!response || Number(response.errcode) !== 0 || !response.access_token) {
      throw new Error(`企业微信应用获取 token 失败: ${response?.errmsg || '未知错误'}`);
    }
    const expiresIn = Math.max(60, Number(response.expires_in) || 7200);
    this.weworkAppTokenCache.set(key, {
      token: response.access_token,
      expiresAt: now + expiresIn * 1000
    });
    return response.access_token;
  }

  invalidateWeWorkAppAccessToken(cfg) {
    try {
      this.weworkAppTokenCache.delete(this.getWeWorkAppTokenCacheKey(cfg));
    } catch {}
  }

  async postWeWorkAppMessage(cfg, token, text) {
    const response = parseWeWorkAppResponse(await networkClient.request({
      url: buildWeWorkAppSendUrl(cfg.baseUrl, token),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: {
        touser: cfg.toUser,
        msgtype: 'text',
        agentid: Number(cfg.agentId),
        text: { content: text },
        safe: 0
      }
    }));
    return response;
  }

  async sendWeWorkApp(value, text) {
    const cfg = normalizeWeWorkAppConfig(value);
    assertWeWorkAppConfig(cfg);
    const maxAttempts = cfg.maxRetries + 1;
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const token = await this.getWeWorkAppAccessToken(cfg, attempt > 0);
        let response = await this.postWeWorkAppMessage(cfg, token, text);

        // access_token 失效/过期时：清缓存、强制刷新后再发一次
        if (WEWORK_APP_TOKEN_ERROR_CODES.has(Number(response?.errcode))) {
          this.invalidateWeWorkAppAccessToken(cfg);
          const freshToken = await this.getWeWorkAppAccessToken(cfg, true);
          response = await this.postWeWorkAppMessage(cfg, freshToken, text);
        }

        if (Number(response?.errcode) === 0) {
          logger.log('🔵', '「企业微信应用」消息推送成功');
          return true;
        }
        const message = response?.errmsg || `errcode=${response?.errcode}`;
        throw new Error(`企业微信应用推送失败: ${message}`);
      } catch (e) {
        lastError = e;
        if (attempt < maxAttempts - 1) {
          const waitMs = computeWeWorkAppBackoffMs(attempt);
          logger.log('🟡', `「企业微信应用」推送失败，${Math.round(waitMs / 1000)} 秒后重试: ${e.message}`);
          await this.sleep(waitMs);
        }
      }
    }

    logger.log('🔴', `「企业微信应用」推送失败: ${lastError?.message || '未知错误'}`);
    throw lastError || new Error('企业微信应用推送失败');
  }

  async send(title, content) {
    const cfg = configManager.get();
    const notify = cfg.notify || {};
    const timeStr = new Date().toLocaleString('zh-CN', { hour12: false });
    const fullContent = `【${title}】\n时间: ${timeStr}\n\n${content}`;

    const tasks = [];

    // 1. 企业微信群机器人 Webhook
    if (notify.wework) {
      tasks.push(this.sendWeWork(notify.wework.trim(), fullContent));
    }

    // 1.5 企业微信应用消息
    if (notify.weworkApp?.enabled && notify.weworkApp?.corpId && notify.weworkApp?.agentId && notify.weworkApp?.secret) {
      tasks.push(this.sendWeWorkApp(notify.weworkApp, fullContent));
    }

    // 2. 钉钉
    if (notify.dingding) {
      tasks.push(this.sendDingTalk(notify.dingding.trim(), title, fullContent));
    }

    // 3. 飞书
    if (notify.feishu) {
      tasks.push(this.sendFeishu(notify.feishu.trim(), title, fullContent));
    }

    // 4. Bark
    if (notify.bark) {
      tasks.push(this.sendBark(notify.bark.trim(), title, content));
    }

    // 5. PushMe
    if (notify.pushme) {
      tasks.push(this.sendPushMe(notify.pushme.trim(), title, content));
    }

    // 6. Telegram
    if (notify.telegram?.botToken && notify.telegram?.chatId) {
      tasks.push(this.sendTelegram(
        notify.telegram.botToken.trim(),
        notify.telegram.chatId.trim(),
        title,
        fullContent
      ));
    }

    if (tasks.length > 0) {
      const results = await Promise.allSettled(tasks);
      return results;
    }
  }

  async sendWeWork(key, text) {
    const url = key.startsWith('http') ? key : `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${key}`;
    try {
      await networkClient.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {
          msgtype: 'text',
          text: { content: text }
        }
      });
      logger.log('🔵', '「企业微信」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「企业微信」推送失败: ${e.message}`);
      throw e;
    }
  }

  async sendDingTalk(token, title, text) {
    const url = token.startsWith('http') ? token : `https://oapi.dingtalk.com/robot/send?access_token=${token}`;
    try {
      await networkClient.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {
          msgtype: 'markdown',
          markdown: {
            title: `# ${title}`,
            text: text
          }
        }
      });
      logger.log('🔵', '「钉钉」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「钉钉」推送失败: ${e.message}`);
      throw e;
    }
  }

  async sendFeishu(urlOrKey, title, text) {
    const url = urlOrKey.startsWith('http') ? urlOrKey : `https://open.feishu.cn/open-apis/bot/v2/hook/${urlOrKey}`;
    try {
      await networkClient.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {
          msg_type: 'interactive',
          card: {
            schema: '2.0',
            header: {
              title: { tag: 'plain_text', content: title },
              template: 'blue'
            },
            body: {
              elements: [{ tag: 'markdown', content: text }]
            }
          }
        }
      });
      logger.log('🔵', '「飞书」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「飞书」推送失败: ${e.message}`);
      throw e;
    }
  }

  async sendBark(keyOrUrl, title, text) {
    const base = keyOrUrl.startsWith('http') ? keyOrUrl.replace(/\/$/, '') : `https://api.day.app/${keyOrUrl}`;
    const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(text)}?group=rewards&icon=https://rewards.bing.com/rewards.png`;
    try {
      await networkClient.request({ url, method: 'GET' });
      logger.log('🔵', '「Bark」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「Bark」推送失败: ${e.message}`);
      throw e;
    }
  }

  async sendPushMe(key, title, text) {
    const url = `https://push.i-i.me/?push_key=${encodeURIComponent(key)}`;
    try {
      await networkClient.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {
          title: `Microsoft Rewards - ${title}`,
          content: text,
          type: 'markdown'
        }
      });
      logger.log('🔵', '「PushMe」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「PushMe」推送失败: ${e.message}`);
      throw e;
    }
  }

  async sendTelegram(botToken, chatId, title, text) {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    // Telegram 基础 Markdown 模式下，未配对的下划线 _ 会导致 400 实体解析异常
    const safeTitle = String(title || '').replace(/(?<!\\)_/g, '\\_');
    const safeText = String(text || '').replace(/(?<!\\)_/g, '\\_');
    const message = `*${safeTitle}*\n\n${safeText}`;
    try {
      await networkClient.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {
          chat_id: chatId,
          text: message,
          parse_mode: 'Markdown'
        }
      });
      logger.log('🔵', '「Telegram」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「Telegram」推送失败: ${e.message}`);
      throw e;
    }
  }

  async testChannel(channel, value) {
    const title = '测试通知';
    const content = '如果你看到这条消息，说明该推送渠道已成功配置并联通！';
    switch (channel) {
      case 'weworkApp': {
        const parsed = typeof value === 'string' ? JSON.parse(value) : (value || {});
        const saved = configManager.get().notify?.weworkApp || {};
        const secret = parsed.secret && parsed.secret !== WEWORK_APP_SECRET_PLACEHOLDER
          ? parsed.secret
          : saved.secret;
        return this.sendWeWorkApp({
          ...saved,
          ...parsed,
          secret,
          enabled: true
        }, `【${title}】\n${content}`);
      }
      case 'wework':
        return this.sendWeWork(value, `【${title}】\n${content}`);
      case 'dingding':
        return this.sendDingTalk(value, title, `### ${title}\n${content}`);
      case 'feishu':
        return this.sendFeishu(value, title, content);
      case 'bark':
        return this.sendBark(value, title, content);
      case 'pushme':
        return this.sendPushMe(value, title, content);
      case 'telegram': {
        const { botToken, chatId } = typeof value === 'object' ? value : JSON.parse(value);
        return this.sendTelegram(botToken, chatId, title, content);
      }
      default:
        throw new Error('不支持的通知渠道');
    }
  }
}

export const notifier = new Notifier();
export default notifier;
import crypto from 'crypto';
import configManager from '../config.js';
import networkClient from '../network.js';
import logger from '../logger.js';
import authManager from './auth.js';
import { concatFlightChunks, extractOfferObjects, extractJsonArray, normalizeFlightFragment } from './flightParse.js';
import {
  PC_USER_AGENT,
  MOBILE_USER_AGENT,
  APP_USER_AGENT,
  DESKTOP_APP_USER_AGENT,
  pcPageHeaders,
  pcXhrHeaders
} from './fingerprint.js';

export const USER_AGENTS = {
  // 统一来自 fingerprint.js，避免各处硬编码版本号漂移（历史上就出现过前后不一致）
  pc: PC_USER_AGENT,
  mobile: MOBILE_USER_AGENT,
  app: APP_USER_AGENT
};

export const DESKTOP_APP_HEADERS = {
  'user-agent': DESKTOP_APP_USER_AGENT,
  'X-MSRewards-App': '1',
  'X-Rewards-Source': 'msrewards-desktop'
};

export const APP_CONFIG = {
  rewardsAppId: 'SAAndroid/32.6.2110003560',
  channel: 'SAAndroid',
  offerIds: {
    dailyCheckIn: 'Gamification_Sapphire_DailyCheckIn',
    readArticle: 'ENUS_readarticle3_30points'
  }
};

export const SEARCH_POOL = [
  "what is the weather forecast tomorrow",
  "how do I make sourdough bread at home",
  "where can I find cheap flights to tokyo",
  "why is the sky blue scientific explanation",
  "how to learn rust programming in 2026",
  "what time does the world cup final start",
  "how to fix a leaky kitchen faucet step by step",
  "what are the best vr games of 2026",
  "how to start a vegetable garden in spring",
  "where to watch new movies this week",
  "how to take care of a bonsai tree",
  "what is the difference between python async and threading",
  "how to meditate properly for beginners",
  "what is the origin of halloween traditions",
  "how do solar panels actually work",
  "what is the best mechanical keyboard for typing",
  "how to tie a windsor knot tie",
  "what causes northern lights aurora borealis",
  "how to brew the perfect espresso at home",
  "what are the symptoms of vitamin d deficiency",
  "how to sleep better naturally tonight",
  "why do cats purr when they are happy",
  "best coffee shops in san francisco downtown",
  "italian restaurants near times square",
  "tokyo cherry blossom season 2026 forecast",
  "rtx 5070 ti benchmark vs rtx 4080 super",
  "iphone 17 release date and features",
  "tesla stock price today nasdaq",
  "best noise cancelling headphones under 300",
  "fastest electric cars 0 to 60 mph",
  "vintage camera brands collectors guide",
  "budget gaming laptop with rtx 4070 2026",
  "easy chocolate chip cookies recipe from scratch",
  "30 minute home workout routine no equipment",
  "stretching exercises for lower back pain relief",
  "easy origami crane folding instructions",
  "git rebase vs merge which one to use",
  "markdown cheat sheet with examples",
  "japanese hiragana chart pronunciation",
  "ancient rome history quick overview",
  "pomodoro technique for focus and productivity",
  "healthy breakfast ideas under 10 minutes",
  "天气预报", "今日新闻热点", "美食食谱家常菜", "旅游攻略", "健康养生知识",
  "科技资讯", "电影推荐", "股票行情", "体育赛事", "历史上的今天"
];

const SKIP_PATTERNS = [
  "referral", "refer and earn", "sweepstake", "entries",
  "install the", "set bing as your default", "bing wallpaper",
  "punch card", "ancient coin", "sea of thieves", "rewards extension",
  "redemption goal", "order history", "claim your gift", "shop to earn",
  "set goal", "Available tomorrow", "Offer is Locked", "Earn -1 points"
];

export class RewardsApi {
  constructor() {
    this.region = 'CN';
    this.host = 'www.bing.com';
    this.cachedNextAction = '707e6eb15bdfdd5fba193f0a77e934f7018faf87ce';
    this.hotWordIndex = 0;
    this.hotWordList = [];
    this.restrictedTimes = 0;
    this.lastSearchProgress = -1;
  }

  randomRange(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min);
  }

  delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  randomDelay(min = 3000, max = 8000) {
    return this.delay(this.randomRange(min, max));
  }

  getRandomUUID() {
    return crypto.randomUUID().replace(/-/g, '').toUpperCase();
  }

  // DAPI 的 activity.id 官方客户端是 56 位十六进制（两段 UUID 拼接）。
  // 只给 32 位时接口虽然返回 200，但部分任务（尤其连签类）不会真正入账。
  getDapiId() {
    return (this.getRandomUUID() + this.getRandomUUID()).slice(0, 56);
  }

  isJSON(str) {
    if (!str || typeof str !== 'string') return false;
    try {
      const j = JSON.parse(str);
      return Array.isArray(j) || (typeof j === 'object' && j !== null);
    } catch {
      return false;
    }
  }

  /**
   * 从渲染后的 HTML 里，按「标签文本 → 最近的 text-pageHeader 数值」取值。
   *
   * 实测官网三个关键卡片都是这个结构（浏览器渲染后的明文 DOM）：
   *   <p class="text-labelControl">今日积分</p> ... <p class="text-pageHeader">145</p>
   *   <p class="text-labelControl">每日连续打卡</p> ... <p class="text-pageHeader">123</p>
   *   <p class="text-labelControl">可领取</p> ... <p class="text-pageHeader">3</p>
   *
   * 返回首个匹配到的数字；找不到返回 null。
   */
  parseLabeledHeaderValue(html, label, options = {}) {
    if (!html || !label) return null;
    const source = String(html);
    const maxSpan = options.maxSpan || 1500;
    let from = 0;
    while (true) {
      const idx = source.indexOf(label, from);
      if (idx === -1) return null;
      const segment = source.slice(idx, idx + maxSpan);
      const m = segment.match(/text-pageHeader[^>]*>\s*\+?(\d[\d,]*)/);
      if (m) {
        const n = parseInt(m[1].replace(/,/g, ''), 10);
        return Number.isFinite(n) ? n : null;
      }
      from = idx + label.length;
    }
  }

  /**
   * 从 earn 与 dashboard 页面精准提取各 partner（bing / dailyset / bingapp）的连签模型。
   * 通过括号平衡解析独立的 streak JSON 对象，彻底避免旧版窗口正则向前越界抓到其他 partner（如 edge 的 0/7）。
   */
  extractStreakModels(...texts) {
    const result = {};
    const parseOne = (text) => {
      if (!text) return;
      const marker = '"model":{"streak":{';
      let pos = 0;
      let foundAny = false;
      while (true) {
        const idx = text.indexOf(marker, pos);
        if (idx === -1) break;
        const start = idx + marker.length - 1;
        let depth = 0;
        let end = -1;
        for (let i = start; i < text.length && i < start + 3000; i++) {
          if (text[i] === '{') depth++;
          else if (text[i] === '}') {
            depth--;
            if (depth === 0) { end = i + 1; break; }
          }
        }
        if (end !== -1) {
          const raw = text.slice(start, end).replace(/:\$undefined/g, ':null').replace(/:\$D[^",}]+/g, ':null');
          try {
            const obj = JSON.parse(raw);
            if (obj.partner) {
              result[obj.partner] = {
                completedDays: Number(obj.completedDays ?? 0),
                currentDay: Number(obj.currentDay ?? 0),
                activitiesCompleted: Number(obj.activitiesCompleted ?? 0),
                activitiesTotal: Number(obj.activitiesTotal ?? 0),
                isCurrentDayCompleted: !!obj.isCurrentDayCompleted
              };
              foundAny = true;
            }
          } catch {
            const mPartner = raw.match(/"partner":"([^"]+)"/);
            if (mPartner) {
              const p = mPartner[1];
              const pick = (re) => { const m = raw.match(re); return m ? Number(m[1]) : 0; };
              result[p] = {
                completedDays: pick(/"completedDays":(\d+)/),
                currentDay: pick(/"currentDay":(\d+)/),
                activitiesCompleted: pick(/"activitiesCompleted":(\d+)/),
                activitiesTotal: pick(/"activitiesTotal":(\d+)/),
                isCurrentDayCompleted: /"isCurrentDayCompleted":true/.test(raw)
              };
              foundAny = true;
            }
          }
        }
        pos = (end !== -1) ? end : (idx + marker.length);
      }

      // 兜底（用于单测小片段）
      if (!foundAny) {
        for (const partner of ['bing', 'dailyset', 'bingapp']) {
          if (result[partner]) continue;
          const pKey = `"partner":"${partner}"`;
          const idx = text.indexOf(pKey);
          if (idx !== -1) {
            const forward = text.slice(idx, idx + 500);
            const backward = text.slice(Math.max(0, idx - 400), idx + 200);
            const win = forward.includes('completedDays') ? forward : backward;
            const pick = (re) => { const m = win.match(re); return m ? Number(m[1]) : 0; };
            result[partner] = {
              completedDays: pick(/"completedDays":(\d+)/),
              currentDay: pick(/"currentDay":(\d+)/),
              activitiesCompleted: pick(/"activitiesCompleted":(\d+)/),
              activitiesTotal: pick(/"activitiesTotal":(\d+)/),
              isCurrentDayCompleted: /"isCurrentDayCompleted":true/.test(win)
            };
          }
        }
        const mApp = text.match(/必应应用连续打卡[\s\S]{0,500}?签到:\s*(\d+)\s*\/\s*(\d+)/i)
          || text.match(/移动应用[\s\S]{0,500}?签到:\s*(\d+)\s*\/\s*(\d+)/i);
        if (mApp && !result['bingapp']) {
          const done = parseInt(mApp[1], 10);
          const total = parseInt(mApp[2], 10);
          const mDays = text.match(/已完成连续打卡\s*(\d+)\s*天/);
          result['bingapp'] = {
            completedDays: mDays ? parseInt(mDays[1], 10) : done,
            currentDay: done,
            activitiesCompleted: done,
            activitiesTotal: total,
            isCurrentDayCompleted: done >= total
          };
        }
      }
    };

    for (const t of texts) parseOne(t);
    return result;
  }

  setCurrentAccount(acc) {
    this.currentAccountId = acc?.id || 'acc_1';
    // 指定了账号就一定显式设定 Cookie 上下文：
    //   - 有 Cookie → 用该账号自己的；
    //   - 该账号没有 Cookie（字段缺失或空串）→ 传空串，让请求「不带 Cookie」，
    //     绝不能传 null，否则 networkClient 会回退到 accounts[0] 的 Cookie，
    //     把副账号的操作算到主账号头上。
    // 只有完全没指定账号（acc 为空）时才用 null，保留「走默认账号」的旧语义。
    networkClient.setActiveCookie(acc ? (acc.cookie || '') : null);
    // 同步日志归属上下文：该账号下所有未显式传账号名的日志都会自动带上账号名
    logger.setAccountContext(acc?.name || this.currentAccountId);
  }

  /**
   * 快照当前账号上下文（Cookie / 账号 ID / 日志前缀）。
   * 任何会临时切换账号的函数都应在 finally 里 restore，避免污染正在执行的任务。
   */
  snapshotAccountContext() {
    return {
      accountId: this.currentAccountId,
      cookie: networkClient.getActiveCookie(),
      logContext: logger.getAccountContext()
    };
  }

  restoreAccountContext(snapshot) {
    if (!snapshot) return;
    this.currentAccountId = snapshot.accountId;
    networkClient.setActiveCookie(snapshot.cookie);
    logger.setAccountContext(snapshot.logContext || '');
  }

  async withTokenRetry(requestFn) {
    let token = authManager.getAccessToken(this.currentAccountId);
    if (!token) {
      await authManager.refreshToken(false, this.currentAccountId);
      token = authManager.getAccessToken(this.currentAccountId);
    }
    if (!token) return null;

    try {
      return await requestFn(token);
    } catch (e) {
      if (e.message && e.message.includes('401')) {
        logger.log('🟡', 'Token 可能已过期，尝试重新刷新续期...');
        const ok = await authManager.refreshToken(true, this.currentAccountId);
        if (!ok) return null;
        token = authManager.getAccessToken(this.currentAccountId);
        return await requestFn(token);
      }
      throw e;
    }
  }

  /**
   * 地区与 IP 检测
   */
  async checkRegion(retryCount = 0) {
    const cfg = configManager.get();
    if (!cfg.network?.lockRegion) return true;

    try {
      const html = await networkClient.request({
        url: `https://${this.host}/`,
        headers: pcPageHeaders()
      });

      if (!html) {
        if (retryCount < 2) {
          logger.log('🟡', `地区检测无返回，重试中 (${retryCount + 1}/2)...`);
          await this.randomDelay(3000, 6000);
          return await this.checkRegion(retryCount + 1);
        }
        return false;
      }

      const match = String(html).replace(/\s/g, '').match(/Region:"(.*?)"(.*?)RevIpCC:"(.*?)"/);
      if (match) {
        this.region = match[3].toUpperCase();
        if (this.region !== 'CN') {
          const ipInfo = await this.getIPInfo();
          logger.log('🔴', `检测到当前出口 IP 位于非大陆地区 (${this.region})，为了避免被微软风控，自动化已停止！${ipInfo}`);
          return false;
        }
        logger.log('🟢', `地区检测通过: ${this.region}（中国大陆）`);
        return true;
      }

      if (retryCount < 2) {
        await this.randomDelay(3000, 6000);
        return await this.checkRegion(retryCount + 1);
      }
      return false;
    } catch (e) {
      if (retryCount < 2) {
        await this.randomDelay(3000, 6000);
        return await this.checkRegion(retryCount + 1);
      }
      logger.log('🔴', `地区检测异常: ${e.message}`);
      return false;
    }
  }

  async getIPInfo() {
    try {
      const res = await networkClient.request({
        url: 'https://disp-qryapi.3g.qq.com/v1/dispatch',
        headers: { 'referer': 'https://3g.qq.com/' }
      });
      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      if (data && data.code === 0) {
        const ip = data.extra?.ip || '';
        const rawInfo = (data.ipInfo || '').replace(/[#*]+/g, ' ').trim();
        return ` 出口IP: ${ip} 所在地: ${rawInfo}`;
      }
    } catch {}
    return '';
  }

  /**
   * 获取当前总积分余额
   */
  async getBalance() {
    try {
      const res = await this.withTokenRetry(token => networkClient.request({
        url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=105',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'user-agent': USER_AGENTS.app,
          'authorization': `Bearer ${token}`,
          'x-rewards-appid': APP_CONFIG.rewardsAppId,
          'x-rewards-ismobile': 'true',
          'x-rewards-country': 'cn',
          'x-rewards-language': 'zh'
        }
      }));
      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      const bal = data?.response?.balance;
      if (bal !== undefined && bal !== null && bal !== '') {
        return Number(bal);
      }
    } catch {}

    try {
      const res2 = await networkClient.request({
        url: `https://rewards.bing.com/api/getuserinfo?type=1&X-Requested-With=XMLHttpRequest&_=${Date.now()}`,
        headers: {
          ...pcXhrHeaders(),
          'referer': 'https://rewards.bing.com/',
          'x-requested-with': 'XMLHttpRequest'
        }
      });
      const data2 = typeof res2 === 'string' && this.isJSON(res2) ? JSON.parse(res2) : res2;
      const fallbackBal = data2?.dashboard?.availablePoints ?? data2?.dashboard?.userStatus?.availablePoints ?? data2?.balance;
      if (fallbackBal !== undefined && fallbackBal !== null && fallbackBal !== '') {
        return Number(fallbackBal);
      }
    } catch {}
    // 取不到余额时返回 null，避免调用方把网络失败误当成「余额归零」写库
    return null;
  }

  /**
   * 解析 cn.bing.com 飞出面板返回的官方积分数据。
   * 该接口的 Content-Type 有时错误地标成 text/html，但响应体实际是 JSON；
   * 因此这里只按响应内容解析，不依赖 Content-Type。
   */
  parseFlyoutRewardsInfo(raw) {
    let data = raw;
    if (typeof raw === 'string') {
      const text = raw.trim();
      if (!text) return null;
      try {
        data = JSON.parse(text);
      } catch {
        return null;
      }
    }
    if (!data || typeof data !== 'object') return null;

    const pick = value => Array.isArray(value) ? value[0] : value;
    const toNumber = value => {
      if (value === null || value === undefined || value === '') return null;
      const n = Number(String(value).replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    };

    const counters = data?.flyoutResult?.userStatus?.counters || {};
    const daily = pick(counters.DailyPoint ?? counters.dailyPoint);
    const pc = pick(counters.PCSearch ?? counters.pcSearch);
    const mobile = pick(counters.MobileSearch ?? counters.mobileSearch);

    const todayPoints = toNumber(daily?.pointProgress ?? daily?.progress ?? daily?.point_progress);
    const balance = toNumber(
      data?.userInfo?.balance
      ?? data?.flyoutResult?.userStatus?.availablePoints
      ?? data?.flyoutResult?.userStatus?.totalBalance
    );
    const pcProgress = toNumber(pc?.pointProgress ?? pc?.progress);
    const pcMax = toNumber(pc?.pointProgressMax ?? pc?.max);
    const mobileProgress = toNumber(mobile?.pointProgress ?? mobile?.progress);
    const mobileMax = toNumber(mobile?.pointProgressMax ?? mobile?.max);

    return {
      todayPoints,
      balance,
      pc: (pcProgress !== null || pcMax !== null)
        ? { progress: pcProgress ?? 0, max: pcMax ?? 0 }
        : null,
      mobile: (mobileProgress !== null || mobileMax !== null)
        ? { progress: mobileProgress ?? 0, max: mobileMax ?? 0 }
        : null
    };
  }

  /**
   * 获取用户积分、各项任务配额与明细 (Dashboard Info)
   */
  /**
   * 抓取 /earn 页面 HTML：优先用真实 Chromium，失败再退回 HTTP。
   *
   * 实测：纯 HTTP 会被 307 重定向到 login.windows.net，只能拿到 ~34KB 的登录壳；
   * 真实浏览器无论带不带 Cookie 都返回 200 与完整页面（300KB+）。
   */
  async fetchEarnHtmlPreferBrowser() {
    // 单测/离线环境禁用浏览器路径，避免拉起真实 Chromium
    if (process.env.MSR_DISABLE_BROWSER_FETCH === '1') {
      const html = await networkClient.request({
        url: 'https://rewards.bing.com/earn',
        headers: pcPageHeaders()
      });
      return { html, source: 'http' };
    }
    try {
      const { default: browserManager } = await import('./browser.js');
      const acc = configManager.resolveAccount(this.currentAccountId);
      const html = await browserManager.fetchEarnPageHtml(acc);
      if (html && String(html).length > 100000) {
        return { html, source: 'browser' };
      }
    } catch (e) {
      logger.log('🟡', `浏览器抓取 /earn 失败，回退 HTTP: ${e.message}`);
    }
    const html = await networkClient.request({
      url: 'https://rewards.bing.com/earn',
      headers: pcPageHeaders()
    });
    return { html, source: 'http' };
  }

  async getRewardsInfo(maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const [html, dashHtml, flyoutRaw] = await Promise.all([
          this.fetchEarnHtmlPreferBrowser().then(r => r.html).catch(() => ''),
          networkClient.request({
            url: 'https://rewards.bing.com/dashboard',
            headers: pcPageHeaders()
          }).catch(() => ''),
          networkClient.request({
            url: `https://cn.bing.com/rewards/panelflyout/getuserinfo?channel=BingFlyout&partnerId=BingRewards&_=${Date.now()}`,
            headers: pcXhrHeaders({
              'referer': 'https://www.bing.com/',
              'sec-fetch-site': 'same-site'
            })
          }).catch(() => '')
        ]);
        const flyout = this.parseFlyoutRewardsInfo(flyoutRaw);
        const clean = String(html || '').replace(/\\"/g, '"');
        const cleanDash = String(dashHtml || '').replace(/\\"/g, '"');
        let balance = Number.isFinite(flyout?.balance) ? flyout.balance : 0;
        let pcMax = flyout?.pc?.max ?? 60, pcCur = flyout?.pc?.progress ?? 0;
        let mobMax = flyout?.mobile?.max ?? 0, mobCur = flyout?.mobile?.progress ?? 0;
        let dailyOffer = 0;
        let searchQuotaFound = !!flyout?.pc;

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
            pcCur = pts.pc?.progress ?? 0;
            mobMax = pts.mobile?.max ?? 0;
            mobCur = pts.mobile?.progress ?? 0;
            dailyOffer = pts.dailyOffer ?? 0;
            searchQuotaFound = true;
          } catch {}
        }

        if (!Number.isFinite(flyout?.balance)) {
          const balMatch = clean.match(/"balance":(\d+)/) || clean.match(/"availablePoints":(\d+)/);
          if (balMatch) {
            balance = parseInt(balMatch[1], 10);
          } else {
            const cookieStr = networkClient.getCookieString('https://rewards.bing.com');
            const mCookieBal = cookieStr.match(/rc=(\d+)/) || cookieStr.match(/rb=(\d+)/);
            if (mCookieBal) {
              balance = parseInt(mCookieBal[1], 10);
            }
          }
        }

        // 官方「今日积分」：以 rewards.bing.com/earn 页面顶部卡片为准 —— 这才是用户
        // 在官网上看到的数字。cn.bing.com panelflyout 的 DailyPoint 是另一个计数器，
        // 实测会出现「官网 145 / flyout 498」的口径差（498 恰好等于余额差），
        // 因此 flyout 只作为页面解析失败时的兜底，不能再盖过页面值。
        // 最优先：浏览器渲染后的 HTML（<p class="text-pageHeader">145</p>）
        let todayPoints = this.parseLabeledHeaderValue(clean, '今日积分');
        let todayPointsSource = todayPoints === null ? null : 'earn-page-dom';

        const normalizedEarn = normalizeFlightFragment(clean);

        // 策略 1：React Flight 里「今日积分」+ text-pageHeader 的固定搭配
        const headerMatch = normalizedEarn.match(/"children"\s*:\s*"今日积分"[\s\S]{0,2000}?"className"\s*:\s*"text-pageHeader"[\s\S]{0,200}?"children"\s*:\s*"?\+?([\d,]+)"?/)
          || normalizedEarn.match(/今日积分<\/[^>]+>[\s\S]{0,1200}?class="text-pageHeader"[^>]*>\+?([\d,]+)</);
        if (todayPoints === null && headerMatch) {
          const n = parseInt(headerMatch[1].replace(/,/g, ''), 10);
          if (Number.isFinite(n)) {
            todayPoints = n;
            todayPointsSource = 'earn-page-flight';
          }
        }

        // 策略 2（结构变化兜底）：在「今日积分」后 600 字符内：
        //   - 优先取带 + 号的数字（页面上「+145」这类明确增量标记）；
        //   - 否则只有在候选唯一时才采用，多个数字直接放弃（宁可回退 flyout，也不误取时间戳/ID）。
        if (todayPoints === null) {
          const windows = [];
          let idx = normalizedEarn.indexOf('今日积分');
          while (idx !== -1 && windows.length < 3) {
            windows.push(normalizedEarn.slice(idx, idx + 600));
            idx = normalizedEarn.indexOf('今日积分', idx + 4);
          }
          for (const win of windows) {
            const plus = win.match(/\+\s*([\d,]{1,7})/);
            if (plus) {
              const n = parseInt(plus[1].replace(/,/g, ''), 10);
              if (Number.isFinite(n)) { todayPoints = n; todayPointsSource = 'earn-page'; break; }
            }
            const all = [...win.matchAll(/(?:^|[^0-9])([\d,]{1,7})(?![0-9])/g)]
              .map(m => parseInt(String(m[1]).replace(/,/g, ''), 10))
              .filter(n => Number.isFinite(n) && n >= 0 && n <= 100000);
            if (all.length === 1) { todayPoints = all[0]; todayPointsSource = 'earn-page'; break; }
          }
        }

        if (todayPoints === null && Number.isFinite(flyout?.todayPoints)) {
          todayPoints = flyout.todayPoints;
          todayPointsSource = 'flyout';
        }
        if (todayPointsSource === 'earn-page'
          && Number.isFinite(flyout?.todayPoints)
          && flyout.todayPoints !== todayPoints) {
          logger.log('🟡', `今日积分口径不一致：官网页面 ${todayPoints} / flyout ${flyout.todayPoints}，已采用官网页面值`);
        }

        // 如果页面未取到有效余额，尝试通过移动端 DAPI 接口获取真实账户余额
        if (balance === 0) {
          try {
            const tokenBal = await this.getBalance();
            if (tokenBal > 0) balance = tokenBal;
          } catch {}
        }

        const todayDetails = [];
        const toNum = v => parseInt(String(v).replace(/,/g, ''), 10) || 0;
        const searchRowMatch = clean.match(/<p>\s*必应搜索\s*<\/p>\s*<\/div>\s*<div(?=[^>]*justify-self-end)[^>]*>([\s\S]{0,500}?)<\/div>/i);
        const searchHtmlMatch = searchRowMatch
          ? (searchRowMatch[1].match(/<span[^>]*>([\d,]+)<\/span>\s*<span[^>]*>\s*\/\s*([\d,]+)\s*<\/span>/i)
              || searchRowMatch[1].match(/([\d,]+)\s*\/\s*([\d,]+)/))
          : null;
        if (searchHtmlMatch) {
          pcCur = toNum(searchHtmlMatch[1]);
          pcMax = toNum(searchHtmlMatch[2]);
          searchQuotaFound = pcMax > 0;
          todayDetails.push({ title: '必应搜索', points: pcCur, max: pcMax });
        }

        const searchRscMatch = clean.match(/"combinedSearch":\{[^}]*"progress":(\d+)[^}]*"max":(\d+)/);
        if (searchRscMatch && !todayDetails.some(d => d.title === '必应搜索')) {
          pcCur = toNum(searchRscMatch[1]);
          pcMax = toNum(searchRscMatch[2]);
          searchQuotaFound = pcMax > 0;
          todayDetails.push({ title: '必应搜索', points: pcCur, max: pcMax });
        }

        // 飞出面板的计数器是实时值；页面数据能解析时才用它兜底。
        if (flyout?.pc) {
          pcCur = flyout.pc.progress;
          pcMax = flyout.pc.max;
          searchQuotaFound = pcMax > 0 || pcCur > 0;
          const row = todayDetails.find(d => d.title === '必应搜索');
          if (row) {
            row.points = pcCur;
            row.max = pcMax;
          } else {
            todayDetails.push({ title: '必应搜索', points: pcCur, max: pcMax });
          }
        }
        if (flyout?.mobile) {
          mobCur = flyout.mobile.progress;
          mobMax = flyout.mobile.max;
          searchQuotaFound = searchQuotaFound || mobMax > 0 || mobCur > 0;
        }

        let readProgress = 0, readMax = 30;
        try {
          const readInfo = await this.getReadProgress();
          if (readInfo) {
            readProgress = readInfo.progress;
            readMax = readInfo.max;
          }
        } catch {}

        // 动态解析官网「任务」区域全部打孔卡（自适应 1 个、2 个或多个）
        const quests = this.extractQuests(clean);
        const desktopApp = quests.find(q => q.title.includes('桌面') || q.title.includes('RewardsApp')) || {
          title: "桌面奖励应用每周专属任务",
          progress: 0,
          max: 8,
          expiresText: '',
          available: false
        };
        const monthlyQuest = quests.find(q => !q.title.includes('桌面') && !q.title.includes('RewardsApp')) || null;

        // 印章进度提取 (如 8/12)
        let stampsProgress = 0, stampsMax = 12;
        const stampMatch = clean.match(/"aria-label":"收集的印章"[^}]*?"aria-valuemax":(\d+)[^}]*?"aria-valuenow":(\d+)/)
          || clean.match(/aria-label="收集的印章"[^>]*?aria-valuemax="(\d+)"[^>]*?aria-valuenow="(\d+)"/);
        if (stampMatch) {
          stampsMax = parseInt(stampMatch[1], 10) || 12;
          stampsProgress = parseInt(stampMatch[2], 10) || 8;
        }

        // 平台待领取额外积分（"可领取"卡片）。
        // 同样要兼容 React Flight 把数字序列化为数值而非字符串的情况。
        let claimablePoints = this.parseLabeledHeaderValue(cleanDash, '可领取') ?? 0;
        const normalizedDash = normalizeFlightFragment(cleanDash);
        const claimMatch = normalizedDash.match(/"children"\s*:\s*"可领取"[\s\S]{0,1200}?"children"\s*:\s*"?\+?([\d,]+)"?/)
          || normalizedDash.match(/可领取<\/p>[\s\S]*?class="text-pageHeader"[^>]*>\+?([\d,]+)</)
          || normalizedDash.match(/alt="可领取"[^>]*>[\s\S]{0,300}?(\d[\d,]*)/);
        if (claimablePoints === 0 && claimMatch) {
          claimablePoints = parseInt(claimMatch[1].replace(/,/g, ''), 10) || 0;
        }

        // 连续打卡任务（必应搜索 / 每日活动 / 必应应用）的真实状态。
        // 精准提取独立 streak 对象，彻底杜绝向前切片窗口抓到 edge 导致 bingapp 被误判为 0/7 的 Bug。
        const streaks = this.extractStreakModels(clean, cleanDash);

        return {
          balance,
          todayPoints,
          todayPointsSource,
          claimablePoints,
          pc: searchQuotaFound ? { progress: pcCur, max: pcMax } : null,
          mobile: searchQuotaFound ? { progress: mobCur, max: mobMax } : null,
          readProgress,
          readMax,
          dailyOffer,
          todayDetails,
          desktopApp,
          monthlyQuest,
          quests,
          stamps: {
            progress: stampsProgress,
            max: stampsMax
          },
          streaks
        };
      } catch (e) {
        if (attempt < maxRetries) {
          await this.delay(3000);
          continue;
        }
        logger.log('🔴', `获取仪表盘信息失败: ${e.message}`);
        return null;
      }
    }
    return null;
  }

  /**
   * 从 Flight 数据流或 HTML 中动态提取全部「任务」区打孔卡
   */
  extractQuests(cleanText) {
    const quests = [];
    const seenTitles = new Set();

    const addQuest = (title, curP, maxP, chunk) => {
      if (!title || seenTitles.has(title) || title.includes('开始使用 Rewards')) return;
      seenTitles.add(title);
      let expText = '';
      const expM = chunk.match(/expiresAt[^0-9]{0,40}(\d{4}-\d{2}-\d{2}T[^\"]+)/);
      if (expM) {
        const d = new Date(expM[1]);
        if (!isNaN(d.getTime())) {
          const today = new Date(); today.setHours(0, 0, 0, 0);
          const exp = new Date(d); exp.setHours(0, 0, 0, 0);
          const days = Math.max(0, Math.round((exp.getTime() - today.getTime()) / 86400000));
          expText = `到期日期 ${days} 天后`;
        }
      } else {
        const mExpText = chunk.match(/到期日期[^<\"{\\\\]*?(\d+\s*(?:天|周|月)后)/);
        if (mExpText) expText = `到期日期 ${mExpText[1]}`;
      }

      const ptsM = chunk.match(/\[\"[\+\"]*\",\"?(\d+)\"?\]/) || chunk.match(/\+(\d+)/);
      const isDesktop = title.includes('桌面') || title.includes('RewardsApp');
      const pts = ptsM ? parseInt(ptsM[1], 10) : (isDesktop ? 20 : 50);

      let icon = '🎯';
      if (title.includes('Halloween') || title.includes('万圣节')) icon = '🎃';
      else if (isDesktop) icon = '🖥️';
      else if (title.includes('秋') || title.includes('亮点')) icon = '🍁';

      quests.push({
        title,
        progress: curP,
        max: maxP,
        points: pts,
        expiresText: expText,
        available: true,
        done: curP >= maxP,
        icon
      });
    };

    // 1. Flight stream 模式：标题 + 任务进度
    const flightRegex = /\"text-globalBody2Strong\",\"children\":\"([^\"]+)\"[\s\S]{0,1500}?\"children\":\"(\d+)\/(\d+)\s*个任务\"/g;
    let m;
    while ((m = flightRegex.exec(cleanText)) !== null) {
      addQuest(m[1], parseInt(m[2], 10), parseInt(m[3], 10), cleanText.slice(Math.max(0, m.index - 500), m.index + 1500));
    }

    // 2. HTML 标题标签备用模式 (h1 / h2 / h3)
    if (quests.length === 0) {
      const htmlRegex = /<h[1-3][^>]*>([^<]+)<\/h[1-3]>[\s\S]{0,1200}?(\d+)\/(\d+)\s*个任务/gi;
      while ((m = htmlRegex.exec(cleanText)) !== null) {
        addQuest(m[1].trim(), parseInt(m[2], 10), parseInt(m[3], 10), cleanText.slice(Math.max(0, m.index - 200), m.index + 1500));
      }
    }

    // 3. 兜底常见打孔卡关键词识别
    if (quests.length === 0 && cleanText.includes('十月必看五大亮点')) {
      addQuest('十月必看五大亮点：服饰、玩具、手机、超值优惠和AI设备', 1, 5, cleanText.slice(cleanText.indexOf('十月必看五大亮点') - 200, cleanText.indexOf('十月必看五大亮点') + 1500));
    }
    if (!quests.some(q => q.title.includes('Halloween')) && cleanText.includes('Halloween')) {
      const hIdx = cleanText.indexOf('Halloween');
      addQuest('A 50-point Halloween treat', 0, 6, cleanText.slice(Math.max(0, hIdx - 300), hIdx + 1500));
    }

    return quests;
  }

  /**
   * 查询「必应应用连续打卡」今日的真实完成状态。
   *
   * 签到接口在「已签过」和「没签成」两种情况下都可能返回 0 积分，
   * 单看返回值分不清，所以这里直接读官网 earn 页里的 streak 模型做判定。
   */
  async getAppCheckInStatus() {
    try {
      const html = await networkClient.request({
        url: 'https://rewards.bing.com/earn',
        headers: pcPageHeaders()
      });
      if (!html) return null;
      const clean = String(html).replace(/\\"/g, '"');
      const key = '"partner":"bingapp"';
      let idx = -1;
      // partner 会出现两次（埋点 data 与真正的 streak 模型），只有模型那段带 completedDays
      while ((idx = clean.indexOf(key, idx + 1)) !== -1) {
        const win = clean.slice(Math.max(0, idx - 1600), idx + 300);
        if (!/"completedDays":\d+/.test(win)) continue;
        return {
          isCurrentDayCompleted: /"isCurrentDayCompleted":true/.test(win),
          completedDays: Number((win.match(/"completedDays":(\d+)/) || [])[1] || 0),
          currentDay: Number((win.match(/"currentDay":(\d+)/) || [])[1] || 0)
        };
      }
    } catch {}
    return null;
  }

  /**
   * 移动端 App 签入
   */
  async signApp() {
    const region = 'cn';
    try {
      const res = await this.withTokenRetry(token => networkClient.request({
        method: 'POST',
        url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'user-agent': USER_AGENTS.app,
          'authorization': `Bearer ${token}`,
          'x-rewards-appid': APP_CONFIG.rewardsAppId,
          'x-rewards-ismobile': 'true',
          'x-rewards-country': region,
          'x-rewards-language': 'zh',
          'x-rewards-partnerid': 'startapp',
          'x-rewards-flights': 'rwgobig'
        },
        data: JSON.stringify({
          amount: 1,
          id: this.getDapiId(),
          type: 103,
          country: region,
          channel: APP_CONFIG.channel,
          // 关键修复：必须带上 offerid，微软才会把它计入「必应应用连续打卡」。
          // 缺了 attributes.offerid 时接口同样返回 200，但连签任务不会推进，
          // 这正是之前「必应应用连续打卡」一直显示 0/1 的原因。
          attributes: { offerid: APP_CONFIG.offerIds.dailyCheckIn }
        })
      }));

      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      if (data?.response) {
        if (data.response.activity) {
          const act = data.response.activity;
          const points = Number(act.p || act.points || 0);
          const appliedOffer = act.a?.offerid || act.attributes?.offerid || '';
          // balance 是「该 Token 所属账号」的积分，可用于判断 Token 与 Cookie 是否同一个号
          const balance = Number(data.response.balance);
          return {
            points,
            offerId: appliedOffer,
            isDuplicate: !!data.response.isDuplicate,
            balance: Number.isFinite(balance) ? balance : null
          };
        }
        if (data.response.isDuplicate || data.response.activity === null) {
          const balance = Number(data.response.balance);
          return {
            points: 0,
            offerId: APP_CONFIG.offerIds.dailyCheckIn,
            isDuplicate: true,
            balance: Number.isFinite(balance) ? balance : null
          };
        }
      }
    } catch (e) {
      logger.log('🔴', `App 签入异常: ${e.message}`);
    }
    return null;
  }

  /**
   * PC 端签入
   */
  async signPC() {
    // 优先采用 Server Action 方式签入（避免官方旧接口 401 报废）
    try {
      const ok = await this.claimCard({
        offerId: 'Gamification_DailyCheckIn',
        hash: '1',
        url: 'https://rewards.bing.com/earn'
      });
      if (ok) return 10;
    } catch {}

    try {
      const token = await this.getRequestVerificationToken();
      const params = new URLSearchParams({
        id: 'Gamification_DailyCheckIn',
        hash: '1',
        activityAmount: '1'
      });
      if (token) params.set('__RequestVerificationToken', token);

      const headers = {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        ...pcXhrHeaders(),
        'referer': 'https://rewards.bing.com/',
        'origin': 'https://rewards.bing.com',
        'x-requested-with': 'XMLHttpRequest'
      };
      if (token) headers['RequestVerificationToken'] = token;

      const res = await networkClient.request({
        method: 'POST',
        url: 'https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest',
        headers,
        data: params.toString()
      });

      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      if (data) {
        return Number(data.points || data.response?.activity?.p || 0);
      }
    } catch (e) {
      // 官方改版后旧接口频报 401，移动端已签入成功时静默处理
    }
    return 0;
  }

  async getRequestVerificationToken(pageUrl = 'https://rewards.bing.com/') {
    try {
      const html = await networkClient.request({
        url: pageUrl,
        headers: pcPageHeaders({ referer: 'https://rewards.bing.com/' })
      });
      const tokenMatch = String(html).match(/name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/i)
        || String(html).match(/RequestVerificationToken.*?value=["']([^"']+)["']/i)
        || String(html).match(/"verificationToken"\s*:\s*"([^"]+)"/i)
        || String(html).match(/"__RequestVerificationToken"\s*:\s*"([^"]+)"/i);
      return tokenMatch ? tokenMatch[1].replace(/&amp;/g, '&') : '';
    } catch {
      return '';
    }
  }

  /**
   * 查询新闻资讯阅读进度
   */
  async getReadProgress() {
    try {
      const res = await this.withTokenRetry(token => networkClient.request({
        url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'user-agent': USER_AGENTS.app,
          'authorization': `Bearer ${token}`,
          'x-rewards-appid': APP_CONFIG.rewardsAppId,
          'x-rewards-ismobile': 'true',
          'x-rewards-country': 'cn',
          'x-rewards-language': 'zh'
        }
      }));

      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      const promos = data?.response?.promotions || [];
      const readOfferId = APP_CONFIG.offerIds.readArticle;
      const task = promos.find(x => x.attributes?.offerid === readOfferId);
      if (task?.attributes) {
        const progress = parseInt(task.attributes.progress) || 0;
        const max = parseInt(task.attributes.max) || 30;
        return { progress, max };
      }
    } catch (e) {
      logger.log('🔴', `阅读进度查询失败: ${e.message}`);
    }
    return null;
  }

  /**
   * 执行单篇新闻阅读打卡
   */
  async doReadArticle() {
    const region = 'cn';
    try {
      const res = await this.withTokenRetry(token => networkClient.request({
        method: 'POST',
        url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'user-agent': USER_AGENTS.app,
          'authorization': `Bearer ${token}`,
          'x-rewards-appid': APP_CONFIG.rewardsAppId,
          'x-rewards-ismobile': 'true',
          'x-rewards-country': region,
          'x-rewards-language': 'zh'
        },
        data: JSON.stringify({
          amount: 1,
          country: region,
          id: this.getRandomUUID().slice(0, 32),
          type: 101,
          attributes: { offerid: APP_CONFIG.offerIds.readArticle }
        })
      }));

      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      if (data?.response) {
        return {
          points: data.response?.activity?.p || 0,
          isDuplicate: data.response?.isDuplicate || false
        };
      }
      return null;
    } catch (e) {
      logger.log('🔴', `阅读上报失败: ${e.message}`);
      return false;
    }
  }

  /**
   * 扫描「任务」区的打孔卡 (Quest Punch Card)
   *
   * 像「十月必看五大亮点」这类每月/每周任务：每天解锁一个小任务，
   * 完成当天任务后要等满 24 小时才会解锁下一个，全部完成才给奖励分。
   * 旧实现只认识桌面客户端的 WW_pcchild 打孔卡，这类网页打孔卡完全没被处理，
   * 所以在官网会一直停在 0/5。
   */
  async getQuestPunchCards() {
    const quests = [];
    try {
      const html = await networkClient.request({
        url: 'https://rewards.bing.com/earn',
        headers: pcPageHeaders()
      });
      if (!html) return quests;

      const clean = String(html).replace(/\\"/g, '"').replace(/\\u0026/g, '&');
      const seen = new Set();
      const allQuests = this.extractQuests(clean);
      const hrefRe = /"href":"\/earn\/quest\/([^"]+)"/g;
      let m;
      while ((m = hrefRe.exec(clean)) !== null) {
        const questId = m[1];
        if (seen.has(questId) || questId.includes('newuser_onboarding')) continue;
        seen.add(questId);
        const matched = allQuests.find(q => {
          if (questId.includes('Halloween') && q.title.includes('Halloween')) return true;
          if (questId.includes('RewardsApp') && (q.title.includes('桌面') || q.title.includes('RewardsApp'))) return true;
          if (questId.includes('FY27') && (q.title.includes('亮点') || q.title.includes('FY27'))) return true;
          return false;
        });
        quests.push({
          questId,
          title: matched?.title || questId,
          url: `https://rewards.bing.com/earn/quest/${questId}`,
          done: matched ? matched.done : false
        });
      }
    } catch (e) {
      logger.log('🔴', `扫描任务打孔卡失败: ${e.message}`);
    }
    return quests;
  }

  /**
   * 读取「日常任务」区（activityCards）的真实完成情况。
   *
   * 用于「今天一张可领卡片都没扫到」时区分到底是「今天没有活动」还是
   * 「已经全部完成」，避免旧实现那样无脑把 promos 标成完成。
   */
  /**
   * 用独立的身份接口复核网页端登录态。
   * 返回 true=已登录 / false=明确未登录 / null=无法判断（网络或接口异常）。
   *
   * 为什么不看 /earn 页面文本：登录入口文案在正常页面里也存在，
   * 用它判断会把「页面改版导致找不到 activityCards」误报成「Cookie 失效」。
   */
  async probeWebLogin() {
    try {
      const raw = await networkClient.request({
        url: 'https://cn.bing.com/rewards/panelflyout/getuserinfo',
        headers: pcPageHeaders({ referer: 'https://cn.bing.com/' })
      });
      if (!raw) return null;
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!data || typeof data !== 'object') return null;
      const user = data.userInfo || data.flyoutResult?.userStatus || {};
      const balance = Number(user.balance ?? user.availablePoints ?? user.totalBalance ?? 0);
      const ruid = user.ruid ?? user.epuid ?? user.userId ?? user.cimsid ?? null;
      if (balance > 0 || ruid) return true;
      return false;
    } catch {
      return null;
    }
  }

  /**
   * 诊断：抓取 /earn 页面，返回「今日积分」附近的所有原文片段。
   * 仅用于排查口径问题，不参与业务判定。
   */
  /**
   * 拉取官方 JSON 接口 /api/getuserinfo，返回原始 dashboard 数据。
   * 这是结构化数据，不依赖 HTML 结构，是 /earn 空壳页时的权威来源。
   */
  async fetchUserInfoDashboard() {
    const raw = await networkClient.request({
      url: `https://rewards.bing.com/api/getuserinfo?type=1&X-Requested-With=XMLHttpRequest&_=${Date.now()}`,
      headers: {
        ...pcXhrHeaders(),
        referer: 'https://rewards.bing.com/',
        'x-requested-with': 'XMLHttpRequest'
      }
    });
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return data;
  }

  /**
   * 汇总一个 JSON 对象：顶层键、嵌套键、所有数值叶子路径。
   * 只用于诊断，不参与业务判定。
   */
  summarizeJson(data, maxLeaves = 200) {
    const numericLeaves = [];
    const keyPaths = [];
    const walk = (node, path, depth) => {
      if (depth > 6 || node === null || node === undefined) return;
      if (Array.isArray(node)) {
        if (node.length > 0 && typeof node[0] !== 'object') {
          numericLeaves.push({ path, value: JSON.stringify(node).slice(0, 200) });
        }
        node.slice(0, 5).forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
        return;
      }
      if (typeof node !== 'object') {
        if (typeof node === 'number' || (typeof node === 'string' && /^\d+$/.test(node))) {
          if (numericLeaves.length < maxLeaves) numericLeaves.push({ path, value: Number(node) });
        }
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        const childPath = path ? `${path}.${key}` : key;
        if (keyPaths.length < maxLeaves) keyPaths.push(childPath);
        walk(value, childPath, depth + 1);
      }
    };
    walk(data, '', 0);
    return {
      topLevelKeys: data && typeof data === 'object' ? Object.keys(data) : [],
      keyPaths,
      numericLeaves
    };
  }

  async diagnoseTodayPoints() {
    const html = await networkClient.request({
      url: 'https://rewards.bing.com/earn',
      headers: pcPageHeaders()
    });
    if (!html) return { found: false, reason: 'empty-response' };
    const normalized = normalizeFlightFragment(concatFlightChunks(String(html)));
    const snippets = [];
    const needle = '今日积分';
    let idx = normalized.indexOf(needle);
    while (idx !== -1 && snippets.length < 10) {
      snippets.push(normalized.slice(Math.max(0, idx - 120), idx + 400));
      idx = normalized.indexOf(needle, idx + needle.length);
    }
    const info = await this.getRewardsInfo(1).catch(() => null);
    // 列出页面里出现的所有「疑似卡片容器」字段名，便于确认账号用了哪一组字段
    const cardKeys = ['activityCards', 'dailySetPromotions', 'promotionalItems', 'morePromotions', 'punchCards', 'highValueActionPromotions', 'exploreOnBingPromotions'];
    const cardFieldPresence = {};
    for (const key of cardKeys) {
      const idx = normalized.indexOf('"' + key + '"');
      cardFieldPresence[key] = idx !== -1;
    }
    const activityStatus = await this.getActivityCardStatus().catch(() => null);
    // 结构化接口：/earn 是空壳时的权威数据源
    let userInfoSummary = null;
    let userInfoError = null;
    try {
      const userInfo = await this.fetchUserInfoDashboard();
      userInfoSummary = this.summarizeJson(userInfo);
    } catch (e) {
      userInfoError = e.message;
    }
    return {
      found: snippets.length > 0,
      count: snippets.length,
      snippets,
      parsedTodayPoints: info?.todayPoints ?? null,
      parsedSource: info?.todayPointsSource ?? null,
      claimablePoints: info?.claimablePoints ?? null,
      cardFieldPresence,
      activityStatus,
      htmlLength: String(html).length,
      userInfoSummary,
      userInfoError,
      // 空壳页排查：页面头部原文 + Cookie 名称清单（不含值）
      htmlHead: String(html).slice(0, 1500),
      cookieNames: (() => {
        try {
          const cookie = networkClient.getCookieString('https://rewards.bing.com/') || '';
          return cookie.split(';')
            .map(part => part.trim().split('=')[0])
            .filter(Boolean)
            .sort();
        } catch {
          return [];
        }
      })(),
      hasRequestVerificationCookie: (() => {
        try {
          const cookie = networkClient.getCookieString('https://rewards.bing.com/') || '';
          return /(^|;\s*)(__RequestVerificationToken|RPSSecAuth|KievRPSSecAuth|_C_Auth)=/i.test(cookie);
        } catch {
          return false;
        }
      })()
    };
  }

  async getActivityCardStatus() {
    try {
      const { html } = await this.fetchEarnHtmlPreferBrowser();
      if (!html) return { total: 0, completed: 0, readable: false, reason: 'empty-response' };

      // /earn 是 Next.js RSC 页面，activityCards 位于 self.__next_f.push 的转义片段内。
      // 旧实现直接 indexOf('"activityCards":[') —— 一旦页面把引号输出成 \"activityCards\"，
      // 就永远匹配不到，于是把「其实读到了、只是没有卡片」误报成「未能读取官网状态」。
      // 这里先拼回 Flight 文本，再用「字符串感知 + 括号配平」的方式抽取数组，两种形态都能识别。
      const text = normalizeFlightFragment(concatFlightChunks(html));
      // 不同页面版本/账号的实验分组会用不同字段承载「日常任务」。
      // activityCards 是当前主字段，其余是同一份数据的历史/实验字段名。
      const CARD_KEYS = ['activityCards', 'dailySetPromotions', 'promotionalItems', 'morePromotions', 'punchCards'];
      let raw = null;
      let usedKey = null;
      for (const key of CARD_KEYS) {
        const found = extractJsonArray(text, key);
        if (found) { raw = found; usedKey = key; break; }
      }
      if (!raw) {
        // 不能用「页面里出现『登录』字样」来判断 Cookie 失效：
        // /earn 页面本身就包含登录/账号入口文案，实测会把正常页面误报成 not-signed-in。
        // 正确做法是用独立的身份接口复核登录态（与账号体检同一口径）。
        const signedIn = await this.probeWebLogin();
        return {
          total: 0,
          completed: 0,
          readable: false,
          reason: signedIn === false ? 'not-signed-in' : 'activity-cards-not-found'
        };
      }

      const cleaned = raw.replace(/:\$undefined/g, ':null').replace(/:\$D[^,}\]]+/g, ':null');
      let cards;
      try {
        cards = JSON.parse(cleaned);
      } catch {
        return { total: 0, completed: 0, readable: false, reason: 'json-parse-failed' };
      }
      if (!Array.isArray(cards)) {
        return { total: 0, completed: 0, readable: false, reason: 'not-an-array' };
      }
      const completed = cards.filter(c => c && (c.isCompleted === true || c.complete === true)).length;
      return { total: cards.length, completed, readable: true, reason: null, usedKey };
    } catch {
      return { total: 0, completed: 0, readable: false, reason: 'request-failed' };
    }
  }

  async discoverCards() {
    const cards = [];
    const seenCardKeys = new Set();

    const pushCard = (card) => {
      if (!card || !card.offerId || !card.hash || card.points <= 0) return;
      const key = `${card.offerId}:${card.hash}`;
      if (seenCardKeys.has(key)) return;
      // 分类标记：供「每日活动集」「桌面端打孔卡」两个独立开关做过滤
      if (!card.category) {
        card.category = /dailyset/i.test(card.offerId) ? 'dailyset' : 'promo';
      }
      seenCardKeys.add(key);
      cards.push(card);
    };

    const inferKind = (offerId = '', title = '') => {
      const text = `${offerId} ${title}`.toLowerCase();
      if (/quiz|trivia|question|测验|答案/.test(text)) return 'quiz';
      if (/puzzle|拼图/.test(text)) return 'puzzle';
      if (/image|图片|设计/.test(text)) return 'image_creator';
      if (/explore|search|浏览|探索/.test(text)) return 'explore_search';
      if (/dailyset|daily|每日/.test(text)) return 'daily';
      if (/streak|打卡|连续/.test(text)) return 'streak';
      return 'open_only';
    };

    try {
      const html = await networkClient.request({
        url: 'https://rewards.bing.com/earn',
        headers: pcPageHeaders()
      });
      if (!html) return cards;

      // 1. Next.js Flight Chunks 解析
      //    卡片对象普遍带嵌套字段（attributes / destination / isLocked 等）。
      //    旧正则 /\{[^{}]*?"offerId"\s*:\s*"([^"]+)"[^{}]*?\}/ 不允许花括号嵌套，
      //    所以只要卡片里出现任意子对象就会「整体失配」，一张卡都扫不到 ——
      //    上层看到的就是「0 张可执行卡片」。这里改用括号配平扫描，嵌套多深都能取出对象。
      try {
        const fullFlightText = normalizeFlightFragment(concatFlightChunks(html));
        const offerObjects = extractOfferObjects(fullFlightText);
        let skippedCompleted = 0;
        let skippedLocked = 0;
        for (const objectText of offerObjects) {
          try {
            const item = JSON.parse(objectText.replace(/:\$undefined/g, ':null').replace(/:\$D[^,}\]]+/g, ':null'));
            if (!item.offerId || !item.hash) continue;
            if (item.isCompleted === true) { skippedCompleted++; continue; }
            if (item.isLocked === true) { skippedLocked++; continue; }
            const points = Number(item.points || 0);
            if (points <= 0 && !String(item.offerId).includes('DailySet')) continue;
            pushCard({
              title: item.title || item.name || item.offerId,
              points: points || 10,
              offerId: item.offerId,
              hash: item.hash,
              kind: inferKind(item.offerId, item.title || ''),
              destination: item.destination || item.destinationUrl || '',
              url: 'https://rewards.bing.com/earn'
            });
          } catch {}
        }
        if (offerObjects.length > 0) {
          // 关键诊断：区分「官网真的没给卡片」与「给了但全完成/全锁/解析失败」
          logger.log(
            '🧩',
            `活动卡片解析：官网返回 ${offerObjects.length} 个卡片对象，已完成 ${skippedCompleted}、未解锁 ${skippedLocked}，可执行 ${cards.length} 项`
          );
        }
      } catch (e) {
        logger.log('🟡', `Flight 卡片数据解析异常: ${e.message}`);
      }

      // 2. 桌面客户端专属任务检测 (独家 70 积分/周)
      try {
        const questMatch = String(html).match(/href="(\/earn\/quest\/(WW_pcparent_RewardsApp_weekly_Exclusive[^"]+))"/i)
          || String(html).match(/"(\/earn\/quest\/(WW_pcparent_RewardsApp_weekly_Exclusive[^"]+))"/i);
        if (questMatch) {
          const questUrl = 'https://rewards.bing.com' + questMatch[1];
          const questHtml = await networkClient.request({
            url: questUrl,
            headers: DESKTOP_APP_HEADERS
          });
          if (questHtml) {
            const qChunks = [];
            const qPushRegex = /self\.__next_f\.push\(\[\d+,\s*"(.*?)"\]\)/gs;
            let qm;
            while ((qm = qPushRegex.exec(String(questHtml))) !== null) {
              try { qChunks.push(JSON.parse(`"${qm[1]}"`)); } catch {}
            }
            const qText = qChunks.length > 0 ? qChunks.join('') : String(questHtml).replace(/\\"/g, '"');
            const qOfferRegex = /\{[^{}]*?"offerId"\s*:\s*"(WW_pcchild\d+[^"]+)"[^{}]*?\}/g;
            let qo;
            let desktopTotal = 0;
            let desktopReady = 0;
            let desktopLocked = 0;
            let desktopCompleted = 0;
            while ((qo = qOfferRegex.exec(qText)) !== null) {
              try {
                const qItem = JSON.parse(qo[0].replace(/:\$undefined/g, ':null').replace(/:\$D[^\",}]+/g, ':null'));
                desktopTotal++;
                if (qItem.isCompleted === true) { desktopCompleted++; continue; }
                if (qItem.isLocked === true) { desktopLocked++; continue; }
                if (qItem.offerId && qItem.hash && qItem.isLocked === false && qItem.isCompleted === false) {
                  desktopReady++;
                  logger.log('🖥️', `发现桌面端专享打卡任务: ${qItem.title || qItem.offerId}`);
                  pushCard({
                    title: `[桌面专享] ${qItem.title || qItem.name || qItem.offerId}`,
                    points: 10,
                    offerId: qItem.offerId,
                    hash: qItem.hash,
                    kind: 'desktop_app',
                    category: 'desktop',
                    destination: qItem.destination || qItem.href || '',
                    url: 'https://rewards.bing.com/earn'
                  });
                }
              } catch {}
            }
            if (desktopTotal > 0) {
              // 帮助用户理解「昨天 3 个今天 1 个」：周打孔卡是按天逐步解锁的
              logger.log('🖥️', `桌面每周专属任务：共 ${desktopTotal} 项，本次可打卡 ${desktopReady} 项（已完成 ${desktopCompleted} / 未解锁 ${desktopLocked}）`);
            }
          }
        }
      } catch (eQuest) {
        logger.log('🟡', `桌面专属任务解析跳过: ${eQuest.message}`);
      }
    } catch (e) {
      logger.log('🔴', `扫描活动卡片失败: ${e.message}`);
    }

    return cards;
  }

  async getNextActionHash(html) {
    if (html && html.includes('_next/static/chunks/')) {
      const scriptSrcs = [...new Set(html.match(/\/_next\/static\/chunks\/[a-z0-9_\-]+\.js\?dpl=[^"]+/g) || [])];
      for (const src of scriptSrcs) {
        try {
          const chunkText = await networkClient.request({ url: 'https://rewards.bing.com' + src });
          const match = String(chunkText).match(/createServerReference\)\("([a-f0-9]{40,44})"[^)]*"reportActivity"\)/);
          if (match && match[1]) {
            this.cachedNextAction = match[1];
            break;
          }
        } catch {}
      }
    }
    return this.cachedNextAction;
  }

  /**
   * 完成单张卡片打卡
   */
  async claimCard(card) {
    const url = card.url || 'https://rewards.bing.com/earn';
    const referer = card.url || 'https://rewards.bing.com/earn';
    let nextAction = this.cachedNextAction;

    // 策略 1: Next.js Server Action
    try {
      const headers = {
        'content-type': 'text/plain;charset=UTF-8',
        'next-action': nextAction,
        'referer': referer
      };
      if (card.kind === 'desktop_app') {
        Object.assign(headers, DESKTOP_APP_HEADERS);
      }
      const res = await networkClient.request({
        method: 'POST',
        url,
        headers,
        data: JSON.stringify([card.hash, 11, { offerid: card.offerId, isPromotional: '$undefined', timezoneOffset: '-480' }])
      });
      const str = String(res);
      if (str.includes('true') || str.includes('"i":false') || str.includes('"a":')) {
        return true;
      }
    } catch (e) {
      if (e.message && e.message.includes('404')) {
        try {
          const earnHtml = await networkClient.request({ url: 'https://rewards.bing.com/earn' });
          nextAction = await this.getNextActionHash(earnHtml);
          const retryRes = await networkClient.request({
            method: 'POST',
            url,
            headers: { 'content-type': 'text/plain;charset=UTF-8', 'next-action': nextAction, referer },
            data: JSON.stringify([card.hash, 11, { offerid: card.offerId, isPromotional: '$undefined', timezoneOffset: '-480' }])
          });
          if (retryRes) return true;
        } catch {}
      }
    }

    // 策略 2: 每日活动目标链接搜索上报
    if (card.destination && card.destination.startsWith('http')) {
      try {
        await this.reportDailyActivity(card.destination);
        return true;
      } catch {}
    }

    // 策略 3: 老版 reportactivity
    try {
      const token = await this.getRequestVerificationToken();
      if (token) {
        await networkClient.request({
          method: 'POST',
          url: 'https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest',
          headers: {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            ...pcXhrHeaders(),
            'referer': referer,
            'origin': 'https://rewards.bing.com',
            'x-requested-with': 'XMLHttpRequest'
          },
          data: new URLSearchParams({
            id: card.offerId,
            hash: card.hash,
            timeZone: 480,
            activityAmount: 1,
            dbs: 0,
            form: '',
            type: '',
            __RequestVerificationToken: token
          }).toString()
        });
        return true;
      }
    } catch {}

    return false;
  }

  async reportDailyActivity(searchUrl) {
    try {
      const fullUrl = searchUrl.startsWith('http') ? searchUrl : `https://cn.bing.com${searchUrl}`;
      const ig = this.getRandomUUID().substring(0, 32).toUpperCase();
      const cnUrl = fullUrl.replace(/^https?:\/\/www\.bing\.com/, 'https://cn.bing.com')
                           .replace(/^https:\/\/bing\.com/, 'https://cn.bing.com');
      const cnUrlObj = new URL(cnUrl);
      const cnSp = cnUrlObj.searchParams;
      const reportParams = new URLSearchParams();
      reportParams.set('IG', ig);
      reportParams.set('IID', 'commerce.5067');
      if (cnSp.get('form')) reportParams.set('form', cnSp.get('form'));
      if (cnSp.get('ocid') || cnSp.get('OCID')) reportParams.set('ocid', cnSp.get('ocid') || cnSp.get('OCID'));

      await networkClient.request({
        method: 'GET',
        url: cnUrl,
        headers: {
          ...pcPageHeaders(),
          'referer': 'https://rewards.bing.com/'
        }
      });

      await networkClient.request({
        method: 'POST',
        url: `https://cn.bing.com/rewardsapp/reportActivity?${reportParams.toString()}`,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...pcXhrHeaders(),
          'referer': cnUrl,
          'origin': 'https://cn.bing.com'
        },
        data: new URLSearchParams({ url: cnUrl, V: 'web' }).toString()
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 探测并获取当前词库明细列表（用于前端测试与热词轮询）
   */
  async fetchSearchWordList(mode = 'offline') {
    if (mode === 'offline') {
      const sample = SEARCH_POOL.slice(0, 20);
      return { success: true, mode: 'offline', name: '本地离线智能词库', count: SEARCH_POOL.length, sample };
    }

    const apiMap = {
      'baidu.official': { url: 'https://top.baidu.com/api/board?platform=wise&tab=realtime', name: '百度官方实时热搜榜 (直连)' },
      'hot.cnxiaobai.com': { url: 'https://cnxiaobai.com/DailyHotApi/baidu', name: 'DailyHotApi 聚合榜单 (cnxiaobai)' },
      'hot.nntool.cc': { url: 'https://hotapi.nntool.cc/baidu', name: '今日热榜聚合榜单 (nntool)' }
    };

    const target = apiMap[mode] || apiMap['baidu.official'];
    try {
      const res = await networkClient.request({ url: target.url });
      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      let words = [];

      if (mode === 'baidu.official') {
        const rawList = data?.data?.cards?.[0]?.content?.[0]?.content || [];
        words = rawList.map(item => item.word).filter(Boolean);
      } else {
        if (data && Array.isArray(data.data)) {
          words = data.data.map(item => item.title || item.word).filter(Boolean);
        }
      }

      if (words.length > 0) {
        return { success: true, mode, name: target.name, count: words.length, sample: words.slice(0, 20) };
      }
      return { success: false, mode, name: target.name, message: '接口返回数据为空或格式变动' };
    } catch (e) {
      return { success: false, mode, name: target.name, message: `网络请求失败: ${e.message}` };
    }
  }

  /**
   * 获取热搜词（支持多 API 轮换与本地随机词池）
   */
  async getHotSearchWord() {
    const cfg = configManager.get();
    const mode = cfg.tasks?.searchApi || 'baidu.official';
    const baseWord = SEARCH_POOL[this.randomRange(0, SEARCH_POOL.length - 1)];
    const randomSuffix = Math.random().toString(36).slice(2, 6);
    const fallbackSentence = `${baseWord} ${randomSuffix}`;

    if (mode !== 'offline') {
      try {
        if (this.hotWordList.length === 0 || this.hotWordIndex >= this.hotWordList.length) {
          const listResult = await this.fetchSearchWordList(mode);
          if (listResult.success && Array.isArray(listResult.sample) && listResult.sample.length > 0) {
            this.hotWordList = listResult.sample;
            this.hotWordIndex = 0;
          }
        }
        if (this.hotWordList.length > 0 && this.hotWordIndex < this.hotWordList.length) {
          const word = this.hotWordList[this.hotWordIndex++];
          if (typeof word === 'string' && word.trim()) {
            return word.trim().slice(0, 30);
          }
        }
      } catch (e) {
        logger.log('🟡', `热搜词获取接口异常: ${e.message}，切换到离线词池`, '', logger.getAccountContext());
      }
    }
    return fallbackSentence;
  }

  /**
   * 执行 PC 端搜索请求与奖励上报
   */
  async doSearchOnce(query) {
    const ig = this.getRandomUUID();
    const mkt = '&mkt=zh-CN';
    const searchUrl = `https://${this.host}/search?q=${encodeURIComponent(query)}&form=QBLH${mkt}`;
    const dateNowStr = `${new Date().getMonth() + 1}/${new Date().getDate()}/${new Date().getFullYear()}`;
    // 关键：_Rwho 必须叠加在账号 Cookie 之上，直接设置 'cookie' 头会覆盖
    // networkClient 自动注入的登录 Cookie（_U/_C_Auth 等），导致搜索不计分。
    // 同时剔除旧版残留的 _EDGE_S 与重复的 _Rwho，避免 Cookie 头里出现同名项。
    const accountCookie = networkClient.getCookieString(`https://${this.host}/`)
      .split(';')
      .map(p => p.trim())
      .filter(p => p && !/^_EDGE_S=/i.test(p) && !/^_Rwho=/i.test(p))
      .join('; ');
    const searchCookie = [accountCookie, `_Rwho=u=d&ts=${dateNowStr}`].filter(Boolean).join('; ');

    // 1. 请求搜索页面
    await networkClient.request({
      url: searchUrl,
      headers: {
        ...pcPageHeaders(),
        'cookie': searchCookie,
        'referer': `https://${this.host}/?form=QBLH`
      }
    });

    // 2. 模拟报送 ncheader
    try {
      await networkClient.request({
        method: 'POST',
        url: `https://${this.host}/rewardsapp/ncheader?ver=88888888&IID=SERP.5047&IG=${ig}&ajaxreq=1`,
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          ...pcXhrHeaders(),
          'referer': `https://${this.host}/?form=QBLH`,
          'cookie': searchCookie
        },
        data: 'wb=1%3bi%3d1%3bv%3d1'
      });
    } catch {}

    // 3. 模拟报送 reportActivity
    const params = `q=${encodeURIComponent(query)}&form=QBLH${mkt}`;
    await networkClient.request({
      method: 'POST',
      url: `https://${this.host}/rewardsapp/reportActivity?IG=${ig}&IID=SERP.5047&${params}&ajaxreq=1`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        ...pcXhrHeaders(),
        'referer': `https://${this.host}/?form=QBLH`,
        'cookie': searchCookie
      },
      data: `url=${encodeURIComponent(`https://${this.host}/search?${params}`)}&V=web`
    });

    return true;
  }

  /**
   * 连签任务检测与视觉搜索
   *
   * 注意：视觉搜索（vsstreak）没法靠一次 HTTP GET 真正完成，原实现每次检测到
   * 未完成就发一次请求，于是「检测到未打卡」会无限刷屏，并且高频访问微软接口
   * 存在风控风险。现改为：
   *   - 只有任务执行期（allowVisualSearchCheckIn=true）才尝试补签；
   *   - 每个账号每天最多尝试一次；
   *   - 跳过时不再打日志，避免刷屏。
   */
  async checkStreak(options = {}) {
    const { allowVisualSearchCheckIn = false } = options;
    try {
      const html = await networkClient.request({
        url: 'https://rewards.bing.com/earn',
        headers: pcPageHeaders()
      });
      if (!html) return null;

      // 官网是 Next.js RSC 页面，正文数字在 Flight 数据流里，
      // 直接剥 HTML 标签拿不到「每日连续打卡 123」这种相邻文本。
      let streakDays = this.parseLabeledHeaderValue(String(html), '每日连续打卡') ?? 0;
      const flight = normalizeFlightFragment(concatFlightChunks(String(html)));
      if (streakDays === 0) {
        const streakMatch = flight.match(/"children"\s*:\s*"每日连续打卡"[\s\S]{0,1500}?"children"\s*:\s*"?\+?(\d+)"?/)
          || String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').match(/每日连续打卡\s*(\d+)/);
        if (streakMatch) streakDays = parseInt(streakMatch[1], 10) || 0;
      }
      const text = String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

      // 检测视觉搜索
      const vsMatch = text.match(/视觉搜索连续打卡[\s\S]*?活动:\s*(\d+)\/(\d+)/);
      if (vsMatch) {
        const cur = parseInt(vsMatch[1]);
        const max = parseInt(vsMatch[2]);
        if (cur < max && allowVisualSearchCheckIn) {
          const accountKey = this.currentAccountId || 'acc_1';
          const d = new Date();
          const today = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
          if (!this.visualSearchCheckInAt) this.visualSearchCheckInAt = {};
          if (this.visualSearchCheckInAt[accountKey] !== today) {
            this.visualSearchCheckInAt[accountKey] = today;
            logger.log('📅', `视觉搜索未完成 (${cur}/${max})，尝试后台补签（每账号每天一次）...`);
            await networkClient.request({
              url: 'https://www.bing.com/?features=vsstreak,vstooltip&form=ML2XES',
              headers: pcPageHeaders({ referer: 'https://www.bing.com/' })
            });
            await this.randomDelay(2000, 4000);
          }
        }
      }

      return { streakDays };
    } catch (e) {
      logger.log('🔴', `连签检测异常: ${e.message}`);
      return null;
    }
  }

  /**
   * 检测 Dashboard 额外积分
   */
  async checkClaimablePoints() {
    try {
      const html = await networkClient.request({
        url: 'https://rewards.bing.com/dashboard',
        headers: pcPageHeaders()
      });
      const claimableMatch = String(html).match(/alt="可领取"[^>]*>[\s\S]*?(\d[\d,]*)/i);
      if (claimableMatch) {
        const amount = parseInt(claimableMatch[1].replace(/,/g, '')) || 0;
        if (amount > 0) {
          logger.log('🎁', `发现 ${amount} 点额外积分待手动确认领奖`);
        }
      }
    } catch {}
  }
}

export const rewardsApi = new RewardsApi();
export default rewardsApi;

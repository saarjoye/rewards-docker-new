import fs from 'fs';
import { EventEmitter } from 'events';
// patchright-core 是 playwright-core 的补丁分支（API 完全一致），
// 它从协议层修掉了 Playwright 最容易被识别的自动化特征：
// CDP 的 Runtime.enable / Console.enable 泄漏、--enable-automation 启动参数、
// navigator.webdriver 等。--disable-blink-features=AutomationControlled 由它自动加上，
// 所以下面不再重复传这个参数。
import { chromium } from 'patchright-core';
import logger from '../logger.js';
import rewardsApi from './api.js';
import configManager from '../config.js';
import { browserSlotLock } from './contextLock.js';
import { readBrowserSession, writeBrowserSession } from './browserSession.js';
import { parseCookieInput } from './cookieImport.js';
import { SearchStagnationGuard } from './searchStagnation.js';
import {
  PC_USER_AGENT,
  SEC_CH_UA,
  PLATFORM,
  CHROME_MAJOR,
  buildUserAgentMetadata
} from './fingerprint.js';

class BrowserManager extends EventEmitter {
  constructor() {
    super();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.shouldStop = false;
    // 是否持有浏览器资源锁（由 launchBrowser/closeBrowser 维护）
    this.slotHeld = false;
    // 当前绑定的账号（会话持久化需要它来定位文件与校验凭据指纹）
    this.sessionAccount = null;
    this.state = {
      status: 'idle', // 'idle' | 'starting' | 'navigating' | 'typing' | 'dwelling' | 'waiting' | 'stopped'
      activeAccountId: null,
      activeAccountName: '未启动',
      currentQuery: '',
      searchCount: 0,
      totalTarget: 0,
      nextSearchIn: 0,
      memoryMB: 0,
      lastAction: '浏览器当前处于空闲休眠状态 (0 内存占用)',
      lastUpdate: Date.now()
    };
  }

  getExecutablePath() {
    if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) {
      return process.env.CHROMIUM_PATH;
    }

    const candidatePaths = [
      // Linux (Debian/Ubuntu/Alpine)
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      // macOS
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      // Windows
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  updateState(partial) {
    Object.assign(this.state, partial);
    this.state.lastUpdate = Date.now();
    this.emit('status', this.state);
  }

  getStatus() {
    return this.state;
  }

  /**
   * 解析用户粘贴的 Cookie 字符串。
   *
   * 支持三种常见来源：
   *   1. 浏览器 DevTools「请求标头」里的 Cookie 头（分号分隔，可能混入 Path/Domain/Expires 等属性）
   *   2. Safari / 表格复制（每行「名称<TAB>值」）
   *   3. curl / Netscape cookie-jar（域、子域标志、路径、Secure、过期、名、值）
   *
   * 关键点：Cookie 属性（Path、Domain、Expires…）不是 Cookie，绝不能传给
   * Chromium 的 Storage.setCookies，否则整批注入都会以
   * "Protocol error (Storage.setCookies): Invalid cookie fields" 失败，
   * 导致账号直接掉登录态。
   */
  parseCookies(cookieStr, defaultDomain = '.bing.com') {
    if (!cookieStr || typeof cookieStr !== 'string') return [];
    // JSON（含 domain 的完整导出）走新解析器，保留每个 Cookie 自己的 domain；
    // Header String 继续走下面的旧逻辑（属性过滤/去重/Safari/Netscape 兼容）。
    if (cookieStr.trim().startsWith('[')) {
      const parsed = parseCookieInput(cookieStr, defaultDomain);
      if (parsed && parsed.cookies.length > 0) return parsed.cookies;
    }
    if (typeof cookieStr !== 'string') return [];
    const rawDomain = String(defaultDomain || '.bing.com').trim() || '.bing.com';
    const domain = rawDomain.startsWith('.') ? rawDomain : '.' + rawDomain;
    // __Host- 前缀 Cookie 不允许 Domain 属性，必须绑定到具体主机 +
    // Secure + Path=/。Bing 的网页登录站点统一走 cn.bing.com。
    const host = domain.endsWith('bing.com') ? 'cn.bing.com' : domain.replace(/^\./, '');

    // Cookie 属性名（大小写不敏感），出现即说明它是属性而不是 Cookie。
    const ATTRIBUTE_NAMES = new Set([
      'path', 'domain', 'expires', 'max-age', 'httponly', 'secure',
      'samesite', 'priority', 'partitioned', 'comment', 'commenturl',
      'discard', 'port', 'version'
    ]);
    // RFC 6265 token：Cookie 名只允许这些字符。
    const TOKEN_RE = /^[!#$%&'*+\-.^_\x60|~0-9A-Za-z]+$/;
    // Chromium 拒绝超过约 4096 字节的单条 Cookie。
    const MAX_COOKIE_BYTES = 4096;

    const list = new Map();

    // 归一化后入队。返回实际写入的 Cookie 对象，便于调用方补正 path。
    const push = (rawName, rawValue, domainOverride) => {
      const name = String(rawName == null ? '' : rawName).trim();
      let value = String(rawValue == null ? '' : rawValue).trim();
      if (!name) return null;
      // 身份追踪 Cookie，注入后会造成串号 / 跳登录页。
      if (name.toUpperCase() === '_EDGE_S') return null;
      // $Version / $Path 等旧式属性标记。
      if (name.startsWith('$')) return null;
      // Path、Domain、Expires、HttpOnly、Secure、SameSite 等属性不是 Cookie。
      if (ATTRIBUTE_NAMES.has(name.toLowerCase())) return null;
      if (!TOKEN_RE.test(name)) return null;
      // Safari 复制会带一层引号，剥掉后才是真实值。
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      // 控制字符会让 CDP Storage.setCookies 整批失败，必须提前剔除。
      if (/[\u0000-\u001f\u007f]/.test(value)) return null;
      // 超长 Cookie 同样会让 Chromium 拒绝整批请求。
      if (Buffer.byteLength(name + '=' + value, 'utf8') > MAX_COOKIE_BYTES) return null;

      const itemDomain = String(domainOverride || domain).trim() || domain;
      let cookie;
      if (name.startsWith('__Host-')) {
        // __Host- 必须不带 domain、Secure、Path=/，用 url 形式最稳。
        cookie = {
          name,
          value,
          url: 'https://' + host + '/',
          secure: true,
          sameSite: 'Lax',
          expires: -1
        };
      } else {
        cookie = {
          name,
          value,
          domain: itemDomain,
          path: '/',
          secure: true,
          sameSite: 'Lax',
          expires: -1
        };
      }
      // 同名 Cookie 保留最后一次出现的值，且保持首次插入顺序。
      const key = (cookie.domain || cookie.url) + '\u0000' + name + '\u0000' + (cookie.path || '');
      list.set(key, cookie);
      return cookie;
    };

    for (const rawLine of cookieStr.split(/\r?\n/)) {
      let line = rawLine.trim();
      if (!line) continue;
      // curl cookie-jar 的 HttpOnly 行以 #HttpOnly_ 开头，仍然属于真实 Cookie。
      if (line.startsWith('#HttpOnly_')) {
        line = line.slice('#HttpOnly_'.length);
      } else if (line.startsWith('#')) {
        continue;
      }

      // Netscape / curl cookie-jar：域、子域标志、路径、Secure、过期、名、值
      const cells = line.split('\t').map(c => c.trim());
      if (cells.length >= 7 && cells[2].startsWith('/')) {
        const cookie = push(cells[5], cells[6], cells[0]);
        if (cookie) cookie.path = cells[2] || '/';
        continue;
      }

      // 其余情况一律按分号拆分；Safari 的「名<TAB>值」由 tab 分支识别。
      for (const part of line.split(';')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const tabIdx = trimmed.indexOf('\t');
        const eqIdx = trimmed.indexOf('=');
        if (tabIdx > 0 && (eqIdx < 0 || tabIdx < eqIdx)) {
          push(trimmed.slice(0, tabIdx), trimmed.slice(tabIdx + 1));
        } else if (eqIdx > 0) {
          push(trimmed.slice(0, eqIdx), trimmed.slice(eqIdx + 1));
        }
      }
    }

    return [...list.values()];
  }
  async addCookiesSafely(context, cookies, accName = '当前账号') {
    if (!Array.isArray(cookies) || cookies.length === 0) return 0;

    try {
      await context.addCookies(cookies);
      return cookies.length;
    } catch (e) {
      logger.log('🟡', `批量注入 Cookie 失败，正在逐个隔离无效项: ${e.message}`, '', accName);
    }

    let added = 0;
    for (const cookie of cookies) {
      try {
        await context.addCookies([cookie]);
        added += 1;
      } catch (e) {
        logger.log('🟡', `已跳过无效 Cookie ${cookie.name}: ${e.message}`, '', accName);
      }
    }
    return added;
  }
  async launchBrowser(acc) {
    const execPath = this.getExecutablePath();
    if (!execPath) {
      throw new Error('未检测到 Chromium 或 Edge 浏览器内核，请确保安装了 Chromium');
    }

    // 抢浏览器资源锁：Epic 领取也走同一把锁，避免两个 Chromium 同时跑把 NAS 内存打满
    const gotSlot = await browserSlotLock.acquire('rewards-browser', 180000);
    if (!gotSlot) {
      throw new Error('浏览器资源正被其它任务占用（Epic 领取或另一个搜索流程），请稍后重试');
    }
    this.slotHeld = true;

    this.updateState({
      status: 'starting',
      activeAccountId: acc?.id || 'acc_1',
      activeAccountName: acc?.name || '当前账号',
      memoryMB: 180,
      lastAction: '正在初始化无头浏览器 Chromium 引擎...'
    });

    let browser = null;
    try {
      browser = await chromium.launch({
        executablePath: execPath,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          // 内存与进程数控制：NAS 上默认会派生大量 renderer/utility，单轮可涨到 1.8G
          // 限制 renderer 数量 + 关闭 crashpad（僵尸进程主要来源）+ 关掉软件光栅化
          '--renderer-process-limit=1',
          '--disable-background-networking',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-software-rasterizer',
          '--disable-breakpad',
          '--disable-crash-reporter',
        ]
      });

      // 镜像里的 Chromium 主版本如果和指纹常量脱节，这里提醒维护者同步，
      // 否则会重新出现「UA 版本 ≠ 真实引擎版本」的矛盾。
      const realMajor = String(browser.version() || '').split('.')[0];
      if (realMajor && realMajor !== CHROME_MAJOR) {
        logger.log('🟡', `镜像内 Chromium 主版本为 ${realMajor}，但指纹常量 CHROME_MAJOR=${CHROME_MAJOR}，建议同步更新 src/core/fingerprint.js`);
      }

      // 复用该账号上一轮的浏览器会话（Cookie + localStorage）。
      // 凭据换过账号时 readBrowserSession 会判定为过期并返回 null，自动回退到全新会话。
      const stored = readBrowserSession(acc);
      const storageState = stored?.storageState || null;
      if (stored?.stale) {
        logger.log('🟡', `已丢弃该账号的旧浏览器会话（${stored.reason}），本次使用全新会话`, '', acc?.name);
      } else if (storageState) {
        const savedDays = stored.savedAt
          ? ((Date.now() - stored.savedAt) / 86400000).toFixed(1)
          : '?';
        logger.log('🔐', `已复用该账号的浏览器会话（${storageState.cookies.length} 个 Cookie，保存于 ${savedDays} 天前）`, '', acc?.name);
      }

      const context = await browser.newContext({
        userAgent: PC_USER_AGENT,
        viewport: { width: 1366, height: 768 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        // 浏览器一定会带的客户端提示；Playwright 的 userAgent 选项不会设置它们，
        // 不补的话 UA 说 Chrome/150 而 Sec-CH-UA 说真实版本，等于自相矛盾。
        extraHTTPHeaders: {
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'sec-ch-ua': SEC_CH_UA,
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': PLATFORM.clientHint
        },
        ...(storageState ? { storageState } : {})
      });

      // 说明：这里刻意不再用 Object.defineProperty(navigator, 'webdriver', ...) 去「抹平」webdriver。
      // 配合 --disable-blink-features=AutomationControlled，Chromium 原生就返回 false，
      // 而那段 init script 会在 navigator 实例上凭空造出一个自有属性 getter ——
      // 真实浏览器上没有这个自有属性，反而成了更明显的自动化特征。

      // 无 GPU 的无头环境里 WebGL 会暴露 SwiftShader（软件渲染），
      // 与「Windows 桌面 Chrome」的身份矛盾，这里改成常见的核显标识。
      await context.addInitScript(() => {
        const VENDOR = 'Google Inc. (Intel)';
        const RENDERER = 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)';
        const patch = (proto) => {
          if (!proto || !proto.getParameter) return;
          const orig = proto.getParameter;
          proto.getParameter = function (p) {
            if (p === 37445) return VENDOR;  // UNMASKED_VENDOR_WEBGL
            if (p === 37446) return RENDERER; // UNMASKED_RENDERER_WEBGL
            return orig.call(this, p);
          };
          proto.getParameter.toString = () => orig.toString();
        };
        try {
          patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
          patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
        } catch {}
      });

      // 注入当前账号的完整 Cookie。
      // 只解析一次并使用安全注入：__Host- 走 URL 形式，其它 Cookie 走 .bing.com。
      // 若其中仍有 Chromium 不接受的项，逐个隔离，避免一整批登录态全部丢失。
      if (acc?.cookie) {
        const cookies = this.parseCookies(acc.cookie, '.bing.com');
        const added = await this.addCookiesSafely(context, cookies, acc?.name);
        if (added < cookies.length) {
          logger.log('🟡', `Cookie 注入完成 ${added}/${cookies.length} 项，其余无效项已跳过`, '', acc?.name);
        }
      }

      this.browser = browser;
      this.context = context;
      this.sessionAccount = acc || null;
      return { browser, context };
    } catch (e) {
      // 启动过程中失败也必须把锁还回去，否则后续所有浏览器任务都会被卡住
      if (browser) await browser.close().catch(() => {});
      this.releaseBrowserSlot();
      throw e;
    }
  }

  releaseBrowserSlot() {
    if (!this.slotHeld) return;
    this.slotHeld = false;
    browserSlotLock.release('rewards-browser');
  }

  /**
   * 新建页面并立即对齐指纹。
   *
   * Playwright 的 `newContext({ userAgent })` 只改 UA 头，不会改 Sec-CH-UA
   * 与 navigator.platform。这里用 CDP 的 setUserAgentOverride 把
   * UA / 客户端提示 / 平台一次性设成同一套身份（比在 JS 里覆写原型链更不易被识别，
   * 因为它保持原生实现，不留下 JS getter 特征）。
   */
  async createPage(context) {
    const page = await context.newPage();
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: PC_USER_AGENT,
        // 注意：CDP 的 acceptLanguage 是「语言列表」，不能带 q 权重，
        // 否则 navigator.languages 会变成 ["zh-CN","zh;q=0.9"] 这种畸形值。
        acceptLanguage: 'zh-CN,zh',
        platform: PLATFORM.navigator,
        userAgentMetadata: buildUserAgentMetadata()
      });
      // 保持会话引用，避免被回收后覆盖失效
      if (!this.cdpSessions) this.cdpSessions = [];
      this.cdpSessions.push(cdp);
    } catch (e) {
      // 指纹对齐失败不应该让整个任务挂掉，降级继续（只是可能留下版本不一致）
      logger.log('🟡', `浏览器指纹对齐失败，本次以默认指纹继续: ${e.message}`);
    }
    return page;
  }

  /**
   * 回收当前页面并新建一个，用于长流程（多轮搜索）中途释放渲染侧内存。
   *
   * 为什么需要：cn.bing.com 的搜索结果页每个都很大，同一标签页连续导航十几轮后，
   * 渲染进程的匿名内存（anon）只涨不落 —— 实测单轮任务峰值可达 1.8G。
   * 浏览器进程本身没泄漏，但「一个超长会话」会持续抬高水位。
   * 中途换页能把绝大部分渲染内存还给系统，同时 Cookie/localStorage 都在 context 上，不受影响。
   */
  /**
   * 在「当前已打开的浏览器上下文」里读取官网真实进度。
   *
   * 为什么需要它：搜索流程持有 browserSlotLock，而 getRewardsInfo()
   * 需要再启动一个 Chromium 才能读 /earn，两者会互相等待形成死锁
   * （表现为一直停在「第 1/N 轮 按下 Enter」，倒计时也不出现）。
   * 这里复用现有 context 发请求，不申请新锁。
   */
  async probeProgressInContext(context, acc) {
    if (!context) return null;
    let page = null;
    try {
      page = await context.newPage();
      await page.goto('https://rewards.bing.com/earn', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
      const html = await page.content();
      if (!html || html.length < 50000) return null;
      const text = String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
      // 优先用「必应搜索 x/y」这种进度行
      const m = text.match(/必应搜索[\s\S]{0,80}?(\d{1,3})\s*\/\s*(\d{1,3})/);
      if (m) {
        const progress = parseInt(m[1], 10);
        if (Number.isFinite(progress)) return progress;
      }
      return null;
    } catch {
      return null;
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  async recyclePage(context, accName = '当前账号') {
    try {
      if (this.page) {
        await this.page.close().catch(() => {});
      }
      // 关闭旧 CDP 会话引用，避免长期持有失效对象
      this.cdpSessions = [];
      const page = await this.createPage(context);
      this.page = page;
      logger.log('♻️', '已回收并重建页面，释放渲染侧累积内存', '', accName);
      return page;
    } catch (e) {
      logger.log('🟡', `页面回收失败（继续使用原页面）: ${e.message}`, '', accName);
      return this.page;
    }
  }

  /**
   * 用真实 Chromium 打开 rewards.bing.com/earn 并返回完整 HTML。
   *
   * 为什么必须用浏览器：实测纯 HTTP 客户端（Node https / axios）访问 /earn
   * 会被 307 重定向到 login.windows.net，拿不到任务数据；
   * 同一网络下用 Chrome 打开（无论是否带 Cookie）都返回 200 和完整页面。
   * 因此今日积分/连续签到/可领取/活动卡片必须走浏览器渲染路径。
   */
  async fetchPageHtml(acc, url) {
    const { browser, context, page } = await this.withTemporaryPage(acc, url);
    try {
      return await page.content();
    } finally {
      await context.close().catch(() => {});
      // 关键：必须关闭 browser 进程，否则每次同步都会泄漏一个 Chromium（数百 MB）
      await browser.close().catch(() => {});
    }
  }

  async fetchEarnPageHtml(acc) {
    return this.fetchPageHtml(acc, 'https://rewards.bing.com/earn');
  }

  /**
   * 启动一个临时浏览器上下文，导航到 url，返回 { context, page }。
   * 调用方负责 context.close()。共用 browserSlotLock，避免与搜索流程并发。
   */
  async withTemporaryPage(acc, url) {
    const slotOwner = `earn-page:${Date.now()}`;
    const gotSlot = await browserSlotLock.acquire(slotOwner, 180000);
    if (!gotSlot) throw new Error("浏览器资源正被其它任务占用，请稍后重试");
    let browser = null;
    let context = null;
    try {
      const executablePath = this.getExecutablePath();
      if (!executablePath) throw new Error('未检测到 Chromium');
      browser = await chromium.launch({
        executablePath,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-breakpad',
          '--disable-crash-reporter',
          '--renderer-process-limit=1'
        ]
      });
      context = await browser.newContext({
        userAgent: PC_USER_AGENT,
        viewport: { width: 1366, height: 768 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        extraHTTPHeaders: {
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'sec-ch-ua': SEC_CH_UA,
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': PLATFORM.clientHint
        }
      });
      if (acc?.cookie) {
        const cookies = this.parseCookies(acc.cookie, '.bing.com');
        await this.addCookiesSafely(context, cookies, acc?.name);
      }
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(err => {
        logger.log('🟡', `页面导航异常: ${err.message}`);
      });
      await page.waitForTimeout(3500);
      try {
        logger.log('🌐', `浏览器落地: ${page.url()} | 标题: ${await page.title()}`);
      } catch {}
      return { browser, context, page };
    } catch (e) {
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
      throw e;
    } finally {
      browserSlotLock.release(slotOwner);
    }
  }

  /**
   * 把当前浏览器状态（Cookie + localStorage）写回磁盘，供下次执行复用。
   *
   * 只在任务确实跑成功的路径上调用：失败路径写回会把半残的会话固化下来，
   * 反而让下一轮从一开始就处于坏状态。
   */
  async commitBrowserSession() {
    if (!this.context || !this.sessionAccount) return false;
    try {
      const state = await this.context.storageState();
      const cookieCount = Array.isArray(state?.cookies) ? state.cookies.length : 0;
      const ok = writeBrowserSession(this.sessionAccount, state);
      if (ok) {
        logger.log('💾', `浏览器会话已保存（${cookieCount} 个 Cookie），下次执行将复用`, '', this.sessionAccount.name);
      }
      return ok;
    } catch (e) {
      logger.log('🟡', `浏览器会话保存失败: ${e.message}`, '', this.sessionAccount?.name);
      return false;
    }
  }

  async closeBrowser() {
    try {
      if (this.context) await this.context.close().catch(() => {});
      if (this.browser) await this.browser.close().catch(() => {});
    } catch {}
    this.browser = null;
    this.context = null;
    this.page = null;
    this.cdpSessions = [];
    this.sessionAccount = null;
    this.releaseBrowserSlot();
    this.updateState({
      status: 'idle',
      activeAccountId: null,
      activeAccountName: '未启动',
      currentQuery: '',
      nextSearchIn: 0,
      memoryMB: 0,
      lastAction: '浏览器已彻底关闭，内存完全释放 (0 内存占用)'
    });
  }

  delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * 单次测试搜索 (仅搜 1 次，检验按键输入流与积分变化，完全安全无冷冻风险)
   */
  async singleTestSearch(acc) {
    const accName = acc?.name || '当前账号';
    logger.log('🔍', `启动无头浏览器执行「单次安全验证搜索」...`, '', accName);

    if (acc?.cookie && !acc.cookie.includes('_U=')) {
      logger.log('⚠️', `当前账号 [${accName}] 的 Cookie 中缺少关键标识 _U，必应搜索无法关联用户计分！请前往 cn.bing.com 登录后重新抓取完整 Cookie`, '', accName);
    }

    try {
      this.shouldStop = false;
      const { browser, context } = await this.launchBrowser(acc);
      const page = await this.createPage(context);
      this.page = page;

      this.updateState({
        status: 'navigating',
        lastAction: '正在访问微软必应首页 (cn.bing.com)...'
      });

      await page.goto('https://cn.bing.com', { waitUntil: 'domcontentloaded', timeout: 25000 });
      await this.delay(1500);

      const query = await rewardsApi.getHotSearchWord();
      this.updateState({
        status: 'typing',
        currentQuery: query,
        searchCount: 1,
        totalTarget: 1,
        lastAction: `正在模拟真人键盘打字键入: "${query}"...`
      });

      logger.log('⌨️', `拟人键盘打字检索: "${query}"`, '', accName);

      const searchInputSelector = '#sb_form_q';
      await page.waitForSelector(searchInputSelector, { timeout: 10000 });
      await page.click(searchInputSelector);
      await this.delay(300);

      // 模拟人类真实打字延迟 (每个字符 60~120ms)
      for (const char of query) {
        await page.type(searchInputSelector, char, { delay: rewardsApi.randomRange(60, 120) });
      }
      await this.delay(500);

      // 模拟回车提交搜索
      this.updateState({
        status: 'dwelling',
        lastAction: `按下 Enter 提交搜索，等待搜索结果渲染...`
      });
      await page.keyboard.press('Enter');

      // 等待搜索结果页面渲染
      await page.waitForTimeout(3500);

      // 模拟鼠标滚轮向下浏览
      this.updateState({
        lastAction: `模拟鼠标滚轮向下浏览搜索结果...`
      });
      await page.mouse.wheel(0, rewardsApi.randomRange(300, 700));
      await this.delay(3000);

      logger.log('✅', `单次搜索完成，正在验证积分与配额...`, '', accName);
      await this.commitBrowserSession();
      await this.closeBrowser();

      return {
        success: true,
        query,
        message: `单次搜索已成功完成！检索词: "${query}"`
      };
    } catch (e) {
      logger.log('🔴', `单次测试搜索失败: ${e.message}`, '', accName);
      await this.closeBrowser();
      throw e;
    }
  }

  /**
   * 平缓拉长模式：按全局「搜索节奏」设置（基础间隔 ± 随机浮动）完成 PC 搜索。
   * 执行窗口硬性限制为 3 小时（对应 4 小时时段抛去首小时随机启动）。
   */
  async runPacedSearch(acc, neededPoints, options = {}) {
    const accName = acc?.name || '当前账号';
    const { onProgress = null, probeProgress = null, stagnantLimit = 10 } = options;
    const totalSearches = Math.max(1, Math.min(Math.ceil(neededPoints / 3), 20));

    // 停滞保护：连续 N 次搜索官网进度都不涨，说明搜索额度已到顶或账号正在被限流，
    // 继续搜只会白白增加风控暴露面。达到阈值就主动停手，把本轮当部分完成收尾。
    const stagnation = new SearchStagnationGuard(stagnantLimit);

    // 全局搜索节奏（配置中心「任务与防风控」→ 搜索节奏设置）
    const cfg = configManager.get();
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    // 安全下限：基础间隔 ≥ 60 秒、随机浮动 ≥ 30 秒，避免过于密集触发风控
    const wantedIntervalSec = clamp(Number(cfg.tasks?.searchIntervalSec ?? 180) || 180, 60, 900);
    const jitterSec = clamp(Number(cfg.tasks?.searchJitterSec ?? 30) || 30, 30, 300);
    // 3 小时硬上限：任何情况下 次数 × (间隔 + 浮动) 不得超过 10800 秒
    const MAX_WINDOW_SEC = 3 * 3600;
    const perSearchBudget = Math.floor(MAX_WINDOW_SEC / totalSearches);
    const intervalSec = Math.max(60, Math.min(wantedIntervalSec, perSearchBudget - jitterSec));
    // 随机浮动为「只延后」的叠加模型：单次实际等待 = 基础间隔 + 0~浮动 秒
    const estimatedSec = totalSearches * (intervalSec + Math.floor(jitterSec / 2));
    const worstSec = totalSearches * (intervalSec + jitterSec);
    if (intervalSec < wantedIntervalSec) {
      logger.log('⚠️', `为保证 ${totalSearches} 次搜索在 3 小时内完成，本次间隔已自动压缩为 ${intervalSec} 秒 + 0~${jitterSec} 秒浮动`, '', accName);
    }

    if (acc?.cookie && !acc.cookie.includes('_U=')) {
      logger.log('⚠️', `当前账号 [${accName}] 的 Cookie 中缺少关键标识 _U，必应搜索无法关联用户计分！请在配置中心更新包含 _U 的完整 Cookie`, '', accName);
    }

    logger.log('🖥️', `启动 Playwright 拟人真机搜索：需补足 ${neededPoints} 分 → ${totalSearches} 次搜索，间隔 ${intervalSec} 秒 + 0~${jitterSec} 秒浮动，预计约 ${(estimatedSec/60).toFixed(0)} 分钟（最长 ${(worstSec/60).toFixed(0)} 分钟，上限 180 分钟）`, '', accName);

    this.shouldStop = false;
    let completed = 0;
    let stoppedByStagnation = false;

    try {
      const { browser, context } = await this.launchBrowser(acc);
      let page = await this.createPage(context);
      // 每处理 N 轮就换一次页面，避免长会话把渲染内存水位越抬越高
      const PAGE_RECYCLE_EVERY = 4;
      this.page = page;

      for (let i = 0; i < totalSearches; i++) {
        if (this.shouldStop) {
          logger.log('🛑', `搜索流程被用户手动中断`, '', accName);
          break;
        }

        const query = await rewardsApi.getHotSearchWord();
        completed++;

        this.updateState({
          status: 'navigating',
          currentQuery: query,
          searchCount: completed,
          totalTarget: totalSearches,
          pointsNeeded: neededPoints,
          nextSearchIn: 0,
          lastAction: `[第 ${completed}/${totalSearches} 轮] 正在打开必应主页...`
        });

        await page.goto('https://cn.bing.com', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await this.delay(rewardsApi.randomRange(1000, 2000));

        // 第一轮搜索前检测必应页面登录态，未登录时明确提示，避免空跑游客搜索
        if (i === 0) {
          try {
            const loginState = await page.evaluate(() => {
              const userEl = document.querySelector('#id_n, #id_a, .id_name');
              const signInBtn = document.querySelector('#id_s, #id_l, a[href*="account.live.com"], a[href*="login.live.com"]');
              return {
                userName: userEl ? (userEl.textContent || '').trim() : null,
                isGuest: !!signInBtn && !userEl
              };
            });
            if (loginState.isGuest) {
              logger.log('🟡', `账号 [${accName}] 打开必应搜索时未检测到登录身份（页面显示“登录”按钮），搜索可能无法累计积分！建议检查 Cookie 是否包含完整 _U 与会话标头`, '', accName);
            } else if (loginState.userName) {
              logger.log('👤', `必应搜索登录态确认: ${loginState.userName}`, accName);
            }
          } catch {}
        }

        this.updateState({
          status: 'typing',
          lastAction: `[第 ${completed}/${totalSearches} 轮] 正在模拟真人键盘键入: "${query}"...`
        });

        logger.log('🔍', `[搜索 ${completed}/${totalSearches}] 键入关键词: "${query}"`, '', accName);

        const searchInputSelector = '#sb_form_q';
        await page.waitForSelector(searchInputSelector, { timeout: 10000 });
        await page.click(searchInputSelector);
        await this.delay(200);

        for (const char of query) {
          await page.type(searchInputSelector, char, { delay: rewardsApi.randomRange(50, 110) });
        }
        await this.delay(400);

        this.updateState({
          status: 'dwelling',
          lastAction: `[第 ${completed}/${totalSearches} 轮] 按下 Enter，浏览搜索结果中...`
        });

        await page.keyboard.press('Enter');
        await page.waitForTimeout(rewardsApi.randomRange(3000, 6000));

        // 模拟浏览结果滚轮
        await page.mouse.wheel(0, rewardsApi.randomRange(350, 800));
        await this.delay(rewardsApi.randomRange(3000, 5000));

        // 每完成一次搜索就回调一次，让 WebUI 实时看到进度增长
        if (typeof onProgress === 'function') {
          try {
            onProgress(completed, totalSearches);
          } catch {}
        }

        // 停滞保护：探测官网真实进度，连续 N 次不涨就停手
        if (typeof probeProgress === 'function' && i < totalSearches - 1) {
          let official = null;
          // 优先复用当前浏览器上下文，避免与持有中的 browserSlotLock 死锁
          try {
            official = await this.probeProgressInContext(context, acc);
          } catch {}
          if (official === null) {
            try {
              official = await probeProgress();
            } catch {}
          }
          logger.log('📊', `第 ${completed}/${totalSearches} 轮后官网进度: ${official === null ? '未取到' : official + ' 分'}`, '', accName);
          const result = stagnation.observe(official);
          if (result.stagnant) {
            stoppedByStagnation = true;
            logger.log(
              '🛑',
              `连续 ${result.stagnantCount} 次搜索官网进度没有增加（停留在 ${result.bestProgress} 分），判定搜索额度已到顶，主动停止本轮搜索以免触发风控`,
              '',
              accName
            );
            break;
          }
        }

        // 如果已经是最后一次，不等待
        if (i === totalSearches - 1) break;

        // 长流程中途回收页面：降低渲染侧匿名内存峰值（Cookie/localStorage 在 context 上，不受影响）
        if ((i + 1) % PAGE_RECYCLE_EVERY === 0) {
          page = await this.recyclePage(context, accName);
        }

        // 计算下一次搜索的拟人休眠时间（基础间隔 + 0~浮动 秒）
        const waitSec = intervalSec + rewardsApi.randomRange(0, jitterSec);
        logger.log('⏳', `拟人呼吸间隔休眠：${(waitSec / 60).toFixed(1)} 分钟后执行第 ${completed + 1} 次搜索...`, '', accName);

        // 逐秒倒计时更新，便于 WebUI 前端实时显示倒计时
        for (let s = waitSec; s > 0; s--) {
          if (this.shouldStop) break;
          this.updateState({
            status: 'waiting',
            nextSearchIn: s,
            lastAction: `拟人呼吸休眠中 (倒计时 ${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')})`
          });
          await this.delay(1000);
        }
      }

      await this.commitBrowserSession();
      await this.closeBrowser();
      if (stoppedByStagnation) {
        logger.log('🛑', `账号 [${accName}] 因进度停滞提前结束，本轮共执行 ${completed} 次检索（未打满的额度留到下一轮）`, '', accName);
      } else {
        logger.log('🎉', `账号 [${accName}] 拟人平缓搜索完成！共执行 ${completed} 次检索`, '', accName);
      }
      return completed;
    } catch (e) {
      logger.log('🔴', `拟人搜索流程发生异常: ${e.message}`, '', accName);
      await this.closeBrowser();
      throw e;
    }
  }

  stop() {
    this.shouldStop = true;
    this.updateState({ status: 'stopped', lastAction: '正在中止浏览器任务...' });
  }

  /**
   * 完成任务区打孔卡 (Quest Punch Card)
   *
   * 这类任务（如「十月必看五大亮点」、「A 50-point Halloween treat」）
   * 包含激活按钮、多日搜索、立即可做的专题页面浏览或测验。
   * 机制重构：
   * 1. 自动识别页面内的「Activate quest（激活活动）」站内按钮，无需外链跳转；
   * 2. 循环遍历该打孔卡内「所有已解锁且尚未完成」的子活动，依序逐个完成；
   * 3. 避免以往因第一个子任务未满额（如 5 天打卡）而死锁拦截后续可用子任务的问题。
   */
  async runQuestPunchCards(acc, quests = []) {
    const accName = acc?.name || '当前账号';
    const pending = (quests || []).filter(q => q && !q.done);
    if (pending.length === 0) return { attempted: 0, completed: 0, details: [] };

    let attempted = 0;
    let completed = 0;
    const completedSteps = [];

    try {
      this.shouldStop = false;
      const { context } = await this.launchBrowser(acc);
      const page = await this.createPage(context);
      this.page = page;

      for (const quest of pending) {
        if (this.shouldStop) break;

        const questName = quest.title || quest.questId || '任务打孔卡';
        this.updateState({
          status: 'navigating',
          lastAction: `正在检查任务打孔卡「${questName}」...`
        });

        try {
          await page.goto(quest.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await this.delay(2500);
          const pageTitle = (await page.title().catch(() => '')) || questName;
          const displayName = pageTitle.replace(/\s*[–-]\s*Microsoft Rewards\s*$/i, '').trim() || questName;

          // 循环扫描并执行该打孔卡当前所有可用且未完成的子任务
          let roundAttempted = 0;
          const clickedUrls = new Set();

          while (!this.shouldStop) {
            // 提取该打孔卡内当前所有未完成、已解锁的子活动列表
            const subtasks = await page.evaluate(() => {
              const headings = [...document.querySelectorAll('h3')].filter(h => {
                const t = h.innerText.trim();
                return t && !t.includes('条款和条件') && !t.includes('Terms');
              });
              const items = [];
              for (let i = 0; i < headings.length; i++) {
                const h = headings[i];
                let container = h;
                while (container && container.parentElement && !container.parentElement.className.includes('grid') && container.parentElement.tagName !== 'MAIN') {
                  if (container.querySelector && container.querySelectorAll('h3').length === 1 && container.parentElement.querySelectorAll('h3').length > 1) {
                    break;
                  }
                  container = container.parentElement;
                }
                const rawText = container?.innerText || '';
                const isCompleted = rawText.includes('已完成')
                  || rawText.includes('Complete')
                  || rawText.includes('Completed')
                  || !!container?.querySelector('svg path[d*="2.919"]'); // 绿色对勾 SVG

                const links = [...(container?.querySelectorAll('a[href], button') || [])].filter(a => {
                  const disabled = a.getAttribute('aria-disabled') === 'true' || a.getAttribute('data-disabled') === 'true' || a.disabled;
                  if (disabled) return false;
                  const href = a.getAttribute('href') || '';
                  if (/\/account\/general|\/rewards\/about|\/rewards\/faq|\/rewards\/redeem/i.test(href)) return false;
                  if (a.closest('header') || a.closest('footer')) return false;
                  return true;
                });

                if (links.length > 0 && !isCompleted) {
                  const link = links[0];
                  link.setAttribute('data-msr-subtask', String(i + 1));
                  items.push({
                    index: i + 1,
                    title: h.innerText.trim(),
                    text: (link.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
                    href: link.getAttribute('href') || '',
                    tag: link.tagName
                  });
                }
              }
              return items;
            });

            // 寻找下一个尚未点击的子任务
            const target = subtasks.find(s => !clickedUrls.has(s.href || s.text || s.title));
            if (!target) {
              if (roundAttempted === 0) {
                logger.log('💤', `打孔卡「${displayName}」当前无待做任务或已全部完成，跳过`, '', accName);
              }
              break;
            }

            roundAttempted++;
            attempted++;
            const keyId = target.href || target.text || target.title;
            clickedUrls.add(keyId);

            const stepLabel = target.title || target.text || `第 ${target.index} 项`;
            logger.log('🧩', `执行打孔卡「${displayName}」子任务 [${target.index}]: ${stepLabel} (${target.text})`, '', accName);
            this.updateState({
              status: 'dwelling',
              lastAction: `正在完成打孔卡子任务: ${stepLabel}`
            });

            const beforeUrl = page.url();
            const newPagePromise = context.waitForEvent('page', { timeout: 6000 }).catch(() => null);

            const isActivate = /activate|激活/i.test(target.text) || /activate/i.test(target.title);

            try {
              await page.click(`[data-msr-subtask="${target.index}"]`, { timeout: 8000 });
            } catch {
              if (target.href && /^https?:\/\//i.test(target.href)) {
                const tempPage = await context.newPage().catch(() => null);
                if (tempPage) {
                  await tempPage.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
                  await this.delay(rewardsApi.randomRange(3000, 5000));
                  await tempPage.mouse.wheel(0, rewardsApi.randomRange(300, 600)).catch(() => {});
                  await this.delay(rewardsApi.randomRange(1500, 2500));
                  await tempPage.close().catch(() => {});
                }
              }
            }

            const newPage = await Promise.race([newPagePromise, this.delay(2500).then(() => null)]);
            if (newPage) {
              await newPage.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
              await this.delay(rewardsApi.randomRange(3500, 6000));
              await newPage.mouse.wheel(0, rewardsApi.randomRange(350, 800)).catch(() => {});
              await this.delay(rewardsApi.randomRange(2000, 3500));
              await newPage.close().catch(() => {});
              completed++;
              completedSteps.push({
                questId: quest.questId,
                title: displayName,
                stepName: stepLabel,
                at: Date.now()
              });
              logger.log('✅', `打孔卡「${displayName}」子任务已完成: ${stepLabel}`, '', accName);
              await this.delay(rewardsApi.randomRange(2000, 4000));
            } else {
              let landedUrl = '';
              try { landedUrl = String(page.url() || ''); } catch {}

              if (landedUrl !== beforeUrl && !landedUrl.includes(quest.questId)) {
                // 同标签页跳转到了外部任务页
                await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
                await this.delay(rewardsApi.randomRange(3500, 6000));
                await page.mouse.wheel(0, rewardsApi.randomRange(350, 800)).catch(() => {});
                await this.delay(rewardsApi.randomRange(2000, 3500));
                // 导航回打孔卡原页面，准备继续下一个子任务
                await page.goto(quest.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await this.delay(2000);
                completed++;
                completedSteps.push({
                  questId: quest.questId,
                  title: displayName,
                  stepName: stepLabel,
                  at: Date.now()
                });
                logger.log('✅', `打孔卡「${displayName}」子任务已完成: ${stepLabel}`, '', accName);
                await this.delay(rewardsApi.randomRange(2000, 4000));
              } else if (isActivate) {
                // 站内激活操作：等待状态写入后刷新校验
                await this.delay(3000);
                await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
                await this.delay(2000);
                completed++;
                completedSteps.push({
                  questId: quest.questId,
                  title: displayName,
                  stepName: '激活任务 (Activate quest)',
                  at: Date.now()
                });
                logger.log('✅', `打孔卡「${displayName}」活动激活成功`, '', accName);
                await this.delay(rewardsApi.randomRange(2000, 3500));
              } else {
                // 既无新标签页也无跳转且非激活：平缓等待
                await this.delay(2500);
              }
            }
          }
        } catch (e) {
          logger.log('🟡', `打孔卡「${questName}」处理失败: ${e.message}`, '', accName);
        }
      }

      await this.commitBrowserSession();
      await this.closeBrowser();
    } catch (e) {
      logger.log('🔴', `打孔卡任务流程异常: ${e.message}`, '', accName);
      await this.closeBrowser();
    }

    return { attempted, completed, details: completedSteps };
  }

﻿  /**
   * 打开 /dashboard，点击「可领取」卡片并完成领取。
   * 返回实际领取到的积分；未找到可领取入口时返回 0。
   *
   * 注意：真实页面卡片结构是
   *   <p class="text-labelControl">可领取</p>
   *   <p class="text-pageHeader">3</p>
   *   <p class="text-metadata">领取</p>
   * 按钮不一定带「可领取」文案，因此要按多种选择器依次尝试。
   */
  async claimDashboardPoints(acc) {
    const accName = acc?.name || '当前账号';
    const execPath = this.getExecutablePath();
    if (!execPath) return 0;

    let claimed = 0;
    try {
      const { context } = await this.launchBrowser(acc);
      const page = await this.createPage(context);
      await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(4000);

      // 先从页面读取「可领取 N」
      let pts = 0;
      try {
        const text = await page.evaluate(() => {
          const nodes = [...document.querySelectorAll('p')];
          const label = nodes.find(n => (n.textContent || '').trim() === '可领取');
          if (!label) return '';
          let box = label;
          for (let i = 0; i < 5 && box; i++) {
            const head = box.querySelector && box.querySelector('p.text-pageHeader');
            if (head) return head.textContent || '';
            box = box.parentElement;
          }
          return '';
        });
        const m = String(text || '').match(/(\d[\d,]*)/);
        if (m) pts = parseInt(m[1].replace(/,/g, ''), 10) || 0;
      } catch {}

      logger.log('🎁', `账号 [${accName}] 检测到待领取积分: ${pts}（页面结构未命中时为 0）`, '', accName);
      if (pts <= 0) {
        await this.closeBrowser();
        return 0;
      }

      // 依次尝试多种可点击入口
      const candidates = [
        page.getByRole('button', { name: /领取|可领取/ }).first(),
        page.locator('button').filter({ hasText: /领取|可领取/ }).first(),
        page.locator('a').filter({ hasText: /领取|可领取/ }).first(),
        page.locator('[role="button"]').filter({ hasText: /领取|可领取/ }).first()
      ];

      let clicked = false;
      for (const locator of candidates) {
        try {
          if ((await locator.count()) > 0 && await locator.isVisible().catch(() => false)) {
            await locator.click({ timeout: 8000 });
            clicked = true;
            logger.log('🎁', `已点击领取入口`, '', accName);
            break;
          }
        } catch {}
      }
      if (!clicked) {
        logger.log('🟡', `未找到可点击的领取入口（页面显示 ${pts} 分待领）`, '', accName);
      }

      // 处理确认弹窗：只点一次，之后只等待页面刷新。
      // 旧实现循环 5 轮、每轮都点一次并打印「领取成功」，导致重复领取与日志刷屏。
      await page.waitForTimeout(2500);
      const confirmCandidates = [
        page.locator('div[role="dialog"] button').last(),
        page.getByRole('button', { name: /领取积分|确认领取|确认/ }).last(),
        page.locator('button').filter({ hasText: /领取积分|确认/ }).last()
      ];
      let confirmClicked = false;
      for (const locator of confirmCandidates) {
        try {
          if ((await locator.count()) > 0 && await locator.isVisible().catch(() => false)) {
            await locator.click({ timeout: 6000 });
            confirmClicked = true;
            logger.log('✅', `已点击确认领取`, '', accName);
            break;
          }
        } catch {}
      }
      if (!confirmClicked) {
        logger.log('🟡', '未出现确认弹窗（可能已直接领取）', '', accName);
      }

      // 唯一的成功判据：页面上的「可领取」归零
      await page.waitForTimeout(4000);
      let remaining = null;
      try {
        const text = await page.evaluate(() => {
          const nodes = [...document.querySelectorAll('p')];
          const label = nodes.find(n => (n.textContent || '').trim() === '可领取');
          if (!label) return null;
          let box = label;
          for (let i = 0; i < 5 && box; i++) {
            const head = box.querySelector && box.querySelector('p.text-pageHeader');
            if (head) return head.textContent || null;
            box = box.parentElement;
          }
          return null;
        });
        const m = String(text || '').match(/(\d[\d,]*)/);
        if (m) remaining = parseInt(m[1].replace(/,/g, ''), 10);
      } catch {}

      if (remaining === 0) {
        claimed = pts;
        logger.log('🎉', `领取成功 +${pts} 分（页面已归零）`, '', accName);
      } else if (remaining !== null) {
        logger.log('🟡', `领取后仍显示 ${remaining} 分待领，未计入`, '', accName);
      } else {
        logger.log('🟡', `未能读取领取后的状态，按未领取处理`, '', accName);
      }

      await this.commitBrowserSession();
      await this.closeBrowser();
    } catch (e) {
      logger.log('🟡', `账号 [${accName}] 领取待领积分异常: ${e.message}`, '', accName);
      await this.closeBrowser();
    }
    return claimed;
  }

}

export const browserManager = new BrowserManager();
export default browserManager;

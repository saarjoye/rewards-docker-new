import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DATA_DIR, writeFileAtomic } from './fsUtil.js';
import { removeBrowserSession } from './core/browserSession.js';

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// GET /api/config 不再向前端下发凭据明文；前端保存时回传该占位符表示「保持不变」
export const SECRET_PLACEHOLDER = '__MSR_SECRET_KEEP__';
export const SECRET_CLEAR = '__MSR_SECRET_CLEAR__';
const SECRET_ACCOUNT_FIELDS = ['cookie', 'authCodeUrl', 'refreshToken', 'accessToken'];

const DEFAULT_CONFIG = {
  accounts: [
    {
      id: 'acc_1',
      name: '默认账号',
      order: 1,
      enabled: true,
      cookie: '',
      authCodeUrl: '',
      refreshToken: '',
      accessToken: '',
      tokenTime: 0,
      timeSlot: {
        startHour: 9,
        endHour: 13,
        randomDelayMin: 60,
        durationHours: 2
      },
      authDiagnosis: null
    }
  ],
  account: {
    cookie: '',
    authCodeUrl: '',
    refreshToken: '',
    accessToken: '',
    tokenTime: 0
  },
  network: {
    useProxy: false,
    proxyUrl: '',
    lockRegion: true
  },
  tasks: {
    sign: true,
    read: true,
    search: true,
    promos: true,
    desktopApp: true,
    dailySet: true,
    searchIntervalSec: 180, // 全局搜索节奏：每次搜索基础间隔（秒）
    searchJitterSec: 30,    // 全局搜索节奏：每次随机浮动（±秒）
    searchStagnantLimit: 10, // 停滞保护：连续多少次搜索官网进度不涨就主动停手
    searchApi: 'baidu.official', // 'offline' | 'baidu.official' | 'hot.nntool.cc' | 'hot.cnxiaobai.com'
    searchEngineMode: 'browser', // 'browser' (Playwright 真机拟人) | 'http' (轻量HTTP)
    keepRunning: true // 全部完成后，手动再次执行时是否仍完整跑一遍（定时任务每账号每天只排一次）
  },
  schedule: {
    enabled: true,
    cron: '*/25 * * * *'
  },
  notify: {
    wework: '',
    // 企业微信应用消息（与上面的群机器人 Webhook 相互独立，保留旧配置兼容）
    weworkApp: {
      enabled: false,
      baseUrl: '',
      corpId: '',
      agentId: '',
      secret: '',
      toUser: '@all',
      maxRetries: 5
    },
    dingding: '',
    feishu: '',
    pushme: '',
    bark: '',
    telegram: {
      botToken: '',
      chatId: ''
    }
  },
  ui: {
    theme: 'auto'
  },
  epic: {
    enabled: true,
    checkIntervalMin: 30, // 检查间隔（分钟）：到点先查有没有新免费游戏，有才领取
    retryCount: 2,        // 单个游戏领取失败后的重试次数
    retryIntervalSec: 60, // 失败重试间隔（秒）
    accountGapSec: 20,    // 不同账号之间的操作间隔（秒）
    accounts: [],
    claimRecords: []
  },
  server: {
    port: 5308,
    // 旧版 HTTP Basic 密码：保留字段用于兼容已有部署，不再向 WebUI 下发明文
    authPassword: '',
    // 首次访问时创建的管理员账号；密码使用 scrypt 加盐哈希保存
    auth: {
      username: '',
      passwordHash: '',
      salt: '',
      sessionSecret: '',
      createdAt: 0
    }
  }
};

class ConfigManager {
  constructor() {
    this.config = null;
    this.ensureDataDir();
    this.load();
  }

  ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  extractUserNameFromCookie(cookie = '') {
    if (!cookie) return '';
    // 尝试从 WLS=C=...&N=%e8%b4%ba%e5%bc%ba 提取用户名
    const wlsMatch = cookie.match(/WLS=[^;]*?N=([^;&]+)/i);
    if (wlsMatch) {
      try {
        return decodeURIComponent(wlsMatch[1]);
      } catch {}
    }
    return '';
  }

  load() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        this.config = this.mergeDeep(structuredClone(DEFAULT_CONFIG), parsed);
        // 平滑迁移旧版单账号数据到 accounts 列表
        this.migrateLegacyAccount(parsed);
        // 旧版默认时段（6-10 / 10-14 / 14-18 / 18-22）迁移到新默认时段
        this.migrateTimeSlots();
      } else {
        this.config = structuredClone(DEFAULT_CONFIG);
        this.save();
      }
    } catch (e) {
      console.error('[Config] 读取配置文件失败，将使用默认配置:', e.message);
      this.config = structuredClone(DEFAULT_CONFIG);
    }
    return this.config;
  }

  getDefaultTimeSlot(index = 0) {
    const slots = [
      { startHour: 9, endHour: 13 },
      { startHour: 13, endHour: 17 },
      { startHour: 17, endHour: 21 },
      { startHour: 21, endHour: 1 }
    ];
    const s = slots[index % slots.length];
    return {
      startHour: s.startHour,
      endHour: s.endHour,
      randomDelayMin: 60,
      durationHours: 2
    };
  }

  migrateLegacyAccount(parsed) {
    if (!Array.isArray(parsed.accounts) || parsed.accounts.length === 0) {
      const legacy = parsed.account || {};
      const extractedName = this.extractUserNameFromCookie(legacy.cookie);
      this.config.accounts = [
        {
          id: 'acc_1',
          name: extractedName ? `主账号 (${extractedName})` : '主账号',
          enabled: true,
          cookie: legacy.cookie || '',
          authCodeUrl: legacy.authCodeUrl || '',
          refreshToken: legacy.refreshToken || '',
          accessToken: legacy.accessToken || '',
          tokenTime: legacy.tokenTime || 0,
          timeSlot: this.getDefaultTimeSlot(0)
        }
      ];
      this.save();
    } else {
      this.config.accounts = parsed.accounts.map((acc, i) => ({
        ...acc,
        timeSlot: acc.timeSlot || this.getDefaultTimeSlot(i)
      }));
    }

    // 同步第一个账号到 config.account 以保持向后兼容
    if (this.config.accounts.length > 0) {
      const first = this.config.accounts[0];
      this.config.account = {
        cookie: first.cookie || '',
        authCodeUrl: first.authCodeUrl || '',
        refreshToken: first.refreshToken || '',
        accessToken: first.accessToken || '',
        tokenTime: first.tokenTime || 0
      };
    }
  }

  /**
   * 把旧版默认时段迁移到新版默认时段（9-13 / 13-17 / 17-21 / 21-次日01）。
   * 只迁移「仍是旧默认值」的账号；用户手动设置过的自定义时段保持原样，
   * 避免升级后把用户有意配置的作息覆盖掉。
   */
  migrateTimeSlots() {
    const LEGACY_DEFAULTS = new Map([
      ['6-10', { startHour: 9, endHour: 13 }],
      ['10-14', { startHour: 13, endHour: 17 }],
      ['14-18', { startHour: 17, endHour: 21 }],
      ['18-22', { startHour: 21, endHour: 1 }]
    ]);
    if (!Array.isArray(this.config.accounts)) return;

    let changed = false;
    for (const acc of this.config.accounts) {
      const slot = acc?.timeSlot;
      if (!slot || slot.startHour === undefined) continue;
      const next = LEGACY_DEFAULTS.get(`${Number(slot.startHour)}-${Number(slot.endHour)}`);
      if (!next) continue;
      acc.timeSlot = {
        ...slot,
        startHour: next.startHour,
        endHour: next.endHour
      };
      changed = true;
    }
    if (changed) this.save();
  }

  save() {
    try {
      this.ensureDataDir();
      // 保持 config.account 与 accounts[0] 同步
      if (Array.isArray(this.config.accounts) && this.config.accounts.length > 0) {
        const first = this.config.accounts[0];
        this.config.account = {
          cookie: first.cookie || '',
          authCodeUrl: first.authCodeUrl || '',
          refreshToken: first.refreshToken || '',
          accessToken: first.accessToken || '',
          tokenTime: first.tokenTime || 0
        };
      }
      // 原子写入 + 权限收紧（配置里含明文 Cookie / Refresh Token）
      writeFileAtomic(CONFIG_FILE, JSON.stringify(this.config, null, 2), { encoding: 'utf-8', mode: 0o600 });
      try {
        fs.chmodSync(CONFIG_FILE, 0o600);
      } catch {}
      return true;
    } catch (e) {
      console.error('[Config] 保存配置文件失败:', e.message);
      return false;
    }
  }

  get() {
    if (!this.config) {
      this.load();
    }
    return this.config;
  }

  getAccounts() {
    const cfg = this.get();
    const list = cfg.accounts || [];
    return list.slice().sort((a, b) => {
      const orderA = Number.isFinite(Number(a.order)) ? Number(a.order) : 999;
      const orderB = Number.isFinite(Number(b.order)) ? Number(b.order) : 999;
      return orderA - orderB;
    });
  }

  getAccount(accountId) {
    const accounts = this.getAccounts();
    if (!accountId) return accounts[0] || null;
    return accounts.find(a => a.id === accountId) || accounts[0] || null;
  }

  /**
   * 精确查找账号，找不到返回 null。
   * 注意：getAccount() 在 id 不存在时会回退到第一个账号，写入类操作必须用这个方法，
   * 否则一个不存在的 id 会静默改到第一个账号上（历史 bug：配置向导换 Token 覆盖主账号）。
   */
  findAccount(accountId) {
    if (!accountId) return null;
    return this.getAccounts().find(a => a.id === accountId) || null;
  }

  /**
   * 解析账号：不传 id 时返回第一个账号（兼容单账号调用），
   * 传了 id 则必须精确命中，否则返回 null。
   * 所有「按 id 操作某个账号」的地方都应该用这个，而不是 getAccount()。
   */
  resolveAccount(accountId) {
    if (!accountId) return this.getAccounts()[0] || null;
    return this.findAccount(accountId);
  }

  upsertAccount(accountData) {
    const cfg = this.get();
    if (!Array.isArray(cfg.accounts)) cfg.accounts = [];

    const id = accountData.id || `acc_${Date.now()}`;
    const idx = cfg.accounts.findIndex(a => a.id === id);

    // 如果没有填名字但有 cookie，尝试提取名字
    let name = accountData.name;
    if (!name && accountData.cookie) {
      const extracted = this.extractUserNameFromCookie(accountData.cookie);
      name = extracted ? `账号 (${extracted})` : `账号 ${cfg.accounts.length + 1}`;
    }

    if (idx !== -1) {
      const existing = cfg.accounts[idx];
      let timeSlot = accountData.timeSlot || existing.timeSlot || this.getDefaultTimeSlot(idx);
      if (accountData.timeSlot?.startHour !== undefined) {
        const sh = Number(accountData.timeSlot.startHour);
        timeSlot = {
          startHour: sh,
          endHour: (sh + 4) % 24,
          randomDelayMin: Number(accountData.timeSlot.randomDelayMin) || 60,
          durationHours: Number(accountData.timeSlot.durationHours) || 2
        };
      }
      const order = accountData.order !== undefined ? Number(accountData.order) : (existing.order || idx + 1);
      const mergedSecrets = { ...accountData };
      for (const field of SECRET_ACCOUNT_FIELDS) {
        if (mergedSecrets[field] === SECRET_CLEAR || mergedSecrets[field] === null) {
          mergedSecrets[field] = '';
        } else if (mergedSecrets[field] === SECRET_PLACEHOLDER || mergedSecrets[field] === '') {
          mergedSecrets[field] = existing[field] || '';
        }
        delete mergedSecrets[`has${field.charAt(0).toUpperCase()}${field.slice(1)}`];
      }
      cfg.accounts[idx] = {
        ...existing,
        ...mergedSecrets,
        name: name || existing.name,
        order,
        timeSlot
      };
    } else {
      const newIdx = cfg.accounts.length;
      let timeSlot = accountData.timeSlot || this.getDefaultTimeSlot(newIdx);
      if (accountData.timeSlot?.startHour !== undefined) {
        const sh = Number(accountData.timeSlot.startHour);
        timeSlot = {
          startHour: sh,
          endHour: (sh + 4) % 24,
          randomDelayMin: Number(accountData.timeSlot.randomDelayMin) || 60,
          durationHours: Number(accountData.timeSlot.durationHours) || 2
        };
      }
      const order = accountData.order !== undefined ? Number(accountData.order) : (newIdx + 1);
      cfg.accounts.push({
        id,
        name: name || `账号 ${newIdx + 1}`,
        order,
        enabled: accountData.enabled !== false,
        cookie: accountData.cookie || '',
        authCodeUrl: accountData.authCodeUrl || '',
        refreshToken: accountData.refreshToken || '',
        accessToken: accountData.accessToken || '',
        tokenTime: accountData.tokenTime || 0,
        timeSlot,
        authDiagnosis: accountData.authDiagnosis || null
      });
    }

    this.save();
    return this.getAccount(id);
  }

  deleteAccount(accountId) {
    const cfg = this.get();
    if (!Array.isArray(cfg.accounts)) return false;
    if (cfg.accounts.length <= 1) {
      throw new Error('至少需要保留一个账号');
    }
    cfg.accounts = cfg.accounts.filter(a => a.id !== accountId);
    // 账号被删掉后，它的浏览器会话（含登录 Cookie）不应该继续留在磁盘上
    removeBrowserSession(accountId);
    this.save();
    return true;
  }

  // ===== Epic 免费游戏账号 =====

  getEpicAccounts() {
    const list = this.get().epic?.accounts || [];
    return list.slice().sort((a, b) => {
      const oa = Number.isFinite(Number(a.order)) ? Number(a.order) : 999;
      const ob = Number.isFinite(Number(b.order)) ? Number(b.order) : 999;
      return oa - ob;
    });
  }

  findEpicAccount(id) {
    if (!id) return null;
    return (this.get().epic?.accounts || []).find(a => a.id === id) || null;
  }

  upsertEpicAccount(data = {}) {
    const cfg = this.get();
    if (!cfg.epic) cfg.epic = { enabled: true, autoClaimHour: 10, accounts: [], claimRecords: [] };
    if (!Array.isArray(cfg.epic.accounts)) cfg.epic.accounts = [];

    const id = data.id || `epic_${Date.now()}`;
    const idx = cfg.epic.accounts.findIndex(a => a.id === id);
    if (idx !== -1) {
      cfg.epic.accounts[idx] = { ...cfg.epic.accounts[idx], ...data, id };
    } else {
      cfg.epic.accounts.push({
        id,
        name: data.name || `Epic 账号 ${cfg.epic.accounts.length + 1}`,
        order: data.order !== undefined ? Number(data.order) : cfg.epic.accounts.length + 1,
        enabled: data.enabled !== false,
        storageState: data.storageState || null,
        sessionValid: data.sessionValid ?? null,
        lastVerifyAt: data.lastVerifyAt || 0,
        lastVerifyMessage: data.lastVerifyMessage || '',
        lastSessionImportAt: data.lastSessionImportAt || 0,
        lastClaimAt: data.lastClaimAt || 0,
        lastClaimMessage: data.lastClaimMessage || '',
        handledGames: data.handledGames || {}
      });
    }
    this.save();
    return this.findEpicAccount(id);
  }

  updateEpicAccount(id, patch = {}) {
    const acc = this.findEpicAccount(id);
    if (!acc) return null;
    Object.assign(acc, patch, { id: acc.id });
    this.save();
    return acc;
  }

  deleteEpicAccount(id) {
    const cfg = this.get();
    if (!cfg.epic?.accounts) return false;
    const before = cfg.epic.accounts.length;
    cfg.epic.accounts = cfg.epic.accounts.filter(a => a.id !== id);
    if (cfg.epic.accounts.length === before) return false;
    try {
      const safeId = String(id || '').replace(/[^A-Za-z0-9_-]/g, '_');
      fs.rmSync(path.join(DATA_DIR, 'epic-profiles', safeId), { recursive: true, force: true });
    } catch {}
    this.save();
    return true;
  }

  appendEpicClaimRecords(records = []) {
    const cfg = this.get();
    if (!cfg.epic) cfg.epic = { accounts: [], claimRecords: [] };
    if (!Array.isArray(cfg.epic.claimRecords)) cfg.epic.claimRecords = [];
    cfg.epic.claimRecords.unshift(...records);
    if (cfg.epic.claimRecords.length > 60) cfg.epic.claimRecords.length = 60;
    this.save();
  }

  getEpicClaimRecords(limit = 20) {
    return (this.get().epic?.claimRecords || []).slice(0, limit);
  }

  /**
   * 读取管理员登录信息（含哈希与盐，仅限服务端内部使用）
   */
  getAdminAuth() {
    const auth = this.get().server?.auth || {};
    return {
      username: auth.username || '',
      passwordHash: auth.passwordHash || '',
      salt: auth.salt || '',
      sessionSecret: auth.sessionSecret || '',
      createdAt: Number(auth.createdAt) || 0
    };
  }

  /**
   * 保存管理员登录信息。此方法只应由服务端认证接口调用，
   * 通用配置接口 /api/config 不允许修改这些字段。
   */
  setAdminAuth(data = {}) {
    const cfg = this.get();
    if (!cfg.server) cfg.server = {};
    cfg.server.auth = {
      username: data.username || '',
      passwordHash: data.passwordHash || '',
      salt: data.salt || '',
      sessionSecret: data.sessionSecret || '',
      createdAt: Number(data.createdAt) || Date.now()
    };
    this.save();
    return this.getAdminAuth();
  }

  /**
   * 确保会话签名密钥存在；不存在时自动生成并落盘。
   */
  ensureAdminSessionSecret() {
    const cfg = this.get();
    const existing = cfg.server?.auth?.sessionSecret;
    if (existing) return existing;
    if (!cfg.server) cfg.server = {};
    if (!cfg.server.auth) cfg.server.auth = {};
    cfg.server.auth.sessionSecret = crypto.randomBytes(32).toString('hex');
    this.save();
    return cfg.server.auth.sessionSecret;
  }

  update(partial) {
    if (!this.config) {
      this.load();
    }

    // 先深拷贝：mergeDeep 会改写传入对象，直接操作会把 express 的 req.body 也改掉
    const patch = structuredClone(partial || {});

    // 管理员登录字段只能通过认证接口写入，禁止通用配置接口覆盖
    if (patch.server && typeof patch.server === 'object') {
      delete patch.server.auth;
      delete patch.server.authPassword;
    }

    // 企业微信应用 Secret 属于凭据：前端留空或回传占位符时保留服务端原值
    if (patch.notify?.weworkApp && typeof patch.notify.weworkApp === 'object') {
      const existingSecret = this.config.notify?.weworkApp?.secret || '';
      const incomingSecret = patch.notify.weworkApp.secret;
      if (incomingSecret === SECRET_CLEAR || incomingSecret === null) {
        patch.notify.weworkApp.secret = '';
      } else if (incomingSecret === SECRET_PLACEHOLDER || incomingSecret === '') {
        patch.notify.weworkApp.secret = existingSecret;
      }
    }

    // 如果更新的是单账号字段 account，同步更新到第一个账号或指定账号
    if (patch.account && Array.isArray(this.config.accounts) && this.config.accounts.length > 0) {
      const targetId = patch.accountId || this.config.accounts[0].id;
      const idx = this.config.accounts.findIndex(a => a.id === targetId);
      if (idx !== -1) {
        Object.assign(this.config.accounts[idx], patch.account);
      }
    }

    if (Array.isArray(patch.accounts)) {
      if (patch.accounts.length === 0) {
        // 保护：前端 currentConfig 未加载完成时会上报空数组，
        // 直接覆盖会把所有账号连同 Cookie/Token 一起清空。
        console.error('[Config] 拒绝空的 accounts 更新，已保留原有账号');
      } else {
        // 前端拿到的是脱敏后的账号列表，回传占位符时保留服务端原值
        this.config.accounts = patch.accounts.map((acc, idx) => {
          const existing = this.config.accounts.find(a => a.id === acc.id) || this.config.accounts[idx] || {};
          const merged = { ...acc };
          for (const field of SECRET_ACCOUNT_FIELDS) {
            if (merged[field] === SECRET_CLEAR || merged[field] === null) {
              merged[field] = '';
            } else if (merged[field] === SECRET_PLACEHOLDER || merged[field] === '') {
              // 占位符或空值都视为「未改动」：前端不会拿到明文，也就不可能回传明文
              merged[field] = existing[field] || '';
            }
            // 去掉 getPublicConfig() 附加的 hasXxx 派生标记，避免污染落盘配置
            delete merged[`has${field.charAt(0).toUpperCase()}${field.slice(1)}`];
          }
          return merged;
        });
      }
      delete patch.accounts;
    }

    this.config = this.mergeDeep(this.config, patch);
    this.save();
    return this.config;
  }

  /**
   * 保存一次账号体检结果（供账号卡片展示有效/失效与上次检测时间）
   */
  recordAuthDiagnosis(accountId, diagnosis) {
    const acc = this.findAccount(accountId);
    if (!acc) return null;
    acc.authDiagnosis = {
      checkedAt: Date.now(),
      cookieValid: !!diagnosis.cookieValid,
      tokenValid: !!diagnosis.tokenValid,
      overallValid: !!diagnosis.overallValid,
      warning: !!diagnosis.warning,
      warningMessage: diagnosis.warningMessage || '',
      balance: Number(diagnosis.balance || 0),
      cookieMessage: diagnosis.cookieMessage || '',
      tokenMessage: diagnosis.tokenMessage || '',
      identityMatch: ['match', 'mismatch', 'unknown'].includes(diagnosis.identityMatch)
        ? diagnosis.identityMatch
        : 'unknown',
      sameAccount: diagnosis.sameAccount === true ? true : (diagnosis.sameAccount === false ? false : null),
      identityMessage: diagnosis.identityMessage || '',
      matchMethod: diagnosis.matchMethod || 'identity'
    };
    this.save();
    return acc.authDiagnosis;
  }

  /**
   * 生成用于下发到前端的脱敏配置（凭据替换为占位符，但保留是否有值的标记）
   */
  getPublicConfig() {
    const cfg = structuredClone(this.get());
    if (Array.isArray(cfg.accounts)) {
      cfg.accounts = cfg.accounts.map(acc => {
        for (const field of SECRET_ACCOUNT_FIELDS) {
          acc[`has${field.charAt(0).toUpperCase()}${field.slice(1)}`] = !!acc[field];
          acc[field] = acc[field] ? SECRET_PLACEHOLDER : '';
        }
        return acc;
      });
    }
    if (cfg.account && typeof cfg.account === 'object') {
      for (const field of SECRET_ACCOUNT_FIELDS) {
        cfg.account[field] = cfg.account[field] ? SECRET_PLACEHOLDER : '';
      }
    }
    // 企业微信应用 Secret 不下发明文，同时告诉前端是否已经保存过 Secret
    if (cfg.notify?.weworkApp && typeof cfg.notify.weworkApp === 'object') {
      cfg.notify.weworkApp.hasSecret = !!cfg.notify.weworkApp.secret;
      cfg.notify.weworkApp.secret = cfg.notify.weworkApp.secret ? SECRET_PLACEHOLDER : '';
    }
    // 登录账号的密码哈希、盐值和旧版 Basic 密码都属于敏感信息
    if (cfg.server && typeof cfg.server === 'object') {
      const auth = cfg.server.auth || {};
      cfg.server.auth = {
        username: auth.username || '',
        createdAt: auth.createdAt || 0,
        initialized: !!(auth.passwordHash && auth.salt)
      };
      cfg.server.authPassword = '';
    }
    // Epic 会话同样属于凭据，不能下发到前端
    if (cfg.epic && Array.isArray(cfg.epic.accounts)) {
      cfg.epic.accounts = cfg.epic.accounts.map(acc => {
        const hasSession = !!(acc.storageState && Array.isArray(acc.storageState.cookies) && acc.storageState.cookies.length);
        return { ...acc, hasSession, storageState: hasSession ? SECRET_PLACEHOLDER : null };
      });
    }
    return cfg;
  }

  mergeDeep(target, source) {
    if (!source || typeof source !== 'object') return target;
    for (const key of Object.keys(source)) {
      if (source[key] instanceof Object && !Array.isArray(source[key]) && key in target) {
        Object.assign(source[key], this.mergeDeep(target[key], source[key]));
      }
    }
    Object.assign(target || {}, source);
    return target;
  }
}

export const configManager = new ConfigManager();
export default configManager;

import fs from 'fs';
import path from 'path';
import configManager from '../config.js';
import logger from '../logger.js';
import rewardsApi from './api.js';
import authManager from './auth.js';
import notifier from './notifier.js';
import historyManager from './history.js';
import browserManager from './browser.js';
import { accountContextLock } from './contextLock.js';
import { SearchStagnationGuard, normalizeStagnantLimit } from './searchStagnation.js';
import memorySampler from './memorySampler.js';
import { DATA_DIR, writeFileAtomic } from '../fsUtil.js';

const STATS_FILE = path.join(DATA_DIR, 'stats.json');

export class TaskManager {
  constructor() {
    this.running = false;
    this.runningAccountId = null;
    this.lastUnifiedReportDate = 0;
    this.stats = this.loadStats();
  }

  getTodayNum() {
    const d = new Date();
    return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
  }

  createDefaultAccountStats(id = 'acc_1', name = '默认账号') {
    return {
      id,
      name,
      date: this.getTodayNum(),
      balance: 0,
      startBalance: 0,
      earned: 0,
      claimablePoints: 0,
      streakDays: 0,
      stamps: { progress: 0, max: 12 },
      lastUpdate: Date.now(),
      tasks: {
        sign: { name: "每日双端签入 (PC+App)", progress: 0, max: 1, points: 0, unit: "次", icon: "📱", done: false },
        read: { name: "新闻资讯自动阅读", progress: 0, max: 30, points: 0, unit: "篇", icon: "📖", done: false },
        search: { name: "必应 PC 搜索任务", progress: 0, max: 60, points: 0, unit: "分", icon: "🔍", done: false },
        dailySet: { name: "每日活动集 (Daily Set)", progress: 0, max: 3, points: 0, unit: "个", icon: "📅", done: false },
        promos: { name: "活动卡片与 Quiz 问答", progress: 0, max: 1, points: 0, unit: "项", icon: "🧩", done: false },
        desktopApp: { name: "桌面应用每周专属任务", progress: 0, max: 8, points: 20, unit: "个任务", icon: "🖥️", expiresText: "", available: false, done: false, stepLogs: [], isPunchCard: true }
      }
    };
  }

  loadStats() {
    const today = this.getTodayNum();
    const accountsCfg = configManager.getAccounts();
    const defaultAcc = accountsCfg[0] || { id: 'acc_1', name: '主账号' };
    const baseStats = {
      date: today,
      ...this.createDefaultAccountStats(defaultAcc.id, defaultAcc.name),
      accounts: {}
    };

    try {
      if (fs.existsSync(STATS_FILE)) {
        const raw = fs.readFileSync(STATS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.date === today) {
          const merged = { ...baseStats, ...parsed };
          if (!merged.accounts || typeof merged.accounts !== 'object') {
            merged.accounts = {};
          }
          // 将旧版单账号数据迁移进 merged.accounts[defaultAcc.id]
          if (!merged.accounts[defaultAcc.id]) {
            merged.accounts[defaultAcc.id] = {
              id: defaultAcc.id,
              name: defaultAcc.name,
              date: today,
              balance: merged.balance || 0,
              startBalance: merged.startBalance || 0,
              earned: merged.earned || 0,
              streakDays: merged.streakDays || 0,
              stamps: merged.stamps || { progress: 0, max: 12 },
              lastUpdate: merged.lastUpdate || Date.now(),
              tasks: merged.tasks || this.createDefaultAccountStats().tasks
            };
          }
          return merged;
        } else if (parsed && parsed.accounts && typeof parsed.accounts === 'object') {
          // 跨日换天：日常任务清空，但继承跨天多日打孔卡状态与打孔记录，避免第二天被清零
          for (const [accId, oldAcc] of Object.entries(parsed.accounts)) {
            if (!baseStats.accounts[accId]) {
              baseStats.accounts[accId] = this.createDefaultAccountStats(accId, oldAcc.name || accId);
            }
            for (const [k, oldTask] of Object.entries(oldAcc.tasks || {})) {
              if (oldTask && (oldTask.isPunchCard || k === 'desktopApp' || k === 'monthlyQuest' || k.startsWith('quest_'))) {
                baseStats.accounts[accId].tasks[k] = { ...oldTask };
              }
            }
          }
          return baseStats;
        }
      }
    } catch (e) {
      console.error('[TaskManager] 读取统计数据失败:', e.message);
    }

    baseStats.accounts[defaultAcc.id] = this.createDefaultAccountStats(defaultAcc.id, defaultAcc.name);
    this.saveStats(baseStats);
    return baseStats;
  }

  ensureAccountStats(accountId) {
    const today = this.getTodayNum();
    if (this.stats.date !== today) {
      this.stats = this.loadStats();
    }
    if (!this.stats.accounts) {
      this.stats.accounts = {};
    }
    const accCfg = configManager.resolveAccount(accountId);
    const id = accCfg?.id || accountId || 'acc_1';
    const name = accCfg?.name || '账号';

    if (!this.stats.accounts[id]) {
      this.stats.accounts[id] = this.createDefaultAccountStats(id, name);
    } else {
      this.stats.accounts[id].name = name;
      // 保证所有打孔卡任务的 stepLogs 与基础属性健全
      for (const [k, t] of Object.entries(this.stats.accounts[id].tasks || {})) {
        if (t && (t.isPunchCard || k === 'desktopApp' || k === 'monthlyQuest' || k.startsWith('quest_'))) {
          t.isPunchCard = true;
          if (!Array.isArray(t.stepLogs)) t.stepLogs = [];
          if (!t.unit) t.unit = '个任务';
        }
      }
      if (!this.stats.accounts[id].stamps) {
        this.stats.accounts[id].stamps = { progress: 0, max: 12 };
      }
    }
    return this.stats.accounts[id];
  }

  saveStats(stats = this.stats) {
    try {
      this.stats = stats;
      // 同步第一个账号到顶层属性保持兼容
      const firstAcc = configManager.getAccounts()[0];
      if (firstAcc && stats.accounts?.[firstAcc.id]) {
        const fa = stats.accounts[firstAcc.id];
        stats.balance = fa.balance;
        stats.earned = fa.earned;
        stats.streakDays = fa.streakDays;
        stats.stamps = fa.stamps;
        stats.tasks = fa.tasks;
        stats.lastUpdate = fa.lastUpdate;
      }
      writeFileAtomic(STATS_FILE, JSON.stringify(stats, null, 2), { encoding: 'utf-8', mode: 0o600 });

      // 同步记录历史账单（包含单账号账单与全局汇总）
      const summary = this.computeSummary();
      const todayStr = historyManager.formatDate(new Date());

      // 1. 记录每个账号的账单
      if (stats.accounts) {
        for (const [accId, aStat] of Object.entries(stats.accounts)) {
          historyManager.recordAccountDay(accId, todayStr, {
            earned: aStat.earned || 0,
            balance: aStat.balance || 0,
            // 真实任务分解：只取确实拿到分的项，不再用硬编码模板编造明细
            breakdown: this.buildTaskBreakdown(aStat)
          });
        }
      }

      // 2. 记录全局汇总账单
      historyManager.recordGlobalDay(todayStr, {
        earned: summary.totalEarned || stats.earned || 0,
        balance: summary.totalBalance || stats.balance || 0,
        breakdown: this.buildSummaryBreakdown(stats)
      });
    } catch (e) {
      console.error('[TaskManager] 保存统计数据失败:', e.message);
    }
  }

  /**
   * 从任务项生成真实的积分分解（只保留真正拿到分的任务）。
   * 旧实现用 history.getDefaultBreakdown() 按固定模板拆分 earned，
   * 属于编造数据——历史图表悬停看到的明细全是假的。
   */
  buildTaskBreakdown(accStats) {
    return Object.values(accStats?.tasks || {})
      .map(t => ({ name: t.name || '', icon: t.icon || '📌', points: Number(t.points || 0) }))
      .filter(t => t.name && t.points > 0);
  }

  /** 全账号汇总的积分分解：把各账号同名任务的积分相加 */
  buildSummaryBreakdown(stats = this.stats) {
    const merged = new Map();
    for (const accStat of Object.values(stats?.accounts || {})) {
      for (const item of this.buildTaskBreakdown(accStat)) {
        const cur = merged.get(item.name) || { name: item.name, icon: item.icon, points: 0 };
        cur.points += item.points;
        merged.set(item.name, cur);
      }
    }
    return Array.from(merged.values()).sort((a, b) => b.points - a.points);
  }

  /**
   * 重算「今日已增积分」。
   *
   * 唯一权威来源是官网 earn 页顶部「今日积分」；只有解析到官网数字时才写入
   * earned（哪怕是 0，那是官网明确说的 0）。取不到官网数字时才回退到
   * 「当前余额 − 今日起始余额」，而且只在能明确证明「今天确实变多了」时写入。
   *
   * 绝不再用「各任务积分求和」——那会把没做的任务也算进去（实测能虚高几十点）。
   */
  applyEarned(accStats, officialTodayPoints, options = {}) {
    if (!accStats) return;
    // 注意：Number(null) === 0、Number('') === 0，如果直接转数字，会把
    // 「官网没解析到今日积分」误当成「今日确实得了 0 分」，从而在官网同步后
    // 把正确的历史值清零。必须先显式排除空值。
    if (officialTodayPoints === null || officialTodayPoints === undefined || officialTodayPoints === '') {
      return this.applyEarnedFromBalanceDelta(accStats, options);
    }
    const official = Number(officialTodayPoints);
    if (Number.isFinite(official) && official >= 0) {
      accStats.earned = official;
      accStats.earnedSource = 'official';
      return;
    }
    return this.applyEarnedFromBalanceDelta(accStats, options);
  }

  /**
   * 回退口径：当前余额 − 今日起始余额。
   *
   * 这个口径只有在「今日起始余额是在本次同步之前记录的」时才可信：
   * 本次同步刚记录起始余额时，余额差恒为 0，用它覆盖已有历史值就会
   * 造成「点一次官网同步，今日已增全部变 0」的 Bug。
   *
   * 另外只在余额确实变多（delta > 0）时才写入；delta 为 0 时无法区分
   * 「今天还没赚分」和「官网今日积分没解析到」，此时保留原值更安全。
   */
  /**
   * 官网「今日积分」读取失败时的处理。
   *
   * 重要：余额差（当前余额 - 今日起始余额）**绝不写进今日已增展示值**。
   * 原因：起始余额经常是在任务中途才记录，会把任务开始前赚的分也算进去，
   * 实测出现「官网 62 / 插件 92」这类偏差，比不显示更糟。
   *
   * 现在的策略：读不到就保留上次的官网值（若从未读到过则保持 0），
   * 并把状态标为 unknown，让 UI 知道这是「未知」而不是「确切值」。
   */
  /**
   * 官网「今日积分」本轮读取失败时的处理。
   *
   * 官网这个值只有两种情况：0 或正数，不存在「官网没有」。
   * 读不到 100% 是我们读取链路的问题，因此：
   *   - 绝不猜测（不用余额差改写）
   *   - 保留上一次成功读取的官网值
   *   - 只有从未读到过时才保持 0
   * 读取失败会在上层日志里输出具体原因，便于定位。
   */
  applyEarnedFromBalanceDelta(accStats, options = {}) {
    if (!accStats) return;
    if (!Number.isFinite(Number(accStats.earned))) accStats.earned = 0;
    accStats.earnedSource = accStats.earnedSource || 'official';
  }

  updateTask(key, partial, accountId = null) {
    const accStats = this.ensureAccountStats(accountId);
    if (accStats.tasks && accStats.tasks[key]) {
      Object.assign(accStats.tasks[key], partial);
      // 注意：这里不再用任务积分求和改写 earned。
      // 任务积分只用于展示分解，真实今日增量由 applyEarned() 统一维护。
      accStats.lastUpdate = Date.now();
      this.saveStats();
    }
  }

  /**
   * 删除账号时清理它的统计与账单，避免留下孤儿数据
   */
  removeAccountStats(accountId) {
    if (!accountId) return false;
    if (this.stats?.accounts?.[accountId]) {
      delete this.stats.accounts[accountId];
      this.saveStats();
      return true;
    }
    return false;
  }

  /**
   * 核心自愈机制：直接从微软官方同步账号的真实完成状态 (搜索/阅读/桌面任务/连签/印章)
   */
  async syncAccountOfficialStatus(accCfg, options = {}) {
    if (!accCfg?.cookie && !accCfg?.refreshToken) return null;
    // owned=true 表示调用方（任务执行）已经持有账号上下文锁，可以安全切换上下文。
    // 否则如果此刻有任务在跑，直接跳过 —— 抢走全局 Cookie/Token 上下文会把
    // 正在执行的任务算到别的账号头上。
    const owned = options.owned === true;
    // 非任务流程（WebUI 同步）也要自己持锁，否则两个并发的同步请求会互相
    // 抢全局上下文，同样可能把 A 的请求算到 B 头上。
    if (!owned && !accountContextLock.tryAcquire('web-sync')) return null;
    const accountId = accCfg.id;
    // 注意：加锁之后的所有逻辑都必须包在 try 里，否则中途抛异常会导致锁泄漏，
    // 后续定时任务与同步会一直拿不到锁。
    let accStats = null;
    let prevContext = null;

    try {
      accStats = this.ensureAccountStats(accountId);
      // 同步期间的日志统一归属到该账号（结束后整体还原，避免串台）
      prevContext = rewardsApi.snapshotAccountContext();
      logger.setAccountContext(accCfg.name || accountId);
      rewardsApi.setCurrentAccount(accCfg);
      const [info, streakInfo] = await Promise.all([
        rewardsApi.getRewardsInfo(2),
        rewardsApi.checkStreak()
      ]);

      if (info) {
        // 余额只在解析到有效正值时才覆盖：
        // 官网页面偶发取不到余额时 info.balance 会是 0，旧写法会把已有余额直接冲成 0，
        // 界面上就会短暂出现「总积分 0」。
        const parsedBalance = Number(info.balance);
        if (Number.isFinite(parsedBalance) && parsedBalance > 0) {
          accStats.balance = parsedBalance;
        }

        // 1. 同步 PC 搜索真实配额
        if (info.pc) {
          const pcCur = Number(info.pc.progress || 0);
          const pcMax = Number(info.pc.max || 60);
          const isPcDone = pcMax > 0 && pcCur >= pcMax;
          accStats.tasks.search = {
            name: "必应 PC 搜索任务",
            progress: pcCur,
            max: pcMax,
            points: pcCur,
            unit: "分",
            icon: "🔍",
            done: isPcDone
          };
        }

        // 2. 同步新闻阅读真实配额
        if (info.readMax > 0) {
          const readCur = Number(info.readProgress || 0);
          const readMax = Number(info.readMax || 30);
          const isReadDone = readCur >= readMax;
          accStats.tasks.read = {
            name: "新闻资讯自动阅读",
            progress: readCur,
            max: readMax,
            points: readCur,
            unit: "篇",
            icon: "📖",
            done: isReadDone
          };
        }

        // 3. 动态同步官方「任务」区全部打孔卡（自适应 1 个、2 个或多个）
        const hasOfficialQuests = Array.isArray(info.quests) && info.quests.length > 0;
        const questList = hasOfficialQuests
          ? info.quests
          : [info.desktopApp, info.monthlyQuest].filter(Boolean);

        if (questList.length > 0) {
          const currentQuestKeys = new Set();
          questList.forEach((q, idx) => {
            const title = q.title || q.name || '';
            const isDesktop = title.includes('桌面') || title.includes('RewardsApp');
            const isHalloween = title.includes('Halloween') || title.includes('万圣节');
            const isMonthly = title.includes('亮点') || title.includes('FY27') || title.includes('Monthly');
            
            let questKey = isDesktop ? 'desktopApp' : (isHalloween ? 'quest_halloween' : (isMonthly ? 'monthlyQuest' : `quest_${idx}`));
            currentQuestKeys.add(questKey);

            const prevTask = accStats.tasks[questKey] || {};
            const prevLogs = Array.isArray(prevTask.stepLogs) ? prevTask.stepLogs : [];
            const updatedLogs = [...prevLogs];
            const qProgress = Number(q.progress ?? 0);
            const qMax = Number(q.max ?? (isDesktop ? 8 : (isHalloween ? 6 : 5))) || 1;

            for (let s = 1; s <= qProgress; s++) {
              if (!updatedLogs.some(l => l.step === s)) {
                updatedLogs.push({
                  step: s,
                  at: Date.now() - (qProgress - s) * 86400000,
                  name: `第 ${s} 项`
                });
              }
            }
            updatedLogs.sort((a, b) => a.step - b.step);

            let icon = q.icon;
            if (!icon) {
              if (isHalloween) icon = '🎃';
              else if (isDesktop) icon = '🖥️';
              else if (isMonthly) icon = '🍁';
              else icon = '🎯';
            }

            accStats.tasks[questKey] = {
              name: title || (isDesktop ? '桌面应用每周专属任务' : '活动打孔卡'),
              progress: qProgress,
              max: qMax,
              points: qProgress >= qMax ? (q.points || (isDesktop ? 20 : 50)) : 0,
              unit: "个任务",
              icon,
              expiresText: q.expiresText || "",
              available: q.available !== false,
              done: qProgress >= qMax,
              stepLogs: updatedLogs,
              isPunchCard: true
            };
          });

          // 仅在明确获取到了官方确切的任务列表时，才移除下线活动；若未拿到列表则完整保留已有卡片
          if (hasOfficialQuests) {
            for (const key of Object.keys(accStats.tasks)) {
              if (key !== 'sign' && key !== 'read' && key !== 'search' && key !== 'dailySet' && key !== 'promos') {
                if (!currentQuestKeys.has(key)) {
                  delete accStats.tasks[key];
                }
              }
            }
          }
        }

        // 4. 同步印章与连签
        if (info.stamps) {
          accStats.stamps = info.stamps;
        }

        // 同步官网待领取额外积分
        if (info.claimablePoints !== undefined) {
          accStats.claimablePoints = Number(info.claimablePoints || 0);
        }

        // 同步连签任务（必应搜索 / 每日活动 / 必应应用）真实状态。
        // 「必应应用连续打卡」是官网独立展示的一项，脚本 UI 之前完全没有体现，
        // 导致明明没签成功也看不出来，这里如实记录并在未完成时给出提示。
        if (info.streaks) {
          accStats.streaks = info.streaks;
          const appStreak = info.streaks.bingapp;
          if (appStreak && appStreak.isCurrentDayCompleted === false) {
            logger.log('📱', `必应应用连续打卡今日未完成 (已完成 ${appStreak.completedDays || 0}/7 天)，执行任务时会自动补签`);
          } else if (appStreak && appStreak.isCurrentDayCompleted === true) {
            logger.log('📱', `必应应用连续打卡今日已完成 (连签第 ${appStreak.completedDays || 1} 天)`);
          }
        }

        if (streakInfo?.streakDays) {
          accStats.streakDays = streakInfo.streakDays;
        }

        // 5. 双端签入 / 每日活动集：只认官网连签任务的真实状态
        //
        //    这里以前是「搜索和阅读都打满就推断签到与活动也完成了」，属于猜测。
        //    那正是「脚本显示双端签入已完成、官网必应应用连续打卡却还是 0/1」的根因。
        //    现在改为以官网 streak 模型为准，并且能双向校正：
        //    官网说完成就标完成，官网明确说没完成就把误标的完成状态纠正回来。
        const appStreak = info.streaks?.bingapp;
        const signTask = accStats.tasks.sign;
        if (appStreak && signTask) {
          if (appStreak.isCurrentDayCompleted === true) {
            signTask.progress = 1;
            signTask.max = 1;
            if (!signTask.points) signTask.points = 10;
            signTask.done = true;
          } else if (appStreak.isCurrentDayCompleted === false) {
            // 官网明确显示今日未签到（签到 0/1），不能继续显示「已完成」
            signTask.progress = 0;
            signTask.done = false;
          }
        }

        const dsStreak = info.streaks?.dailyset;
        const dsTask = accStats.tasks.dailySet;
        if (dsStreak && dsTask && Number(dsStreak.activitiesTotal || 0) > 0) {
          const dsTotal = Number(dsStreak.activitiesTotal);
          const dsDone = Math.min(Number(dsStreak.activitiesCompleted || 0), dsTotal);
          const dsFinished = dsDone >= dsTotal;
          dsTask.max = dsTotal;
          dsTask.progress = dsFinished ? dsTotal : dsDone;
          if (dsFinished) {
            if (!dsTask.points) dsTask.points = 30;
            dsTask.done = true;
          } else {
            dsTask.points = 0;
            dsTask.done = false;
          }
        }

        // 每天第一次拿到余额时记录「今日起始余额」。
        // 记录后本次同步的余额差恒为 0，因此这一轮禁止用余额差覆盖 earned，
        // 否则「全部账号官网同步」会把今日已增的展示值全部清零。
        const hadStartBalanceToday = accStats.startBalanceDate === this.getTodayNum() && Number(accStats.startBalance) > 0;
        if (!hadStartBalanceToday && Number(accStats.balance) > 0) {
          accStats.startBalance = Number(accStats.balance);
          accStats.startBalanceDate = this.getTodayNum();
        }
        // 今日已增积分：以官网「今日积分」为准，取不到才回退到余额差。
        this.applyEarned(accStats, info.todayPoints, { allowBalanceDelta: hadStartBalanceToday });
        accStats.lastUpdate = Date.now();
        this.saveStats();
        return accStats;
      }
    } catch (e) {
      console.error(`[TaskManager] 同步账号 [${accCfg.name}] 官方状态失败:`, e.message);
    } finally {
      if (prevContext) rewardsApi.restoreAccountContext(prevContext);
      if (!owned) accountContextLock.release('web-sync');
    }
    return null;
  }

  async syncAllOfficialStatus() {
    // 任务执行期间不做同步，避免与执行流程争抢账号上下文
    if (!accountContextLock.tryAcquire('web-sync')) return this.computeSummary();
    try {
      const accounts = configManager.getAccounts().filter(a => a.enabled !== false && (a.cookie || a.refreshToken));
      for (const acc of accounts) {
        // 外层已持有 web-sync 锁，这里用 owned 明确告知，不再重复加/解锁
        await this.syncAccountOfficialStatus(acc, { owned: true });
      }
      return this.computeSummary();
    } finally {
      accountContextLock.release('web-sync');
    }
  }

  computeSummary() {
    const accountsCfg = configManager.getAccounts();
    let totalEarned = 0;
    let totalBalance = 0;
    let totalClaimable = 0;
    let maxStreak = 0;
    let totalTasksCount = 0;
    let doneTasksCount = 0;
    let stampsProgress = 0;
    let stampsMax = 12;

    const accountsList = accountsCfg.map(cfgAcc => {
      const st = this.ensureAccountStats(cfgAcc.id);
      totalEarned += Number(st.earned || 0);
      totalBalance += Number(st.balance || 0);
      totalClaimable += Number(st.claimablePoints || 0);
      if ((st.streakDays || 0) > maxStreak) maxStreak = st.streakDays;
      if ((st.stamps?.progress || 0) > stampsProgress) {
        stampsProgress = st.stamps.progress;
        stampsMax = st.stamps.max || 12;
      }

      const tEntries = Object.values(st.tasks || {});
      const tTotal = tEntries.length;
      const tDone = tEntries.filter(t => t.done || (t.max > 0 && t.progress >= t.max)).length;
      totalTasksCount += tTotal;
      doneTasksCount += tDone;

      return {
        id: cfgAcc.id,
        name: cfgAcc.name,
        enabled: cfgAcc.enabled !== false,
        hasCookie: !!cfgAcc.cookie,
        hasToken: !!cfgAcc.refreshToken,
        authDiagnosis: cfgAcc.authDiagnosis || null,
        balance: st.balance || 0,
        earned: st.earned || 0,
        claimablePoints: Number(st.claimablePoints || 0),
        streakDays: st.streakDays || 0,
        stamps: st.stamps || { progress: 0, max: 12 },
        doneTasks: tDone,
        totalTasks: tTotal,
        percent: tTotal > 0 ? Math.round((tDone / tTotal) * 100) : 0,
        lastUpdate: st.lastUpdate,
        tasks: st.tasks
      };
    });

    const overallPercent = totalTasksCount > 0 ? Math.round((doneTasksCount / totalTasksCount) * 100) : 0;

    return {
      totalAccounts: accountsList.length,
      totalEarned,
      totalBalance,
      totalClaimable,
      maxStreak,
      stamps: { progress: stampsProgress || 0, max: stampsMax || 12 },
      doneTasksCount,
      totalTasksCount,
      overallPercent,
      accountsList
    };
  }

  getStatus(accountId = 'all') {
    const today = this.getTodayNum();
    if (this.stats.date !== today) {
      this.stats = this.loadStats();
    }

    const summary = this.computeSummary();
    let activeStats = this.stats;

    if (accountId && accountId !== 'all') {
      activeStats = this.ensureAccountStats(accountId);
    } else if (summary.accountsList.length > 0) {
      // 汇总模式：构造汇总的 Hero 与第一个账号的详细或合并数据
      const first = this.ensureAccountStats(summary.accountsList[0].id);
      activeStats = {
        ...first,
        earned: summary.totalEarned,
        balance: summary.totalBalance,
        streakDays: summary.maxStreak,
        stamps: summary.stamps
      };
    }

    // 打卡明细按账号过滤：单账号视图只保留该账号的记录，汇总视图返回全部
    const allTimeline = logger.getTimeline();
    let timeline = allTimeline;
    if (accountId && accountId !== 'all') {
      const targetName = (configManager.getAccounts().find(a => a.id === accountId) || {}).name;
      if (targetName) {
        timeline = allTimeline.filter(t => (t.accountName || t.tag) === targetName);
      }
    }

    return {
      running: this.running,
      runningAccountId: this.runningAccountId,
      selectedAccountId: accountId || 'all',
      summary,
      stats: activeStats,
      timeline
    };
  }

  stop() {
    if (this.running) {
      logger.log('🛑', '正在中断当前任务执行流程...');
      this.running = false;
      this.runningAccountId = null;
    }
    browserManager.stop();
  }

  /**
   * 领取 Dashboard 待领取额外积分
   */
  /**
   * 领取 Dashboard 额外待领积分。
   *
   * 必须持有账号上下文锁：领取过程中会切换全局 Cookie 上下文，
   * 如果此时定时任务正在跑，会把积分算到别的账号头上。
   * 锁被占用时返回明确原因（谁占用、占用多久），而不是静默返回 0。
   */
  async claimPendingPoints(targetAccountId = 'all') {
    if (!accountContextLock.tryAcquire('claim-points')) {
      const snap = accountContextLock.snapshot();
      return {
        claimed: 0,
        skipped: true,
        owner: snap.owner,
        heldMs: snap.heldMs,
        reason: `账号上下文正被 [${snap.owner}] 占用（已 ${Math.round(snap.heldMs / 1000)} 秒），请稍后再试`
      };
    }
    try {
      const accounts = configManager.getAccounts().filter(a => a.enabled !== false && a.cookie);
      const targets = targetAccountId === 'all' ? accounts : accounts.filter(a => a.id === targetAccountId);
      let totalClaimed = 0;
      for (const acc of targets) {
        try {
          rewardsApi.setCurrentAccount(acc);
          const pts = await browserManager.claimDashboardPoints(acc);
          if (pts > 0) {
            totalClaimed += pts;
            const st = this.ensureAccountStats(acc.id);
            st.balance = (st.balance || 0) + pts;
            st.claimablePoints = 0;
            this.saveStats();
          }
        } catch {}
      }
      return { claimed: totalClaimed, skipped: false, reason: '' };
    } finally {
      accountContextLock.release('claim-points');
    }
  }

  /**
   * 单次安全测试搜索 (仅搜 1 次，检验按键输入流与积分变化)
   */
  async runSingleTestSearch(accountId = null) {
    // 必须用 resolveAccount：getAccount() 在 id 不存在时会回退到第一个账号，
    // 那样「测试副账号」可能实际跑在主账号上。
    const acc = configManager.resolveAccount(accountId);
    if (!acc) throw new Error('未找到对应账号');
    // 注意持有者标识必须与任务执行（'task-run'）不同：
    // 同一个标识会被当成「重入」而放行，那样任务跑着的时候照样能抢上下文。
    if (!accountContextLock.tryAcquire('web-action')) {
      throw new Error('已有任务正在执行，请稍后再试（避免账号上下文串台）');
    }
    try {
      rewardsApi.setCurrentAccount(acc);
      const result = await browserManager.singleTestSearch(acc);
      // 搜索完成后同步一次最新官网数据（同一持有者，可重入）
      await this.syncAccountOfficialStatus(acc, { owned: true });
      return result;
    } finally {
      accountContextLock.release('web-action');
    }
  }

  /**
   * 记录打孔卡完成步数历史 (精确记录时间戳与任务名)
   */
  recordPunchCardSteps(accountId, details = []) {
    const accStats = this.ensureAccountStats(accountId);
    if (!accStats.tasks) return;
    for (const d of details) {
      let targetTask = null;
      for (const [key, t] of Object.entries(accStats.tasks)) {
        if (t && (t.isPunchCard || key === 'desktopApp' || key === 'monthlyQuest' || key.startsWith('quest_'))) {
          if (t.name === d.title || (d.title && t.name.includes(d.title)) || (d.title && d.title.includes(t.name))) {
            targetTask = t;
            break;
          }
        }
      }
      if (!targetTask) {
        const isDesktop = (d.title || '').includes('桌面') || (d.questId || '').includes('RewardsApp');
        const isHalloween = (d.title || '').includes('Halloween') || (d.questId || '').includes('Halloween');
        const key = isDesktop ? 'desktopApp' : (isHalloween ? 'quest_halloween' : 'monthlyQuest');
        if (!accStats.tasks[key]) {
          accStats.tasks[key] = {
            name: d.title || (isDesktop ? '桌面应用每周专属任务' : '活动打孔卡'),
            progress: 0,
            max: isDesktop ? 8 : (isHalloween ? 6 : 5),
            points: isDesktop ? 20 : 50,
            unit: '个任务',
            icon: isHalloween ? '🎃' : (isDesktop ? '🖥️' : '🎯'),
            expiresText: '',
            available: true,
            done: false,
            stepLogs: [],
            isPunchCard: true
          };
        }
        targetTask = accStats.tasks[key];
      }
      const task = targetTask;
      if (task) {
        if (!Array.isArray(task.stepLogs)) task.stepLogs = [];
        const nextStep = (task.progress || 0) + 1;
        task.stepLogs.push({
          step: nextStep,
          at: d.at || Date.now(),
          name: d.stepName || `第 ${nextStep} 步`
        });
        task.progress = Math.min(task.max || nextStep, nextStep);
        if (task.progress >= task.max) task.done = true;
      }
    }
    this.saveStats();
  }

  /**
   * 为单个账号执行全套打卡任务
   */
  async runSingleAccount(accCfg, globalCfg, options = {}) {
    const accountId = accCfg.id;
    const accountName = accCfg.name || accountId;
    this.runningAccountId = accountId;
    const accStats = this.ensureAccountStats(accountId);

    // 切换当前 API 执行上下文到该账号
    rewardsApi.setCurrentAccount(accCfg);
    // 切换日志账号上下文：该账号下未显式传账号名的日志也会自动带上账号名
    logger.setAccountContext(accountName);

    logger.log('👤', `>>> 开始执行账号 [${accountName}] 的自动化打卡任务 <<<`, accountName);

    // 1. 运行前先从官方同步一次真实进度（确保增量起点100%准确）
    await this.syncAccountOfficialStatus(accCfg, { owned: true });

    // 2. 检查是否所有任务今日均已达标完成
    const taskValues = Object.values(accStats.tasks || {});
    const isAllDone = taskValues.length > 0 && taskValues.every(t => t.done || (t.max > 0 && t.progress >= t.max));
    if (isAllDone && !globalCfg.tasks?.keepRunning) {
      logger.log('💤', `账号 [${accountName}] 今日所有打卡任务已全部满额达成，无需重复执行，直接结束！`, '', accountName);
      return;
    }

    const startBalance = await rewardsApi.getBalance();
    // 每天只记录一次「今日起始余额」，用日期字段判断，
    // 不再用 `startBalance === 0` 判断（余额恰好为 0 的账号会被反复覆盖）
    if (startBalance !== null) {
      if (accStats.startBalanceDate !== this.getTodayNum()) {
        accStats.startBalance = startBalance;
        accStats.startBalanceDate = this.getTodayNum();
      }
      accStats.balance = startBalance;
    }
    this.saveStats();
    logger.log('📊', `当前积分: ${accStats.balance}`, accountName);

    // 检查或刷新 Token
    const tokenOk = await authManager.refreshToken(false, accountId);
    if (!tokenOk) {
      logger.log('🟡', '移动端 OAuth Token 未就绪，将跳过 App 签到与阅读任务', accountName);
    }

    // 1. 每日双端签入 (若已签到则直接跳过)
    if (globalCfg.tasks?.sign && this.running) {
      if (accStats.tasks.sign?.done) {
        logger.log('✅', '每日签入已完成，跳过', accountName);
      } else {
        let signPoints = 0;
        let signSuccess = false;

        if (tokenOk) {
          const appRes = await rewardsApi.signApp();
          if (appRes && Number(appRes.points || 0) > 0) {
            signSuccess = true;
            signPoints += Number(appRes.points);
            logger.log('📱', `App 端静默签到成功 +${appRes.points} 积分`, accountName);
          } else if (appRes && appRes.isDuplicate) {
            signSuccess = true;
            logger.log('📱', 'App 端今日已签到过，跳过', accountName);
          } else if (appRes) {
            // 接口既没返积分也没报重复：无法区分「今天已经签过」还是「根本没签成」，
            // 直接读官网「必应应用连续打卡」的真实状态来判定，不凭猜测标已完成。
            await rewardsApi.randomDelay(1500, 3000);
            const appStatus = await rewardsApi.getAppCheckInStatus();
            if (appStatus?.isCurrentDayCompleted) {
              signSuccess = true;
              logger.log('📱', `App 端签到已生效（官网连签第 ${appStatus.currentDay || 1} 天）`, accountName);
            } else {
              const progressText = appStatus ? `${appStatus.completedDays || 0}/7 天` : '状态未知';
              logger.log('🟡', `App 端签到未生效：官网「必应应用连续打卡」仍为 ${progressText}，请检查该账号的移动端授权 (Refresh Token) 是否有效`, accountName);
              // 典型误配：这个账号的移动端 Token 其实是另一个微软账号的，
              // 签到会算到那个账号上，本账号自然永远是 0/1。
              const tokenBalance = Number(appRes.balance);
              const cookieBalance = Number(accStats.balance);
              if (Number.isFinite(tokenBalance) && Number.isFinite(cookieBalance)
                && cookieBalance > 0 && Math.abs(tokenBalance - cookieBalance) > 100) {
                logger.log('🔴', `注意：移动端 Token 所属账号积分 (${tokenBalance}) 与网页端 Cookie 所属账号积分 (${cookieBalance}) 不一致，该账号的移动端授权很可能绑定的是另一个微软账号，请在配置向导里重新授权`, accountName);
              }
            }
          } else {
            logger.log('🟡', 'App 端签到未成功（Token 或接口异常），下次巡检会自动重试', accountName);
          }
        }

        await rewardsApi.randomDelay(2000, 4000);
        const pcPts = await rewardsApi.signPC();
        if (pcPts >= 0) {
          signSuccess = true;
          signPoints += pcPts;
          logger.log('💻', `PC 网页端签入成功${pcPts > 0 ? ` +${pcPts} 积分` : ''}`, accountName);
        }

        if (signSuccess) {
          this.updateTask('sign', { progress: 1, max: 1, points: signPoints || 10, done: true }, accountId);
          logger.addTimeline(accountName, `双端签到完成 (+${signPoints || 10} 积分)`);
        }
      }
    }

    if (!this.running) return;

    // 2. 新闻资讯自动阅读 (严格增量模式：缺几篇读几篇)
    if (globalCfg.tasks?.read && tokenOk && this.running) {
      const readInfo = await rewardsApi.getReadProgress();
      const cur = readInfo?.progress || accStats.tasks.read?.progress || 0;
      const max = readInfo?.max || accStats.tasks.read?.max || 30;

      if (cur >= max) {
        logger.log('✅', `新闻阅读配额今日已打满 (${cur}/${max})，跳过`, accountName);
        this.updateTask('read', { progress: max, max, points: max, done: true }, accountId);
      } else {
        const remaining = Math.min(max - cur, 10);
        logger.log('📖', `今日还需阅读 ${remaining} 篇新闻资讯 (当前进度 ${cur}/${max})`, accountName);
        let okCount = 0;
        for (let i = 0; i < remaining && this.running; i++) {
          const res = await rewardsApi.doReadArticle();
          if (res) {
            okCount++;
            logger.log('📖', `阅读完成第 ${i + 1}/${remaining} 篇 (+${res.points || 3} 积分)`, accountName);
            // 实时写入进度：否则整个阅读过程（约 1 分钟）界面会一直停在 0/30
            const liveProg = Math.min(max, cur + okCount * 3);
            this.updateTask('read', {
              progress: liveProg,
              max,
              points: liveProg,
              done: liveProg >= max
            }, accountId);
          }
          await rewardsApi.randomDelay(3000, 6000);
        }
        const finalRead = await rewardsApi.getReadProgress();
        const finalProg = finalRead?.progress || (cur + okCount * 3);
        this.updateTask('read', { progress: finalProg, max, points: finalProg, done: finalProg >= max }, accountId);
        logger.addTimeline(accountName, `新闻阅读完成 ${finalProg}/${max}`);
      }
    }

    if (!this.running) return;

    // 3. 活动卡片 / 每日活动集 / 桌面端打孔卡（三个真正独立的开关）
    const wantDailySet = globalCfg.tasks?.dailySet !== false;
    const wantDesktop = globalCfg.tasks?.desktopApp !== false;
    const wantPromos = globalCfg.tasks?.promos !== false;
    if ((wantPromos || wantDailySet || wantDesktop) && this.running) {
      logger.log('🧩', '正在扫描活动卡片与日常活动...', accountName);
      const allCards = await rewardsApi.discoverCards();
      // 按分类过滤：dailyset=每日活动集，desktop=桌面端打孔卡，其余归 promos
      const cards = allCards.filter(c => {
        if (c.category === 'dailyset') return wantDailySet;
        if (c.category === 'desktop') return wantDesktop;
        return wantPromos;
      });

      if (cards.length > 0) {
        logger.log('🧩', `发现 ${cards.length} 个待处理活动卡片`, accountName);
        let cardOk = 0;
        let claimedPoints = 0;
        let desktopOk = 0;
        let promoOk = 0;
        let promoTotal = 0;
        for (const card of cards) {
          if (card.category === 'promo') promoTotal++;
        }

        for (const card of cards) {
          if (!this.running) break;
          logger.log('🧩', `执行卡片打卡: [${card.kind}] ${card.title} (+${card.points}分)`, accountName);
          await rewardsApi.randomDelay(2500, 5000);
          const claimed = await rewardsApi.claimCard(card);
          if (!claimed) continue;

          cardOk++;
          claimedPoints += Number(card.points || 0);

          if (card.category === 'desktop') {
            desktopOk++;
            // 桌面专属任务按真实进度累加，不再写死 3
            const dCur = this.ensureAccountStats(accountId).tasks?.desktopApp || {};
            const dProgress = Number(dCur.progress || 0) + 1;
            const dMax = Number(dCur.max || 8) || 8;
            this.updateTask('desktopApp', {
              progress: dProgress,
              max: dMax,
              points: claimedPoints,
              available: true,
              done: dProgress >= dMax
            }, accountId);
          } else if (card.category === 'promo') {
            promoOk++;
            // 实时更新卡片进度，避免整个扫描过程界面停在 0/x
            this.updateTask('promos', {
              progress: promoOk,
              max: promoTotal,
              points: claimedPoints,
              done: promoTotal > 0 && promoOk >= promoTotal
            }, accountId);
          }
        }

        if (promoTotal > 0) {
          // 只有全部卡片都成功打卡才算完成，且积分只记「确实领到的那些」
          this.updateTask('promos', {
            progress: promoOk,
            max: promoTotal,
            points: claimedPoints,
            done: promoOk >= promoTotal
          }, accountId);
        }
        // 注意：这里不再无条件给 dailySet 记 3/3 +30 分。
        // 每日活动集的真实状态由 syncAccountOfficialStatus() 按官网数据写入。
        logger.addTimeline(accountName, `完成活动卡片 ${cardOk}/${cards.length} 项`);
      } else {
        // 一张都没扫到：用官网 activityCards 的真实完成情况判断，
        // 不再无脑标成「已完成 +10 分」（那正是虚高分数的来源之一）。
        const cardStatus = await rewardsApi.getActivityCardStatus();
        if (cardStatus?.readable && cardStatus.total > 0 && cardStatus.completed >= cardStatus.total) {
          logger.log('✅', `今日活动卡片已全部完成 (${cardStatus.completed}/${cardStatus.total})`, accountName);
          this.updateTask('promos', { progress: cardStatus.completed, max: cardStatus.total, points: 0, done: true }, accountId);
        } else if (cardStatus?.readable && cardStatus.total > 0) {
          // 读到了状态但确实还有未完成：如实显示进度，不要谎报已完成
          logger.log('ℹ️', `今日活动卡片 ${cardStatus.completed}/${cardStatus.total}，本期未发现可自动执行的卡片，保持未完成状态，不记分`, accountName);
          this.updateTask('promos', { progress: cardStatus.completed, max: cardStatus.total, points: 0, done: false }, accountId);
        } else if (cardStatus?.readable && cardStatus.total === 0) {
          // 官网明确返回了空的 activityCards：今天确实没有卡片，不是“读不到”
          logger.log('ℹ️', '今日官网未展示任何活动卡片，保持未完成状态，不记分', accountName);
          this.updateTask('promos', { progress: 0, max: 0, points: 0, done: false }, accountId);
        } else {
          // 真·读取失败：把原因带出来，便于区分 Cookie 失效 / 页面改版 / 网络异常
          const reasonText = {
            'not-signed-in': '官网要求重新登录，Cookie 可能已失效',
            'activity-cards-not-found': '官网页面结构可能已改版（未找到 activityCards 字段）',
            'json-parse-failed': '卡片数据解析失败',
            'not-an-array': '卡片数据格式异常',
            'empty-response': '官网返回空响应',
            'request-failed': '请求官网失败（网络或风控）'
          }[cardStatus?.reason] || '未知原因';
          logger.log('🟡', `未能读取官网活动卡片状态（${reasonText}），保持未完成状态，不记分`, accountName);
          this.updateTask('promos', { progress: 0, max: 0, points: 0, done: false }, accountId);
        }
      }
    }

    if (!this.running) return;

    // 4. 必应 PC 搜索任务与仪表盘同步
    const info = await rewardsApi.getRewardsInfo();
    if (info) {
      if (info.desktopApp) {
        const dProgress = Number(info.desktopApp.progress ?? 0);
        const dMax = Number(info.desktopApp.max ?? 8) || 8;
        this.updateTask('desktopApp', {
          progress: dProgress,
          max: dMax,
          expiresText: info.desktopApp.expiresText || '',
          points: dProgress >= dMax ? 20 : 0,
          available: info.desktopApp.available !== false,
          done: dProgress >= dMax
        }, accountId);
      }
      if (info.stamps) {
        accStats.stamps = info.stamps;
      }
    }

    if (globalCfg.tasks?.search && this.running) {
      const curSearch = info?.pc?.progress || 0;
      const maxSearch = info?.pc?.max || 60;
      // 本地实时进度：官方页面刷新有延迟，用它兜底避免进度倒退
      let liveSearch = curSearch;
      const applySearchProgress = (completed) => {
        liveSearch = Math.max(liveSearch, Math.min(maxSearch, curSearch + completed * 3));
        this.updateTask('search', {
          progress: liveSearch,
          max: maxSearch,
          points: liveSearch,
          done: liveSearch >= maxSearch
        }, accountId);
      };
      logger.log('🔍', `当前 PC 搜索配额: ${curSearch}/${maxSearch}`, accountName);

      if (curSearch >= maxSearch) {
        logger.log('✅', 'PC 搜索配额已打满', accountName);
        this.updateTask('search', { progress: maxSearch, max: maxSearch, points: maxSearch, done: true }, accountId);
      } else {
        const neededPoints = maxSearch - curSearch;
        const searchMode = globalCfg.tasks?.searchEngineMode || 'browser';
        const hasBrowser = !!browserManager.getExecutablePath();

        // 停滞保护：每搜完一次读一次官网真实进度，连续多次不涨就主动停手。
        // 搜索额度到顶（或账号被限流）时，继续搜只会白白增加风控暴露面。
        const probeSearchProgress = async () => {
          const probe = await rewardsApi.getRewardsInfo();
          const p = Number(probe?.pc?.progress);
          return Number.isFinite(p) ? p : null;
        };
        const stagnantLimit = normalizeStagnantLimit(globalCfg.tasks?.searchStagnantLimit);

        if (searchMode === 'browser' && hasBrowser) {
          try {
            await browserManager.runPacedSearch(accCfg, neededPoints, {
              // 每搜完一次就刷新进度，否则整个搜索过程界面都不动
              onProgress: applySearchProgress,
              probeProgress: probeSearchProgress,
              stagnantLimit
            });
          } catch (e) {
            logger.log('🟡', `无头浏览器运行异常: ${e.message}，正在切换为轻量协议兜底`, '', accountName);
            await this.fallbackHttpSearch(accCfg, neededPoints, curSearch, maxSearch, globalCfg, applySearchProgress, {
              probeProgress: probeSearchProgress,
              stagnantLimit
            });
          }
        } else {
          await this.fallbackHttpSearch(accCfg, neededPoints, curSearch, maxSearch, globalCfg, applySearchProgress, {
            probeProgress: probeSearchProgress,
            stagnantLimit
          });
        }

        const afterInfo = await rewardsApi.getRewardsInfo();
        const official = afterInfo?.pc?.progress || 0;
        // 官方页面可能尚未刷新，取官方值与本地实时值的较大者，避免进度倒退
        const finalSearch = Math.max(official, liveSearch, curSearch);
        this.updateTask('search', {
          progress: finalSearch,
          max: maxSearch,
          points: finalSearch,
          done: finalSearch >= maxSearch
        }, accountId);
        logger.addTimeline(accountName, `PC 搜索打卡完成，当前配额 ${finalSearch}/${maxSearch}`);
      }
    }

    if (!this.running) return;

    // 4.5 任务区打孔卡 (如「十月必看五大亮点」这类每天解锁一个的任务)
    //     旧版本完全没处理这类任务，导致官网上长期停在 0/5。
    if (globalCfg.tasks?.promos && this.running && browserManager.getExecutablePath()) {
      const cur = this.ensureAccountStats(accountId);
      const isManual = options.manual === true;
      const punchCards = Object.values(cur.tasks || {}).filter(t => t && t.isPunchCard);
      const isAllQuestsFinished = punchCards.length > 0 && punchCards.every(t => t.done);

      // 若全部打孔卡已经满额完成，自动巡检时不重复启动浏览器
      if (isAllQuestsFinished && !isManual) {
        // 全部已达成，静默跳过
      } else {
        // 冷却判定：手动触发时无视冷却立刻检查；自动巡检时若 2 小时内刚检查过且无新解锁则等待
        const lastCheck = cur.lastQuestCheckTime || 0;
        const cooldownMs = 2 * 60 * 60 * 1000;
        const inCooldown = !isManual && (Date.now() - lastCheck < cooldownMs);

        if (!inCooldown) {
          cur.lastQuestCheckTime = Date.now();
          try {
            const quests = await rewardsApi.getQuestPunchCards();
            const pendingQuests = quests.filter(q => !q.done);
            if (pendingQuests.length > 0) {
              const questRes = await browserManager.runQuestPunchCards(accCfg, pendingQuests);
              if (questRes.completed > 0) {
                logger.addTimeline(accountName, `任务打孔卡推进 ${questRes.completed} 项`);
                if (questRes.details && questRes.details.length > 0) {
                  this.recordPunchCardSteps(accountId, questRes.details);
                }
                // 同步一次官网真实状态
                await this.syncAccountOfficialStatus(accCfg, { owned: true });
              }
            }
            this.saveStats();
          } catch (e) {
            logger.log('🟡', `任务打孔卡处理异常: ${e.message}`, '', accountName);
          }
        }
      }
    }

    if (!this.running) return;

    // 5. 连签检测与额外积分检测
    //    视觉搜索补签只在任务执行期尝试（每账号每天一次），读取进度的同步流程不再触发
    const streakInfo = await rewardsApi.checkStreak({ allowVisualSearchCheckIn: true });
    if (streakInfo?.streakDays) {
      accStats.streakDays = streakInfo.streakDays;
      logger.log('🔥', `连续打卡记录: ${accStats.streakDays} 天`, accountName);
    }
    await rewardsApi.checkClaimablePoints();

    // 6. 结算单账号总积分
    // 余额与「今日已增」都以官网为准：这里再取一次，把本轮新做的部分算进去
    const finalInfo = await rewardsApi.getRewardsInfo(1);
    const finalBalance = Number(finalInfo?.balance);
    if (Number.isFinite(finalBalance) && finalBalance > 0) {
      accStats.balance = finalBalance;
    } else {
      const endBalance = await rewardsApi.getBalance();
      if (endBalance !== null) accStats.balance = endBalance;
    }
    this.applyEarned(accStats, finalInfo?.todayPoints);
    accStats.lastUpdate = Date.now();
    this.saveStats();

    logger.log('✅', `账号 [${accountName}] 任务完成！今日新增: +${accStats.earned} | 当前余额: ${accStats.balance}`, accountName);
  }

  async fallbackHttpSearch(accCfg, neededPoints, curSearch, maxSearch, globalCfg, onProgress = null, options = {}) {
    const accountName = accCfg.name || accCfg.id;
    const { probeProgress = null, stagnantLimit = 10 } = options;
    // 与拟人模式共用同一套停滞保护
    const stagnation = new SearchStagnationGuard(stagnantLimit);
    // 每次搜索最多 +3 分，上限 20 次可覆盖单账号 60 分上限；
    // 旧实现写死最多 7 次（21 分），轻量模式下永远打不满搜索任务。
    const searchCount = Math.max(1, Math.min(Math.ceil(neededPoints / 3), 20));
    // 与拟人模式共用全局搜索节奏，并同样受 3 小时执行窗口约束
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const wantedIntervalSec = clamp(Number(globalCfg.tasks?.searchIntervalSec ?? 180) || 180, 60, 900);
    const jitterSec = clamp(Number(globalCfg.tasks?.searchJitterSec ?? 30) || 30, 30, 300);
    const perSearchBudget = Math.floor((3 * 3600) / searchCount);
    const intervalSec = Math.max(60, Math.min(wantedIntervalSec, perSearchBudget - jitterSec));
    logger.log('🔍', `[轻量模式] 计划执行 ${searchCount} 次搜索请求，间隔 ${intervalSec} 秒 + 0~${jitterSec} 秒浮动`, '', accountName);

    for (let i = 0; i < searchCount && this.running; i++) {
      const word = await rewardsApi.getHotSearchWord();
      logger.log('🔍', `[搜索 ${i + 1}/${searchCount}] 关键词: "${word}"`, '', accountName);
      await rewardsApi.doSearchOnce(word);

      // 轻量模式同样实时刷新进度
      if (typeof onProgress === 'function') {
        try {
          onProgress(i + 1);
        } catch {}
      }

      // 停滞保护：连续 N 次搜索官网进度不涨就停手
      if (typeof probeProgress === 'function' && i < searchCount - 1) {
        let official = null;
        try {
          official = await probeProgress();
        } catch {}
        const result = stagnation.observe(official);
        if (result.stagnant) {
          logger.log('🛑', `连续 ${result.stagnantCount} 次搜索官网进度没有增加（停留在 ${result.bestProgress} 分），判定搜索额度已到顶，主动停止本轮搜索以免触发风控`, '', accountName);
          break;
        }
      }

      const waitSec = intervalSec + rewardsApi.randomRange(0, jitterSec);
      logger.log('⏳', `等待 ${waitSec} 秒...`, '', accountName);
      // 按 1 秒切片等待，让「停止」按钮能立即生效。
      // 旧实现是一次性 await 整个间隔，最长要等 900+300 秒才停得下来。
      for (let s = waitSec; s > 0 && this.running; s--) {
        await rewardsApi.delay(1000);
      }
    }
  }

  /**
   * 轮询执行全部账号或指定账号
   */
  async runAll(manual = false, targetAccountId = null) {
    if (this.running) {
      logger.log('🟡', '任务当前正在运行中，请勿重复触发！');
      return false;
    }

    // 抢占账号上下文锁：执行期间 WebUI 的同步 / 体检 / 测搜都会自动跳过，
    // 避免它们把全局 Cookie/Token 上下文切到别的账号，导致任务算错账号。
    const locked = await accountContextLock.acquire('task-run', 60000);
    if (!locked) {
      logger.log('🟡', '账号上下文正被其它操作占用，请稍后重试');
      return false;
    }

    this.running = true;
    const startTime = Date.now();

    try {
      const globalCfg = configManager.get();
      // 没有 Cookie 也没有 Token 的账号直接跳过：
      // 否则它会在没有凭据的情况下执行，可能误用到别的账号的会话
      const allAccounts = configManager.getAccounts()
        .filter(a => a.enabled !== false && (a.cookie || a.refreshToken));
      const targetList = (targetAccountId && targetAccountId !== 'all')
        ? allAccounts.filter(a => a.id === targetAccountId)
        : allAccounts;

      if (targetList.length === 0) {
        logger.log('🟡', '没有可执行的已启用账号');
        return false;
      }

      logger.log('🚀', `===== 启动全自动化任务 (${manual ? '手动触发' : '定时巡检'} | 共 ${targetList.length} 个账号) =====`);

      // 检测地区
      const regionOk = await rewardsApi.checkRegion();
      if (!regionOk) {
        logger.log('🔴', '地区检测未通过（当前非中国大陆 IP 且锁区开启），终止执行以防封号！');
        await notifier.send('任务停止警告', '检测到非中国大陆出口 IP，为防止被微软风控已自动停止打卡。');
        return false;
      }

      // 逐账号执行：单个账号抛异常不能拖垮后面所有账号（旧实现会直接跳出整个循环，
      // 导致第 1 个账号失败后第 2、3 个账号当天完全不执行）
      const failures = [];
      for (let i = 0; i < targetList.length && this.running; i++) {
        const acc = targetList[i];
        try {
          await this.runSingleAccount(acc, globalCfg, { manual });
        } catch (e) {
          failures.push({ name: acc.name || acc.id, error: e.message });
          logger.log('🔴', `账号 [${acc.name || acc.id}] 执行异常，已跳过并继续下一个账号: ${e.message}`, '', acc.name || acc.id);
          // 失败立刻推送
          try {
            await notifier.send(
              `微软积分打卡异常 [${acc.name || acc.id}]`,
              `账号 [${acc.name || acc.id}] 自动化打卡任务执行异常：\n❌ ${e.message}\n时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`
            );
          } catch {}
        }

        // 多账号之间安全随机延时隔离防风控
        if (i < targetList.length - 1 && this.running) {
          const gapSec = rewardsApi.randomRange(12, 25);
          logger.log('⏳', `多账号安全防风控隔离：等待 ${gapSec} 秒后切换下一个账号...`);
          await rewardsApi.delay(gapSec * 1000);
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const summary = this.computeSummary();
      const reportLines = summary.accountsList.map(a => `• ${a.name}: 今日 +${a.earned} | 余额 ${a.balance} | 连签 ${a.streakDays}天`);
      const failLines = failures.map(f => `• ${f.name}: ❌ ${f.error}`);
      const isSingleRun = !!targetAccountId && targetAccountId !== 'all';
      const summaryTitle = isSingleRun ? `账号 [${targetList[0]?.name || targetAccountId}] 任务执行完毕` : '全部任务执行完毕';
      const summaryMsg = `🎉 ${summaryTitle}！用时 ${elapsed} 秒\n总计今日新增: +${summary.totalEarned} 积分\n总积分余额: ${summary.totalBalance}\n\n${reportLines.join('\n')}`
        + (failLines.length > 0 ? `\n\n异常账号 (${failLines.length}):\n${failLines.join('\n')}` : '');
      logger.log('🎉', summaryMsg);

      // 推送规则：失败立刻推送（上面 catch 已发）；成功统一推送（全部账号满额后统一推一次总览，或手动全跑时推）
      const todayKey = this.getTodayNum();
      const allFinishedToday = allAccounts.length > 0 && allAccounts.every(acc => {
        const st = this.ensureAccountStats(acc.id);
        const tVals = Object.values(st.tasks || {});
        return tVals.length > 0 && tVals.every(t => t.done || (t.max > 0 && t.progress >= t.max));
      });

      const shouldSendUnifiedReport = (!isSingleRun && manual) || (allFinishedToday && this.lastUnifiedReportDate !== todayKey);
      if (shouldSendUnifiedReport) {
        this.lastUnifiedReportDate = todayKey;
        await notifier.send('微软积分每日打卡总览报告', summaryMsg);
      }
      return true;
    } catch (e) {
      logger.log('🔴', `任务执行过程发生异常: ${e.message}`);
      return false;
    } finally {
      this.running = false;
      this.runningAccountId = null;
      logger.setAccountContext('');
      accountContextLock.release('task-run');
      // 任务结束：关闭共享抓取浏览器，释放内存
      try { await browserManager.closeSharedFetcher(); } catch {}
      // 任务级内存峰值快照（tini 回收僵尸后再看这个数字才准确）
      try { memorySampler.commitRun('task-run'); } catch {}
    }
  }
}

export const taskManager = new TaskManager();
export default taskManager;

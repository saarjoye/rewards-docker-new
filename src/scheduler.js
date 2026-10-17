import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import configManager from './config.js';
import logger from './logger.js';
import taskManager from './core/taskManager.js';
import epicManager from './core/epic.js';
import { DATA_DIR, writeFileAtomic } from './fsUtil.js';

const PLAN_FILE = path.join(DATA_DIR, 'schedule_plan.json');

// 计划文件 schema 版本。每次修复调度语义（例如 executed 时序、跳过规则）就 +1，
// 启动时发现旧版本会整份作废重排，避免旧数据把新逻辑带偏（升级后「一个都不跑」的元凶）。
const PLAN_SCHEMA = 3;

class Scheduler {
  constructor() {
    this.job = null;
    this.epicJob = null;
    this.plannedDailyRuns = {};
    this.loadPlans();
  }

  loadPlans() {
    try {
      if (!fs.existsSync(PLAN_FILE)) return;
      const raw = fs.readFileSync(PLAN_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      // 旧版计划没有 schema 字段（或版本不符）→ 整份作废，让新逻辑重新排期。
      // 否则升级后 executed=true 的残留会让当天所有账号直接跳过。
      if (parsed.schema !== PLAN_SCHEMA) {
        console.warn(`[Scheduler] 计划文件版本不符（${parsed.schema ?? 'none'} != ${PLAN_SCHEMA}），已丢弃旧计划重新排期`);
        this.plannedDailyRuns = {};
        try { fs.unlinkSync(PLAN_FILE); } catch {}
        return;
      }
      if (parsed.days && typeof parsed.days === 'object') {
        this.plannedDailyRuns = parsed.days;
      }
    } catch {}
  }

  savePlans() {
    try {
      writeFileAtomic(PLAN_FILE, JSON.stringify({
        schema: PLAN_SCHEMA,
        savedAt: Date.now(),
        days: this.plannedDailyRuns
      }, null, 2), {
        encoding: 'utf-8',
        mode: 0o600
      });
    } catch {}
  }

  getTodayNum() {
    const d = new Date();
    return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
  }

  /**
   * 当前时刻距离窗口起点的分钟数（支持跨零点窗口，如 22:00 - 02:00）。
   * 返回值 < 0 表示还没进入窗口。
   */
  minutesIntoWindow(startMin, wraps, nowMin) {
    return wraps
      ? (nowMin >= startMin ? nowMin - startMin : 1440 - startMin + nowMin)
      : (nowMin - startMin);
  }

  initTodayPlan() {
    const today = this.getTodayNum();
    this.ensureDayPlans(today, true);

    // 只清理历史日期，保留今天与预排的明天
    const todayKey = String(today);
    for (const key of Object.keys(this.plannedDailyRuns)) {
      if (key < todayKey) delete this.plannedDailyRuns[key];
    }
    this.savePlans();
  }

  /**
   * 为指定日期生成各账号的当日计划。
   *
   * 关键规则（v1.7.3 修复）：
   *   1. 时段配置变了（startHour/endHour）→ 必须重算，否则改了时间永远不生效；
   *   2. 窗口已过（现在是 14 点、窗口 9-13）→ 标记 skipped，不把当天计划白白耗掉；
   *   3. 计划只在「真的成功交给任务执行器」后才置 executed=true，
   *      启动失败要能重试（旧实现先置位再跑，一次地区检测失败就永久跳过当天）。
   */
  ensureDayPlans(dateNum, isToday) {
    const key = String(dateNum);
    if (!this.plannedDailyRuns[key]) {
      this.plannedDailyRuns[key] = {};
    }
    const plans = this.plannedDailyRuns[key];
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();

    const accounts = configManager.getAccounts().filter(a => a.enabled !== false);
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      const slot = acc.timeSlot || configManager.getDefaultTimeSlot(i);
      const startHour = Number(slot.startHour ?? 9);
      const endHour = Number(slot.endHour ?? ((startHour + 4) % 24));
      const startMin = startHour * 60;
      const endMin = endHour * 60;
      // 支持跨零点窗口（例如 22:00 - 02:00）
      const wraps = endMin <= startMin;
      const windowLength = wraps ? (1440 - startMin + endMin) : (endMin - startMin);

      const existing = plans[acc.id];
      // 配置变更检测：时段变了就丢弃旧计划重排
      if (existing && (existing.startMin !== startMin || existing.endMin !== endMin)) {
        delete plans[acc.id];
      }
      if (plans[acc.id]) continue;

      // 窗口内随机偏移 0 ~ randomDelayMin 分钟
      const maxDelay = Math.max(1, Math.min(59, Number(slot.randomDelayMin) || 60));
      let offset = Math.floor(Math.random() * maxDelay);

      if (isToday) {
        const nowOffset = this.minutesIntoWindow(startMin, wraps, nowMin);
        const inWindow = nowOffset >= 0 && nowOffset < windowLength;
        // 当天窗口已经过去（例如现在是 15:00，窗口 9-13）→ 今天不再排，
        // 明确记录 skipped，避免 UI 一直显示「即将启动」却永远不跑。
        if (!inWindow && nowOffset >= windowLength) {
          plans[acc.id] = {
            startMin, endMin, wraps, windowLength,
            offset,
            executed: false,
            skipped: true,
            skippedReason: 'window-passed',
            plannedAt: this.planTimestamp(dateNum, { startMin, offset }).valueOf()
          };
          continue;
        }
        // 容器在窗口中途启动时不要立刻开跑，仍然随机延后 1~20 分钟（保持拟人化）
        if (inWindow && nowOffset >= offset) {
          offset = Math.min(windowLength - 1, nowOffset + 1 + Math.floor(Math.random() * 20));
        }
      }

      plans[acc.id] = {
        startMin,
        endMin,
        wraps,
        windowLength,
        offset,
        executed: false,
        skipped: false,
        plannedAt: this.planTimestamp(dateNum, { startMin, offset }).valueOf()
      };
    }
    this.savePlans();
  }

  /** 日期编号（YYYYMMDD）偏移若干天 */
  shiftDateNum(dateNum, deltaDays) {
    const d = new Date(
      Math.floor(dateNum / 10000),
      Math.floor((dateNum % 10000) / 100) - 1,
      dateNum % 100,
      12, 0, 0, 0
    );
    d.setDate(d.getDate() + deltaDays);
    return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
  }

  /** 某天计划的绝对执行时间戳（窗口起点日 + 偏移分钟） */
  planTimestamp(dateNum, plan, baseDayOffset = 0) {
    const base = new Date(
      Math.floor(dateNum / 10000),
      Math.floor((dateNum % 10000) / 100) - 1,
      dateNum % 100
    );
    if (baseDayOffset) base.setDate(base.getDate() + baseDayOffset);
    return base.getTime() + (plan.startMin + plan.offset) * 60000;
  }

  /**
   * 供 WebUI 展示：每个账号距下次自动执行的倒计时。
   * 返回 { [accountId]: { status, minutesUntil, nextRunAt, windowStart, windowEnd } }
   * status: scheduled(已排定) / imminent(即将启动)
   *         / no-credential(未配凭据) / disabled(账号停用) / schedule-off(定时关闭)
   *         / done-today(今日已完成) / window-passed(今日窗口已过)
   */
  getNextRunInfo() {
    const cfg = configManager.get();
    const scheduleEnabled = cfg.schedule?.enabled !== false;
    const today = this.getTodayNum();
    const tomorrow = this.shiftDateNum(today, 1);

    if (scheduleEnabled) {
      this.initTodayPlan();
      // 预排明天：这样「今日已完成」的账号也能给出确切的下次执行倒计时
      this.ensureDayPlans(tomorrow, false);
    }

    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const todayPlans = this.plannedDailyRuns[String(today)] || {};
    const tomorrowPlans = this.plannedDailyRuns[String(tomorrow)] || {};
    const fmt = (m) => `${String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;
    const result = {};

    configManager.getAccounts().forEach((acc, index) => {
      const slot = acc.timeSlot || configManager.getDefaultTimeSlot(index);
      const startHour = slot.startHour ?? 9;
      const endHour = slot.endHour ?? ((startHour + 4) % 24);
      const info = {
        status: 'unknown',
        minutesUntil: null,
        nextRunAt: null,
        windowStart: fmt(startHour * 60),
        windowEnd: fmt(endHour * 60)
      };

      if (acc.enabled === false) {
        info.status = 'disabled';
      } else if (!acc.cookie && !acc.refreshToken) {
        info.status = 'no-credential';
      } else if (!scheduleEnabled) {
        info.status = 'schedule-off';
      } else {
        const todayPlan = todayPlans[acc.id];
        const tomorrowPlan = tomorrowPlans[acc.id];
        let nextAt = null;

        if (todayPlan && !todayPlan.executed && !todayPlan.skipped) {
          const plannedAt = todayPlan.plannedAt || this.planTimestamp(today, todayPlan);
          if (plannedAt > now.getTime()) {
            nextAt = plannedAt;
          } else {
            const nowOffset = this.minutesIntoWindow(todayPlan.startMin, todayPlan.wraps, nowMin);
            const inWindow = nowOffset >= 0 && nowOffset < todayPlan.windowLength;
            if (inWindow) nextAt = now.getTime(); // 窗口内，调度器下一分钟启动
          }
        }
        // 今天已经跑过 / 今天窗口已过 → 直接给明天的确切时间
        if (nextAt === null && tomorrowPlan) {
          nextAt = tomorrowPlan.plannedAt || this.planTimestamp(tomorrow, tomorrowPlan, 0);
        }

        if (todayPlan?.executed) {
          info.status = 'done-today';
        } else if (todayPlan?.skipped) {
          info.status = 'window-passed';
        }

        if (nextAt !== null) {
          info.nextRunAt = nextAt;
          info.minutesUntil = Math.max(0, Math.round((nextAt - now.getTime()) / 60000));
          if (!info.status || info.status === 'unknown') {
            info.status = info.minutesUntil <= 0 ? 'imminent' : 'scheduled';
          }
        }
      }
      result[acc.id] = info;
    });

    return result;
  }

  start() {
    this.stop();
    const cfg = configManager.get();
    if (!cfg.schedule?.enabled) {
      logger.log('⏸️', '后台自动定时巡检当前已禁用');
      // Epic 自动领取独立于微软定时开关
      this.startEpicJob();
      return;
    }

    // 每分钟检查一次拟人化时段调度
    // 诊断：每小时整点记录一次每个账号的调度判定，便于回答「为什么没跑」
    let lastDiagMinute = -1;
    this.job = cron.schedule('* * * * *', async () => {
      if (taskManager.running) return;

      const today = this.getTodayNum();
      this.initTodayPlan();

      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const todayPlans = this.plannedDailyRuns[today] || {};


      const accounts = configManager.getAccounts().filter(a => a.enabled !== false);

      // 每小时输出一次诊断快照（只读，不改变调度行为）
      if (nowMin % 60 === 0 && lastDiagMinute !== nowMin) {
        lastDiagMinute = nowMin;
        const noCred = accounts.filter(a => !a.cookie && !a.refreshToken).map(a => a.name || a.id);
        const summary = accounts.map(a => {
          const pl = todayPlans[a.id];
          if (!pl) return `${a.name || a.id}:无计划`;
          if (pl.executed) return `${a.name || a.id}:今日已执行`;
          if (pl.skipped) return `${a.name || a.id}:窗口已过`;
          const off = this.minutesIntoWindow(pl.startMin, pl.wraps, nowMin);
          const inWin = off >= 0 && off < pl.windowLength;
          return `${a.name || a.id}:${inWin ? '窗口内' : '未到窗口'}(起点${Math.floor(pl.startMin / 60)}:${String(pl.startMin % 60).padStart(2, '0')},偏移${pl.offset}分)`;
        });
        logger.log('🕒', `调度诊断 ${String(Math.floor(nowMin / 60)).padStart(2, '0')}:${String(nowMin % 60).padStart(2, '0')} | ${summary.join(' | ')}${noCred.length ? ` | 无凭据:${noCred.join(',')}` : ''}`);
      }
      for (const acc of accounts) {
        if (!acc.cookie && !acc.refreshToken) continue;

        const plan = todayPlans[acc.id];
        if (!plan || plan.executed || plan.skipped) continue;

        // 距离窗口起点的分钟数（跨零点窗口也能正确计算）
        const nowOffset = this.minutesIntoWindow(plan.startMin, plan.wraps, nowMin);

        const inWindow = nowOffset >= 0 && nowOffset < plan.windowLength;
        if (inWindow && nowOffset >= plan.offset) {
          const fmt = (m) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
          logger.log('⏰', `到达账号 [${acc.name}] 拟人作息窗口 (${fmt(plan.startMin)} - ${fmt(plan.endMin)}，今日随机命中 ${fmt(plan.startMin + plan.offset)})，启动打卡...`, '', acc.name);
          // 注意：先不落盘 executed=true。等 runAll 真正开始执行（返回 true）后再置位，
          // 否则一次地区检测失败 / 锁超时就会让该账号当天永久跳过。
          let ok = false;
          try {
            ok = await taskManager.runAll(false, acc.id);
          } catch (e) {
            logger.log('🔴', `定时任务执行异常: ${e.message}`, '', acc.name);
          }
          if (ok) {
            plan.executed = true;
            this.savePlans();
          } else {
            // 失败：保持未执行，但把 offset 往后推 15~25 分钟再重试，
            // 避免同一分钟反复失败刷屏。
            plan.offset = Math.min(plan.windowLength - 1, plan.offset + 15 + Math.floor(Math.random() * 10));
            plan.plannedAt = this.planTimestamp(today, plan).valueOf();
            this.savePlans();
            logger.log('🟡', `账号 [${acc.name}] 本次启动未成功，已推迟到 ${fmt(plan.startMin + plan.offset)} 重试`, '', acc.name);
          }
          break; // 一次只启动一个账号，保持单队列
        }
      }
    });

    logger.log('🟢', `后台时段拟人调度引擎已就绪 (9-13 / 13-17 / 17-21 / 21-次日01 时段错峰 + 60分钟随机浮动)`);
    this.startEpicJob();
  }

  /** Epic 免费游戏：按设置的检查间隔轮询，发现未领取的才真正触发领取 */
  startEpicJob() {
    if (this.epicJob) {
      this.epicJob.stop();
      this.epicJob = null;
    }
    const settings = epicManager.getSettings();
    if (!settings.enabled) {
      logger.log('⏸️', 'Epic 免费游戏自动领取已禁用');
      return;
    }

    // 每分钟判断一次是否到达「检查间隔」
    this.epicJob = cron.schedule('* * * * *', async () => {
      if (epicManager.running) return;
      const s = epicManager.getSettings();
      if (!s.enabled) return;

      const accounts = configManager.getEpicAccounts().filter(a => a.enabled !== false && a.storageState?.cookies?.length);
      if (accounts.length === 0) return;

      const elapsedMin = (Date.now() - epicManager.lastCheckAt) / 60000;
      if (epicManager.lastCheckAt && elapsedMin < s.checkIntervalMin) return;

      try {
        await epicManager.checkAndClaimIfNeeded();
      } catch (e) {
        logger.log('🔴', `Epic 定时检查异常: ${e.message}`);
      }
    });

    logger.log('🎮', `Epic 免费游戏自动领取已就绪（每 ${settings.checkIntervalMin} 分钟检查一次，失败重试 ${s.retryCount} 次）`);
  }

  stop() {
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
    if (this.epicJob) {
      this.epicJob.stop();
      this.epicJob = null;
    }
  }

  restart() {
    this.start();
  }
}

export const scheduler = new Scheduler();
export default scheduler;

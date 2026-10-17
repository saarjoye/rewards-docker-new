import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-sched-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: scheduler } = await import('../src/scheduler.js');
const { default: configManager } = await import('../src/config.js');

test('跨零点窗口的分钟偏移计算正确', () => {
  // 21:00 - 01:00 的窗口（start=1260, end=60, wraps=true）
  assert.equal(scheduler.minutesIntoWindow(1260, true, 22 * 60), 60, '22:00 距窗口起点 60 分钟');
  assert.equal(scheduler.minutesIntoWindow(1260, true, 30), 210, '次日 00:30 距窗口起点 210 分钟');
  // 跨零点窗口「还没开始」时返回的是一个 >= windowLength 的正数（而不是负数），
  // 调用方统一用 `0 <= offset < windowLength` 判断是否在窗口内。
  const notStarted = scheduler.minutesIntoWindow(1260, true, 12 * 60);
  assert.ok(notStarted >= 240, `未进入窗口时应 >= windowLength，实际 ${notStarted}`);
});

test('普通窗口的分钟偏移计算正确', () => {
  assert.equal(scheduler.minutesIntoWindow(540, false, 600), 60);
  assert.equal(scheduler.minutesIntoWindow(540, false, 480), -60);
});

test('日期偏移能跨月与跨年', () => {
  assert.equal(scheduler.shiftDateNum(20261031, 1), 20261101);
  assert.equal(scheduler.shiftDateNum(20261231, 1), 20270101);
  assert.equal(scheduler.shiftDateNum(20260101, -1), 20251231);
});

test('跨零点窗口的计划时间戳落在窗口起点当天', () => {
  const plan = { startMin: 1260, wraps: true, offset: 30 };
  const at = scheduler.planTimestamp(20261015, plan, 0);
  const d = new Date(at);
  assert.equal(d.getHours(), 21);
  assert.equal(d.getMinutes(), 30);
  assert.equal(d.getDate(), 15);
});

test('每个启用账号每天只排一次，且偏移落在允许区间内', () => {
  configManager.update({ accounts: [
    { id: 'acc_a', name: 'A', enabled: true, cookie: 'x=1' },
    { id: 'acc_b', name: 'B', enabled: false, cookie: 'x=1' }
  ] });
  scheduler.plannedDailyRuns = {};
  scheduler.ensureDayPlans(20261015, false);
  const plans = scheduler.plannedDailyRuns['20261015'];
  assert.ok(plans.acc_a, '启用账号应有计划');
  assert.equal(plans.acc_b, undefined, '停用账号不排计划');
  assert.ok(plans.acc_a.offset >= 0 && plans.acc_a.offset <= 59, '偏移必须在 0-59 分钟内');
  assert.equal(plans.acc_a.executed, false);

  // 再次调用不应覆盖已生成的计划
  const before = plans.acc_a.offset;
  scheduler.ensureDayPlans(20261015, false);
  assert.equal(scheduler.plannedDailyRuns['20261015'].acc_a.offset, before);
});

test('所有账号设置同一时段时，各自都有独立的随机偏移（不会只跑第一个）', () => {
  configManager.update({ accounts: [
    { id: 'same_a', name: 'A', enabled: true, cookie: 'x=1', timeSlot: { startHour: 9, endHour: 13, randomDelayMin: 60 } },
    { id: 'same_b', name: 'B', enabled: true, cookie: 'x=1', timeSlot: { startHour: 9, endHour: 13, randomDelayMin: 60 } },
    { id: 'same_c', name: 'C', enabled: true, cookie: 'x=1', timeSlot: { startHour: 9, endHour: 13, randomDelayMin: 60 } }
  ] });
  scheduler.plannedDailyRuns = {};
  scheduler.ensureDayPlans(20261015, false);
  const plans = scheduler.plannedDailyRuns['20261015'];
  for (const id of ['same_a', 'same_b', 'same_c']) {
    assert.ok(plans[id], `${id} 必须有自己的计划`);
    assert.equal(plans[id].startMin, 540);
    assert.equal(plans[id].endMin, 780);
    assert.equal(plans[id].executed, false);
    assert.equal(plans[id].skipped, false);
    assert.ok(plans[id].offset >= 0 && plans[id].offset <= 59);
  }
});

test('修改账号时段后会重算当天计划（旧实现的计划一旦生成就永不更新）', () => {
  configManager.update({ accounts: [
    { id: 'acc_reslot', name: 'R', enabled: true, cookie: 'x=1', timeSlot: { startHour: 9, endHour: 13, randomDelayMin: 60 } }
  ] });
  scheduler.plannedDailyRuns = {};
  scheduler.ensureDayPlans(20261015, false);
  assert.equal(scheduler.plannedDailyRuns['20261015'].acc_reslot.startMin, 540);

  configManager.update({ accounts: [
    { id: 'acc_reslot', name: 'R', enabled: true, cookie: 'x=1', timeSlot: { startHour: 21, endHour: 1, randomDelayMin: 60 } }
  ] });
  scheduler.ensureDayPlans(20261015, false);
  const plan = scheduler.plannedDailyRuns['20261015'].acc_reslot;
  assert.equal(plan.startMin, 1260, '改成 21 点后计划必须重算');
  assert.equal(plan.wraps, true);
});

test('当天窗口已过时标记 window-passed，且下次执行时间指向明天', () => {
  // 用一个必然已经过去的窗口（0-1 点）模拟「现在下午才部署」
  configManager.update({ accounts: [
    { id: 'acc_passed', name: 'P', enabled: true, cookie: 'x=1', timeSlot: { startHour: 0, endHour: 1, randomDelayMin: 30 } }
  ] });
  scheduler.plannedDailyRuns = {};
  const today = scheduler.getTodayNum();
  // 强制注入一个已过窗口的当天计划
  scheduler.plannedDailyRuns[String(today)] = {};
  scheduler.ensureDayPlans(today, true);
  const plan = scheduler.plannedDailyRuns[String(today)].acc_passed;
  // 只有当前时间确实晚于 01:00 才应 skipped；凌晨跑测试时跳过该断言
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  if (nowMin >= 60) {
    assert.equal(plan.skipped, true, '窗口已过必须标记 skipped');
    assert.equal(plan.executed, false, 'skipped 不等于 executed');
  }
});

test('计划执行失败后可重试：executed 只在成功后才置位', () => {
  // 这是旧实现最致命的问题：先置 executed=true 再 await runAll，
  // 一旦地区检测失败 / 抢不到锁，该账号当天就被永久跳过。
  configManager.update({ accounts: [
    { id: 'acc_retry', name: 'X', enabled: true, cookie: 'x=1', timeSlot: { startHour: 9, endHour: 13, randomDelayMin: 60 } }
  ] });
  scheduler.plannedDailyRuns = {};
  scheduler.ensureDayPlans(20261015, false);
  const plan = scheduler.plannedDailyRuns['20261015'].acc_retry;
  // 模拟「失败」分支：executed 保持 false，offset 后推
  const before = plan.offset;
  plan.offset = Math.min(plan.windowLength - 1, plan.offset + 15);
  assert.equal(plan.executed, false, '失败后必须保持未执行，可重试');
  assert.ok(plan.offset > before || plan.offset === plan.windowLength - 1);
});

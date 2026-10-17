import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-earned-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: rewardsApi } = await import('../src/core/api.js');
const { TaskManager } = await import('../src/core/taskManager.js');

function stubRewardsInfo(mockInfo) {
  const origGetRewards = rewardsApi.getRewardsInfo;
  const origStreak = rewardsApi.checkStreak;
  rewardsApi.getRewardsInfo = async () => mockInfo;
  rewardsApi.checkStreak = async () => ({ streakDays: 5 });
  return () => {
    rewardsApi.getRewardsInfo = origGetRewards;
    rewardsApi.checkStreak = origStreak;
  };
}

test('官网同步：今日积分取不到时，不得把「今日已增」清零', async () => {
  const tm = new TaskManager();
  const accId = 'acc_earned_preserve';
  const accCfg = { id: accId, name: '积分保留测试', cookie: 'MOCK_COOKIE' };
  const st0 = tm.ensureAccountStats(accId);

  // 先构造一个「今天已经赚了 42 分」的既有展示状态
  st0.balance = 1000;
  st0.startBalance = 958;
  st0.startBalanceDate = tm.getTodayNum();
  st0.earned = 42;
  st0.earnedSource = 'official';

  // 官网页面这次没解析出今日积分（todayPoints 为 null），余额也没变化
  const mockInfo = { balance: 1000, todayPoints: null, quests: [] };
  const restore = stubRewardsInfo(mockInfo);
  try {
    await tm.syncAccountOfficialStatus(accCfg, { owned: true });
    const st = tm.ensureAccountStats(accId);
    assert.equal(st.earned, 42, '官网没取到今日积分时，必须保留已有的今日已增，而不是清零');
  } finally {
    restore();
  }
});

test('官网同步：当天首次同步只记录起始余额，不得把历史 earned 清零', async () => {
  const tm = new TaskManager();
  const accId = 'acc_earned_first_sync';
  const accCfg = { id: accId, name: '首次同步测试', cookie: 'MOCK_COOKIE' };
  const st0 = tm.ensureAccountStats(accId);

  // 场景：换天后的第一次同步，startBalance 尚未记录，但 earned 已经由任务流程累加过
  st0.balance = 500;
  st0.startBalance = 0;
  st0.startBalanceDate = 0;
  st0.earned = 18;
  st0.earnedSource = 'official';

  const mockInfo = { balance: 500, todayPoints: null, quests: [] };
  const restore = stubRewardsInfo(mockInfo);
  try {
    await tm.syncAccountOfficialStatus(accCfg, { owned: true });
    const st = tm.ensureAccountStats(accId);
    assert.equal(st.startBalance, 500, '应记录今天的起始余额');
    assert.equal(st.startBalanceDate, tm.getTodayNum());
    assert.equal(st.earned, 18, '当天首次同步刚记录起始余额时，不能把 earned 覆盖成 0');
  } finally {
    restore();
  }
});

test('官网同步：官网明确给出今日积分 0 时，应如实写入 0', async () => {
  const tm = new TaskManager();
  const accId = 'acc_earned_zero';
  const accCfg = { id: accId, name: '官网零分测试', cookie: 'MOCK_COOKIE' };
  const st0 = tm.ensureAccountStats(accId);

  st0.balance = 700;
  st0.startBalance = 700;
  st0.startBalanceDate = tm.getTodayNum();
  st0.earned = 30;

  const mockInfo = { balance: 700, todayPoints: 0, quests: [] };
  const restore = stubRewardsInfo(mockInfo);
  try {
    await tm.syncAccountOfficialStatus(accCfg, { owned: true });
    const st = tm.ensureAccountStats(accId);
    assert.equal(st.earned, 0, '官网明确说今日 0 分时应写入 0');
    assert.equal(st.earnedSource, 'official');
  } finally {
    restore();
  }
});

test('官网同步：取不到今日积分时不得用余额差改写今日已增', async () => {
  const tm = new TaskManager();
  const accId = 'acc_earned_delta';
  const accCfg = { id: accId, name: '余额差测试', cookie: 'MOCK_COOKIE' };
  const st0 = tm.ensureAccountStats(accId);

  // 今天早些时候已记录起始余额 100，现在余额涨到 130，官网今日积分解析失败
  st0.startBalance = 100;
  st0.startBalanceDate = tm.getTodayNum();
  st0.balance = 130;
  st0.earned = 0;

  const mockInfo = { balance: 130, todayPoints: null, quests: [] };
  const restore = stubRewardsInfo(mockInfo);
  try {
    await tm.syncAccountOfficialStatus(accCfg, { owned: true });
    const st = tm.ensureAccountStats(accId);
    assert.notEqual(st.earned, 30, '余额差不得写入今日已增');
    assert.equal(st.earned, 0, '从未读到官网值时应保持 0');
  } finally {
    restore();
  }
});

test('官网同步：余额没有变化且取不到今日积分时，保留原值而非写 0', async () => {
  const tm = new TaskManager();
  const accId = 'acc_earned_nodelta';
  const accCfg = { id: accId, name: '余额未变测试', cookie: 'MOCK_COOKIE' };
  const st0 = tm.ensureAccountStats(accId);

  st0.startBalance = 200;
  st0.startBalanceDate = tm.getTodayNum();
  st0.balance = 200;
  st0.earned = 15;

  const mockInfo = { balance: 200, todayPoints: null, quests: [] };
  const restore = stubRewardsInfo(mockInfo);
  try {
    await tm.syncAccountOfficialStatus(accCfg, { owned: true });
    const st = tm.ensureAccountStats(accId);
    assert.equal(st.earned, 15, '余额差为 0 时不能覆盖原有 earned');
  } finally {
    restore();
  }
});
test('官网同步：余额差不得覆盖官网已给出的今日积分（官网145 / 余额差513回归）', async () => {
  const tm = new TaskManager();
  const accId = 'acc_earned_official_wins';
  const accCfg = { id: accId, name: '官网优先测试', cookie: 'MOCK_COOKIE' };
  const st0 = tm.ensureAccountStats(accId);

  // 官网页面已经给出今日积分 145
  st0.balance = 13510;
  st0.startBalance = 12997; // 余额差 = 513
  st0.startBalanceDate = tm.getTodayNum();
  st0.earned = 145;
  st0.earnedSource = 'official';

  // 本轮官网页面解析失败（todayPoints=null），旧逻辑会回退余额差把 145 冲成 513
  const mockInfo = { balance: 13510, todayPoints: null, quests: [] };
  const restore = stubRewardsInfo(mockInfo);
  try {
    await tm.syncAccountOfficialStatus(accCfg, { owned: true });
    const st = tm.ensureAccountStats(accId);
    assert.equal(st.earned, 145, '官网已给出的确切值不能被余额差兜底覆盖');
    assert.equal(st.earnedSource, 'official');
  } finally {
    restore();
  }
});

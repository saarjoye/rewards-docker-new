import test from 'node:test';
import assert from 'node:assert/strict';
import networkClient from '../src/network.js';
import rewardsApi from '../src/core/api.js';

/**
 * 用最小化的官网页面片段做解析回归。
 * 这些解析是整条链路最脆弱的部分（微软一改版就会失效），
 * 至少保证「字段位置变了」能在测试里立刻暴露。
 */
const EARN_FIXTURE = `
<script>self.__next_f.push([1,"x:\\"pointsCounters\\":{\\"dailyOffer\\":77,\\"pc\\":{\\"max\\":60,\\"progress\\":60,\\"originalMax\\":60},\\"totalPoints\\":137,\\"boostActivated\\":false}"])</script>
<script>self.__next_f.push([1,"y:\\"balance\\":51355,\\"availablePoints\\":51355"])</script>
<script>self.__next_f.push([1,"a:\\"children\\":\\"今日积分\\",\\"b\\":{\\"className\\":\\"text-pageHeader\\",\\"children\\":\\"137\\"}"])</script>
<script>self.__next_f.push([1,"b:\\"partner\\":\\"bingapp\\",\\"isCurrentDayCompleted\\":true,\\"completedDays\\":4,\\"currentDay\\":3,\\"activitiesCompleted\\":1,\\"activitiesTotal\\":1,\\"c\\":1"])</script>
<script>self.__next_f.push([1,"c:\\"activityCards\\":[{\\"isCompleted\\":true,\\"offerId\\":\\"A\\"},{\\"isCompleted\\":false,\\"offerId\\":\\"B\\"}]"])</script>
<script>self.__next_f.push([1,"d:\\"href\\":\\"/earn/quest/ENWW_pcparent_FY27_BingMonthlyPC_Oct_punchcard\\""])</script>
`;

function withRoutedNetwork(routes, fn) {
  const origRequest = networkClient.request;
  const origRead = rewardsApi.getReadProgress;
  const origBalance = rewardsApi.getBalance;
  networkClient.request = async (options) => {
    const url = String(options?.url || '');
    if (url.includes('panelflyout/getuserinfo')) return routes.flyout ?? '';
    if (url.includes('/dashboard')) return routes.dashboard ?? '';
    if (url.includes('/earn')) return routes.earn ?? '';
    throw new Error('unexpected request: ' + url);
  };
  rewardsApi.getReadProgress = async () => null;
  rewardsApi.getBalance = async () => null;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      networkClient.request = origRequest;
      rewardsApi.getReadProgress = origRead;
      rewardsApi.getBalance = origBalance;
    });
}

function withStubbedNetwork(html, fn) {
  const origRequest = networkClient.request;
  const origRead = rewardsApi.getReadProgress;
  const origBalance = rewardsApi.getBalance;
  networkClient.request = async () => html;
  rewardsApi.getReadProgress = async () => null;
  rewardsApi.getBalance = async () => null;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      networkClient.request = origRequest;
      rewardsApi.getReadProgress = origRead;
      rewardsApi.getBalance = origBalance;
    });
}

test('getRewardsInfo 解析官网「今日积分」与余额', async () => {
  await withStubbedNetwork(EARN_FIXTURE, async () => {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.ok(info, '应返回解析结果');
    assert.equal(info.todayPoints, 137, '今日积分必须来自官网卡片');
    assert.equal(info.balance, 51355);
    assert.deepEqual(info.pc, { progress: 60, max: 60 });
  });
});

test('getRewardsInfo 今日积分以 earn 页面为准，flyout 只作兜底', async () => {
  const flyoutFixture = JSON.stringify({
    userInfo: { balance: 3984 },
    flyoutResult: {
      userStatus: {
        availablePoints: 3984,
        totalBalance: 3984,
        counters: {
          PCSearch: [{ pointProgress: 12, pointProgressMax: 60 }],
          DailyPoint: [{ pointProgress: 600, pointProgressMax: 3805 }]
        }
      }
    }
  });

  await withRoutedNetwork({ earn: EARN_FIXTURE, dashboard: '', flyout: flyoutFixture }, async () => {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.ok(info, '应返回解析结果');
    assert.equal(info.todayPoints, 137, '今日积分应以 earn 页面为准（flyout 的 DailyPoint 是另一个口径）');
    assert.equal(info.balance, 3984, '余额应优先取 panelflyout');
    assert.deepEqual(info.pc, { progress: 12, max: 60 }, 'PC 搜索进度应取 panelflyout');
  });
});

test('parseFlyoutRewardsInfo 兼容 JSON 字符串与大小写不同的计数器字段', async () => {
  const raw = JSON.stringify({
    userInfo: { balance: '4,123' },
    flyoutResult: {
      userStatus: {
        counters: {
          dailyPoint: { pointProgress: '641' },
          pcSearch: { pointProgress: '20', pointProgressMax: '60' }
        }
      }
    }
  });
  const parsed = rewardsApi.parseFlyoutRewardsInfo(raw);
  assert.equal(parsed.todayPoints, 641);
  assert.equal(parsed.balance, 4123);
  assert.deepEqual(parsed.pc, { progress: 20, max: 60 });
});

test('getRewardsInfo 解析必应应用连签真实状态', async () => {
  await withStubbedNetwork(EARN_FIXTURE, async () => {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.equal(info.streaks.bingapp.isCurrentDayCompleted, true);
    assert.equal(info.streaks.bingapp.completedDays, 4);
  });
});

test('getActivityCardStatus 统计 activityCards 完成情况', async () => {
  await withStubbedNetwork(EARN_FIXTURE, async () => {
    const status = await rewardsApi.getActivityCardStatus();
    assert.deepEqual(status, { total: 2, completed: 1, readable: true, reason: null });
  });
});

test('getActivityCardStatus 读不到卡片时给出可诊断原因（不再静默返回 null）', async () => {
  await withStubbedNetwork('<html><body>login.live.com Sign in</body></html>', async () => {
    const status = await rewardsApi.getActivityCardStatus();
    assert.equal(status.readable, false);
    assert.equal(status.reason, 'not-signed-in');
    assert.equal(status.total, 0);
  });
});

test('getActivityCardStatus 页面改版导致找不到 activityCards 时有明确原因', async () => {
  await withStubbedNetwork('<html><body>no cards here</body></html>', async () => {
    const status = await rewardsApi.getActivityCardStatus();
    assert.equal(status.readable, false);
    assert.equal(status.reason, 'activity-cards-not-found');
  });
});

test('getActivityCardStatus 兼容双重转义 + 空数组（readable 且 total=0）', async () => {
  const fixture = '<script>self.__next_f.push([1,"z:\\"activityCards\\":[]"])</script>';
  await withStubbedNetwork(fixture, async () => {
    const status = await rewardsApi.getActivityCardStatus();
    assert.equal(status.readable, true);
    assert.equal(status.total, 0);
  });
});

test('getQuestPunchCards 提取任务区打孔卡链接', async () => {
  await withStubbedNetwork(EARN_FIXTURE, async () => {
    const quests = await rewardsApi.getQuestPunchCards();
    assert.equal(quests.length, 1);
    assert.equal(quests[0].questId, 'ENWW_pcparent_FY27_BingMonthlyPC_Oct_punchcard');
    assert.match(quests[0].url, /^https:\/\/rewards\.bing\.com\/earn\/quest\//);
  });
});

test('discoverCards 给卡片打上分类，供独立开关过滤', async () => {
  const cardsFixture = `
  <script>self.__next_f.push([1,"a:{\\"offerId\\":\\"Gamification_DailySet_ZHCN_20261015_Child1\\",\\"hash\\":\\"h1\\",\\"points\\":10,\\"title\\":\\"每日活动\\"}"])</script>
  <script>self.__next_f.push([1,"b:{\\"offerId\\":\\"ZHstar_Rewards_DailyGlobalOffer_Evergreen_Monday\\",\\"hash\\":\\"h2\\",\\"points\\":5,\\"title\\":\\"拼图\\"}"])</script>
  `;
  await withStubbedNetwork(cardsFixture, async () => {
    const cards = await rewardsApi.discoverCards();
    const byId = Object.fromEntries(cards.map(c => [c.offerId, c.category]));
    assert.equal(byId['Gamification_DailySet_ZHCN_20261015_Child1'], 'dailyset');
    assert.equal(byId['ZHstar_Rewards_DailyGlobalOffer_Evergreen_Monday'], 'promo');
  });
});

test('discoverCards 能解析带嵌套字段的卡片对象（旧正则失配回归）', async () => {
  const fixture = '<script>self.__next_f.push([1,"a:{\\"offerId\\":\\"ZHstar_Rewards_DailyGlobalOffer_Evergreen_Monday\\",\\"hash\\":\\"h2\\",\\"points\\":5,\\"attributes\\":{\\"x\\":1},\\"destination\\":{\\"url\\":\\"/earn\\"},\\"title\\":\\"拼图\\"}"])</script>';
  await withStubbedNetwork(fixture, async () => {
    const cards = await rewardsApi.discoverCards();
    assert.equal(cards.length, 1);
    assert.equal(cards[0].offerId, 'ZHstar_Rewards_DailyGlobalOffer_Evergreen_Monday');
    assert.equal(cards[0].kind, 'puzzle');
  });
});

test('earn 页面解析不到今日积分时，才回退到 flyout', async () => {
  const flyoutFixture = JSON.stringify({
    userInfo: { balance: 3984 },
    flyoutResult: {
      userStatus: {
        availablePoints: 3984,
        counters: { DailyPoint: [{ pointProgress: 145 }] }
      }
    }
  });
  const pageWithoutToday = '<html><body><script>self.__next_f.push([1,"a:{\"balance\":3984}"])</script></body></html>';
  await withRoutedNetwork({ earn: pageWithoutToday, dashboard: '', flyout: flyoutFixture }, async () => {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.equal(info.todayPoints, 145, '页面无今日积分时应回退到 flyout');
    assert.equal(info.todayPointsSource, 'flyout');
  });
});

test('earn 页面与 flyout 数值不一致时，以页面为准（官网 145 / flyout 498 回归）', async () => {
  const flyoutFixture = JSON.stringify({
    userInfo: { balance: 13430 },
    flyoutResult: {
      userStatus: {
        availablePoints: 13430,
        counters: { DailyPoint: [{ pointProgress: 498 }] }
      }
    }
  });
  const page = '<script>self.__next_f.push([1,"x:\"children\":\"今日积分\",\"y\":{\"className\":\"text-pageHeader\",\"children\":\"145\"}"])</script>';
  await withRoutedNetwork({ earn: page, dashboard: '', flyout: flyoutFixture }, async () => {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.equal(info.todayPoints, 145, '必须采用官网页面值，不能被 flyout 的 498 覆盖');
    assert.equal(info.todayPointsSource, 'earn-page');
  });
});

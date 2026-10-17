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
    assert.deepEqual(status, { total: 2, completed: 1, readable: true, reason: null, usedKey: 'activityCards' });
  });
});

test('活动卡片读不到时，用独立身份接口判定是否未登录（不再靠页面里的登录字样）', async () => {
  const origRequest = networkClient.request;
  networkClient.request = async (options) => {
    const url = String(options?.url || '');
    if (url.includes('panelflyout/getuserinfo')) return JSON.stringify({ userInfo: {} });
    if (url.includes('/earn')) return '<html><body>登录 登录入口 Sign in</body></html>';
    throw new Error('unexpected ' + url);
  };
  try {
    const status = await rewardsApi.getActivityCardStatus();
    assert.equal(status.readable, false);
    assert.equal(status.reason, 'not-signed-in');
  } finally {
    networkClient.request = origRequest;
  }
});

test('页面里出现登录字样但身份接口显示已登录时，不得误报 Cookie 失效', async () => {
  const origRequest = networkClient.request;
  networkClient.request = async (options) => {
    const url = String(options?.url || '');
    if (url.includes('panelflyout/getuserinfo')) {
      return JSON.stringify({ userInfo: { balance: 13430, ruid: 'abc' } });
    }
    if (url.includes('/earn')) return '<html><body>登录 登录入口 Sign in</body></html>';
    throw new Error('unexpected ' + url);
  };
  try {
    const status = await rewardsApi.getActivityCardStatus();
    assert.equal(status.readable, false);
    assert.equal(status.reason, 'activity-cards-not-found', '已登录时只能是页面结构变化，不能报未登录');
  } finally {
    networkClient.request = origRequest;
  }
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
    assert.match(info.todayPointsSource, /^earn-page/);
  });
});

test('今日积分窗口解析：children 层级变化仍能取到数字', async () => {
  // 真实页面常见形态之一：数字与「今日积分」之间隔了多个字段
  const page = '<script>self.__next_f.push([1,"a:\"children\":\"今日积分\",\"b\":{\"className\":\"text-globalBody2\",\"children\":\"赚取更多积分\"},\"c\":{\"className\":\"text-pageHeader\",\"children\":\"145\"}"])</script>';
  const flyout = JSON.stringify({ userInfo: { balance: 13510 }, flyoutResult: { userStatus: { counters: { DailyPoint: [{ pointProgress: 513 }] } } } });
  await withRoutedNetwork({ earn: page, dashboard: '', flyout }, async () => {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.equal(info.todayPoints, 145, '必须取到页面里的 145，而不是 flyout 的 513');
    assert.match(info.todayPointsSource, /^earn-page/);
  });
});

test('今日积分窗口解析：数字带千分位与加号时也能识别', async () => {
  const page = '<script>self.__next_f.push([1,"a:\"children\":\"今日积分\",\"c\":{\"className\":\"text-pageHeader\",\"children\":\"+1,234\"}"])</script>';
  await withRoutedNetwork({ earn: page, dashboard: '', flyout: '' }, async () => {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.equal(info.todayPoints, 1234, '千分位与加号不应影响解析');
  });
});

test('React Flight 数字不带引号时，今日积分/连续签到/可领取都能解析', async () => {
  // 真实故障形态：Next.js Flight 把数字序列化为数值，
  // 是 "children":145 而不是 "children":"145"。
  const page = [
    '<script>self.__next_f.push([1,"a:\\"children\\":\\"今日积分\\",\\"b\\":{\\"className\\":\\"text-pageHeader\\",\\"children\\":145}"])</script>',
    '<script>self.__next_f.push([1,"c:\\"children\\":\\"每日连续打卡\\",\\"d\\":{\\"children\\":123}"])</script>'
  ].join('');
  await withStubbedNetwork(page, async () => {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.equal(info.todayPoints, 145, '数值型 children 必须能解析出 145');
    const streak = await rewardsApi.checkStreak();
    assert.equal(streak.streakDays, 123, '数值型 children 必须能解析出连续签到 123 天');
  });
});

test('可领取额外积分支持数值型 children', async () => {
  const dash = '<script>self.__next_f.push([1,"a:\\"children\\":\\"可领取\\",\\"b\\":{\\"className\\":\\"text-pageHeader\\",\\"children\\":3}"])</script>';
  const earn = '<script>self.__next_f.push([1,"x:\\"pointsCounters\\":{\\"pc\\":{\\"max\\":60,\\"progress\\":10}}"])</script>';
  await withRoutedNetwork({ earn, dashboard: dash, flyout: '' }, async () => {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.equal(info.claimablePoints, 3, '官网显示可领取 3 分时必须解析为 3');
  });
});

test('activityCards 缺失时用其他已知字段兜底（不同账号/实验分组）', async () => {
  const fixture = '<script>self.__next_f.push([1,"x:\\"promotionalItems\\":[{\\"isCompleted\\":false,\\"offerId\\":\\"A\\"},{\\"isCompleted\\":true,\\"offerId\\":\\"B\\"}]"])</script>';
  await withStubbedNetwork(fixture, async () => {
    const status = await rewardsApi.getActivityCardStatus();
    assert.equal(status.readable, true);
    assert.equal(status.usedKey, 'promotionalItems');
    assert.equal(status.total, 2);
    assert.equal(status.completed, 1);
  });
});

test('渲染后 DOM：标签 + text-pageHeader 结构能取到今日积分/连签/可领取', () => {
  const earn = '<p class="text-labelControl">今日积分</p><img alt="今日积分"><div class="flex"><p class="text-pageHeader">145</p></div>' +
               '<p class="text-labelControl">每日连续打卡</p><img alt="每日连续打卡"><div class="flex"><p class="text-pageHeader">123</p></div>';
  const dash = '<p class="text-labelControl">可领取</p><img alt="可领取"><div class="flex"><p class="text-pageHeader">3</p></div>';
  assert.equal(rewardsApi.parseLabeledHeaderValue(earn, '今日积分'), 145);
  assert.equal(rewardsApi.parseLabeledHeaderValue(earn, '每日连续打卡'), 123);
  assert.equal(rewardsApi.parseLabeledHeaderValue(dash, '可领取'), 3);
});

test('渲染后 DOM：千分位与「天」后缀都能正确取值', () => {
  assert.equal(rewardsApi.parseLabeledHeaderValue('<p class="text-labelControl">可领取</p><p class="text-pageHeader">1,234</p>', '可领取'), 1234);
  assert.equal(rewardsApi.parseLabeledHeaderValue('<p class="text-labelControl">每日连续打卡</p><p class="text-pageHeader">21 天</p>', '每日连续打卡'), 21);
});

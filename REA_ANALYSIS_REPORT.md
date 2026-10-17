# Microsoft Rewards 自动化逆向工程与技术实现深度报告 (REA Analysis Report)

> **报告版本**：v1.9.2  
> **逆向工具**：REA (Reverse Engineer Anything) 6.5.0 + Chromium 动态抓包 + CDP 协议分析 + LXC 容器双边实测  
> **分析对象**：Microsoft Rewards 核心认证、业务 API、Next.js Flight 架构、DAPI 移动端接口与浏览器执行链路  

---

## 一、登录认证体系与双通道凭据机制 (Auth & Identity Architecture)

微软 Rewards 业务跨越了微软消费者体系（Microsoft Consumer / MSA）的多个业务域。系统内存在两个真正独立但必须指向同一账号的登录态通道：

```
                      ┌────────────────────────────────────────┐
                      │        微软同一账号 (统一身份)          │
                      │   邮箱 / 昵称 / 唯一标识 CID: 58f47b6d... │
                      └──────────────────┬─────────────────────┘
                                         │
             ┌───────────────────────────┴───────────────────────────┐
             ▼                                                       ▼
┌─────────────────────────┐                             ┌─────────────────────────┐
│ 通道一：必应网页端 Cookie │                             │ 通道二：移动端 OAuth Token│
│ 作用域: .bing.com /     │                             │ 作用域: rewardsplatform │
│         cn.bing.com     │                             │ 凭据: access_token /    │
│ 关键字段: _U, WLS,      │                             │       refresh_token     │
│          SRCHD, .MSA.Auth│                             │ 提取字段: user_id (CID), │
│                         │                             │   ruid, epuid           │
└────────────┬────────────┘                             └────────────┬────────────┘
             │                                                       │
             ▼                                                       ▼
   [PC 搜索 / 日常活动集 /                                    [App 移动端签入 /
    桌面专属任务 / 页面抓取]                                    新闻资讯阅读 30分]
```

### 1. 网页端 Cookie (Web Cookie)
- **核心作用域**：`.bing.com`、`cn.bing.com`、`rewards.bing.com`。
- **关键认证字段**：
  - `_U`：必应网页端登录的用户会话哈希；缺少 `_U` 时必应搜索将无法关联账号计分。
  - `WLS`：微软 Windows Live 登录凭据，格式如 `C=58f47b6d3bea1c91&N=Octavia`。其中 `C=` 后即为该账号的核心用户标识 **CID**，`N=` 为经过 URL 编码的用户显示昵称。
  - `.MSA.Auth` / `SRCHD` / `SRCHHPGUSR`：维持必应搜索与 MSN 登录态的核心凭据。
- **跨域特性**：Cookie-Editor 在导出时默认只抓取当前站点（`.bing.com`）。若要在桌面端直接以真实浏览器打开 `rewards.bing.com/dashboard`，还需包含 `login.live.com` 会话 Cookie。若缺少 live.com 会话，可通过 `cn.bing.com/rewards/panelflyout/getuserinfo` 协议接口完全获取所有任务数据。

### 2. 移动端 OAuth Token (Mobile OAuth)
- **核心作用域**：`prod.rewardsplatform.microsoft.com`。
- **获取链路**：通过 OAuth 2.0 Authorization Code 流，使用公共 Client ID `0000000040170455` 向 `https://login.live.com/oauth20_authorize.srf` 申请授权，用获取的 `code` 换取 `access_token` 与 `refresh_token`。
- **接口凭据提取**：
  - 授权与换期响应中直接返回 `user_id`（小写 16 进制字符串，如 `58f47b6d3bea1c91`），其值与网页端 Cookie 中的 `CID` 完全一致。
  - DAPI 响应头与响应体包含用户唯一公钥 `ruid`（如 `hk-96202FA2...`）与企业公钥签名 `epuid`（如 `dZ9OAmq...`）。

### 3. 双通道强同源核验（防跨账号串号门禁）
- **核验准则**：在账号体检与任务执行前，系统在服务端内存中比对 Cookie 提取的 `CID/RUID/EPUID` 与 OAuth 提取的 `user_id/RUID/EPUID`。
- **规范化处理**：
  - `normalizeCid`：剥离连字符与前导零，统一转为小写。
  - `normalizeRuid`：剥离区域前缀（如 `HK-`、`USW-`），统一转为大写。
  - `normalizeEpuid`：做 `.trim().toLowerCase()` 规范化，消除服务端原始大小写与客户端大小写的格式误差。
- **强阻断门禁**：若两者 CID 或 RUID 冲突（`mismatch`），系统**硬阻断任务执行**，拒绝执行任何自动化操作，并输出安全告警，彻底杜绝多账号配置时误将 A 账号的 Cookie 与 B 账号的 Token 混用导致的封号与串号。

---

## 二、全类型任务「获取 / 执行 / 加分确认」技术矩阵

| 任务类型 | 任务名称与分值 | 获取所需登录态 | 执行所需登录态 | 最佳完成方式 | 底层抓取/执行端点 | 加分真实确认机制 |
| :--- | :--- | :--- | :--- | :---: | :--- | :--- |
| **01 移动签到** | 必应 App 每日签入 (+10分) | 移动端 OAuth | 移动端 OAuth | **API 极速** | `POST .../dapi/me?channel=SAAndroid`<br>`offerId: Gamification_DailyCheckIn` | 1. 响应返回 `points > 0`<br>2. 官网 streak 模型 `isCurrentDayCompleted: true` |
| **02 PC 签入** | 必应网页端签入 (+10分) | 网页端 Cookie | 网页端 Cookie | **API 极速** | `POST https://cn.bing.com/rewardsapp/reportActivity` | 接口回执与官网 streak 模型连续天数递增 |
| **03 资讯阅读** | 移动端新闻资讯 (+30分，10篇) | 移动端 OAuth | 移动端 OAuth | **API 极速** | `POST .../dapi/me?channel=SAAndroid`<br>`offerId: ENUS_readarticle3_30points` | 循环执行并核对 DAPI 返回进度 `30/30` |
| **04 PC 搜索** | 必应 PC 搜索 (+60分，20次) | 网页端 Cookie (`_U`) | 网页端 Cookie (`_U`) | **Browser 仿真**<br>(协议兜底) | 1. Chromium 访问 `cn.bing.com`<br>2. 兜底: `GET cn.bing.com/search` + `reportActivity` | 每搜 1 次读取官网 `pointsCounters.pc.progress` 或 DOM 数值 |
| **05 日常活动集** | Daily Set 3 项任务 (+30分) | 网页端 Cookie 或 OAuth | 网页端 Cookie | **API 极速**<br>(协议直连) | `rewards.bing.com/earn` 或 `panelflyout` 或 DAPI 提取目标 URL，调用 `reportDailyActivity` | 官网 `streaks.dailyset.activitiesCompleted == activitiesTotal` |
| **06 常驻活动卡片** | 问答 Quiz / 拼图 / 推广 (+5~50分) | 网页端 Cookie 或 OAuth | 网页端 Cookie | **API 极速**<br>(协议直连) | 1. `Next.js Server Action`<br>2. `reportDailyActivity(destination)`<br>3. `api/reportactivity` | 1. Server Action 回执包含 `true`<br>2. 任务对象 `isCompleted: true` |
| **07 打孔卡任务** | 每周桌面 / 每月 / 节日打孔卡 (+20~500分) | 网页端 Cookie | 网页端 Cookie | **Browser 仿真** | 真实 Chromium 打开打孔卡落地页，定位并点击未完成步数 step 节点 | 1. 打孔卡步数回执<br>2. 官网同步该打孔卡 `progress >= max` |
| **08 额外积分领取** | Dashboard 待领取额外积分 (+3~10分) | 网页端 Cookie (需 live 会话) | 网页端 Cookie (需 live 会话) | **Browser 仿真** | 真实 Chromium 打开 `/dashboard`，定位 `<p class="text-labelControl">可领取</p>`，点击二次确认弹窗 | 页面读取「可领取」数值归零，且总积分增加相应分值 |
| **09 连续打卡奖励** | 7天/10天/20天连签奖励 | 网页端 Cookie 或 OAuth | 网页端 Cookie 或 OAuth | **API 极速** | `panelflyout/getuserinfo` 提取 `streakBonusPromotions` | 官网连续打卡计数器 `streakDays` 增长 |

---

## 三、任务完成方式判定：API 极速模式 vs 浏览器仿真模式

### 1. 适合走【API 极速完成】的任务（耗时 < 1 秒，内存开销 0 MB）
- **移动端 App 签入**：直连 DAPI 提交签名，耗时约 300ms。
- **新闻资讯阅读**：直连 DAPI 循环提交 10 次阅读确认，单次耗时约 200ms，整体带拟人间隔仅需 30~40 秒。
- **每日活动集 (Daily Set)**：通过 `reportDailyActivity` 直接向必应搜索上报落地页参数（`IG`、`IID`、`form`、`filters`），触发加分，无需加载庞大的前端页面。
- **常驻活动卡片 (Promos)**：优先通过 `Next.js Server Action`（带有 action hash）或 `reportDailyActivity` 接口完成上报。
- **收益**：避免启动无头浏览器，节省 **80% 以上的任务耗时** 与 **90% 的宿主机内存消耗**。

### 2. 必须走【无头浏览器真实仿真】的任务（抗风控核心保障）
- **必应 PC 搜索 (PC Search)**：
  - 微软部署了高敏感度的客户端行为分析脚本。纯 HTTP 接口短时间内并发或高频调用，极易触发服务端熔断（HTTP 200 但积分不涨，即俗称的“搜索停滞/冷却”）。
  - **解决方案**：默认使用经过极致裁剪的单例 Chromium 实例，真实模拟打字（键入热搜词）、鼠标滚轮随机滚动、浏览页面等待，彻底模拟真人行为。
- **仪表盘额外积分领取 (Claim Points)**：
  - 真实页面包含二级弹窗，按钮文本由 React 客户端根据权益状态动态生成（如 `待领取领取积分`），必须在 DOM 树中定位弹窗节点并派发交互事件。
- **多步打孔卡推进 (Punch Cards)**：
  - 需要在真实页面上下文中跟随打孔卡的 iframe 或目标跳转落地。

---

## 四、安全风控体系 (Anti-Ban & Risk Control Mechanics)

为保障多账号长期稳定运行，系统构建了五重自动化防风控机制：

```
                    ┌──────────────────────────────────────┐
                    │        五重风控防御体系 (安全屏障)    │
                    └──────────────────┬───────────────────┘
                                       │
        ┌──────────────┬───────────────┼───────────────┬──────────────┐
        ▼              ▼               ▼               ▼              ▼
┌──────────────┐┌──────────────┐┌──────────────┐┌──────────────┐┌──────────────┐
│  第一重防御  ││  第二重防御  ││  第三重防御  ││  第四重防御  ││  第五重防御  │
│  国区保护    ││  身份防串号  ││ 拟人动态抖动 ││ 搜索停滞熔断 ││ 多账号物理隔离│
│ 锁定大陆 IP  ││ Cookie/Token ││ 随机退避间隔 ││ 积分不涨停手 ││ 独立上下文清理│
│ 非 CN 即阻断 ││ 强同源核验   ││ 拒绝机械并发 ││ 杜绝强刷限流 ││ 强制冷却间隔  │
└──────────────┘└──────────────┘└──────────────┘└──────────────┘└──────────────┘
```

1. **第一重：国区 IP 严格锁定 (Region Lock)**
   - 任务启动前调用轻量接口核验出口 IP 归属地（`RevIpCC: "CN"`）。
   - 若检测到出口 IP 处于非中国大陆区域，任务执行硬性阻断并报警，绝不在境外网络环境下暴露微软账号。
   - **请求隔离**：地区检测请求明确不带账号 Cookie（`cookieOverride: ''`），杜绝因 Cookie 格式问题导致探测接口 HTTP 400。
2. **第二重：双端身份同源门禁 (Identity Integrity)**
   - 每次任务执行前校验 Cookie 与 OAuth 所属用户。发现任何跨账号错配（`mismatch`），硬阻断并标记。
3. **第三重：拟人化动态抖动与间隔 (Jitter & Pacing)**
   - API 请求间加入 2~5 秒动态浮动；PC 搜索模拟真人作息，单次搜索间加入 60~180 秒平缓随机退避与 0~30 秒抖动。
4. **第四重：停滞保护与自动熔断 (Stagnation Guard)**
   - 每次搜索后主动读取官网真实加分情况。
   - 若连续 N 次搜索官网积分不再增长（触发了官方限流保护或当日额度已封顶），立即主动停止本轮搜索，杜绝继续无效请求增加风控暴露面。
5. **第五重：多账号队列物理隔离与冷却 (Account Isolation)**
   - 账号与账号切换间强制注入 12~25 秒随机冷却；
   - 切换前彻底清空浏览器上下文、localStorage 与内存 Cookie，严防同 IP 多账号指纹交叉污染。

---

## 五、无头浏览器容器内存深度优化模型

### 1. 根治“内存冲高至 1GB+”与“僵尸进程”
- **Chromium 参数深度精简**：
  - `--renderer-process-limit=1`：强制渲染进程上限为 1，杜绝 Chromium 随着页面打开无限制派生渲染进程。
  - `--disable-dev-shm-usage`：使用容器内存而非 `/dev/shm` 避免共享内存溢出崩溃。
  - `--disable-gpu` / `--disable-software-rasterizer`：纯无头模式彻底关闭 GPU 与软件光栅化，节省 100MB+ 显存开销。
  - `--disable-breakpad` / `--disable-crash-reporter`：**关闭崩溃转储与 Crashpad 守护进程，从根源切断僵尸进程（Zombie Processes）的产生来源**。
- **单例互斥与即时释放**：
  - 全局设立 `browserSlotLock`，任何时刻容器内至多只存在 1 个运行中的 Chromium 进程。
  - 数据抓取器（sharedFetcher）在任务启动前主动让出并关闭；空闲超过 60 秒自动断开。
  - 任务执行完毕后在 `finally` 块中确保 `browser.close()`，并显式调用 Node.js 垃圾回收释放内存。常驻内存长期压制在 100~300MB 水位。
- **302 重定向即时阻断**：
  - 抓取页面时，若检测到 URL 跳转至 `login.live.com` 或 `/about`，立即抛出重定向信号并优雅降级到协议层，不再空等 20 秒超时，消除了 `Target page, context or browser has been closed` 报错。

---

## 六、双边复核实测数据记录 (LXC Container Live Verification)

在 LXC 远程容器（Debian 12 + Docker，镜像 `saarjoye/rewards-docker-new:latest`）上完成双边实测核验：

### 1. 账号同源性实测
- **测试账号**：`JoanOctavian2930`
- **Cookie 侧解析**：邮箱 `joanoctavian2930@hotmail.com`，用户 `Octavia`，CID `58f47b6d3bea1c91`
- **OAuth 侧解析**：用户 ID `58f47b6d3bea1c91`，RUID `hk-96202FA2DA0F2DBCD2461CCCC0578C60F0CDF3EB`，EPUID `dZ9OAmq...`
- **核验结论**：`identityMatch: match`，两端标识 100% 重合，验证通过 ✅。

### 2. 全量任务多源聚合发现实测
- **旧版单一 earn 页面**：因页面重定向仅获取到 `0 项可执行卡片`。
- **新版多通道聚合后**：
  - 融合 `panelflyout` + `DAPI`，实测成功抓取到 **15 项有效待办卡片**（涵盖：移动端新手福利 100分/200分、等级任务 750分、连签奖励 10分、Sapphire 附加组件 50分/20分/10分、日常活动集 Child1/2/3 等）。
  - 所有任务完整登记进入待办池，彻底解决了“任务存在但不获取”的历史痛点 ✅。

### 3. 运行顺序与稳定性实测
- **执行顺序**：`官网同步 → 签到 → 阅读 → 活动卡片/每日集 → 任务打孔卡 → 连签/额外积分 → PC 搜索 → 最终结算`。
- **稳定性**：地区检测连续 4 账号均为 `true CN`，0 次 HTTP 400 报错；浏览器抓取无异常退出，内存稳定在 133MB ✅。

---
*本报告由 REA 自动化分析流水线与真实容器实测共同生成，作为后续维护与特性演进的权威规范。*

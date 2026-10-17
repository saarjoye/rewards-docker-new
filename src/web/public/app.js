// 全局状态
let currentStatus = null;
let currentConfig = null;
let eventSource = null;
let currentHistoryDays = 7;
let currentTheme = localStorage.getItem('ms_rewards_theme') || 'auto';
let selectedAccountId = 'all'; // 'all' 或具体账号 id (如 'acc_1')
let editingAccountIdInModal = null;
let editingAccountIdInQuickModal = null;
let webConfirmResolver = null;
let epicActionPollTimer = null;
let microsoftActionPollTimer = null;
let actionProgressTimer = null;
// 前端日志视图的起始时间：点击「清空」后只显示此后的新日志（后端日志不受影响）
let logViewSince = 0;
// 最近一次系统指标（容器 CPU/内存），供浏览器监控卡片复用
let lastSystemMetrics = null;
let diagMode = 'single';
let diagAccountId = null;

// 后端下发的凭据占位符：表示「已配置，内容保持隐藏」
const SECRET_PLACEHOLDER = '__MSR_SECRET_KEEP__';
let guideDraftAccount = {
  id: '',
  name: '新账号',
  order: 2,
  cookie: '',
  authCodeUrl: '',
  refreshToken: '',
  accessToken: '',
  tokenTime: 0
};

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initUIEvents();
  initInstantTooltips();
  startCountdownTimer();
  fetchStatus();
  fetchSystemMetrics();
  fetchBrowserStatus();
  fetchConfig();
  fetchHistory(7);
  initLogStream();
  loadVersion();
  // 首次打开自动触发官网真实完成度同步（解决新部署到 NAS 时任务全显为 0 的问题）
  fetch('/api/status/sync', { method: 'POST' }).then(() => fetchStatus()).catch(() => {});
  setInterval(fetchStatus, 4000); // 4秒轮询一次任务状态
  setInterval(fetchSystemMetrics, 4000); // 4秒轮询硬件与网络延时
  setInterval(fetchBrowserStatus, 2500); // 2.5秒轮询无头浏览器状态
});

// 初始化日夜模式与跟随系统
function initTheme() {
  applyTheme(currentTheme);

  // 监听操作系统深色/浅色模式切换
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentTheme === 'auto') {
      applyTheme('auto');
    }
  });

  // 顶部胶囊切换事件
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTheme = btn.getAttribute('data-theme-val');
      setTheme(targetTheme);
    });
  });

  // 配置中心下拉框切换事件
  document.getElementById('cfg-ui-theme')?.addEventListener('change', (e) => {
    setTheme(e.target.value);
  });
}

function setTheme(theme, syncServer = true) {
  currentTheme = theme;
  localStorage.setItem('ms_rewards_theme', theme);
  applyTheme(theme);
  const selectElem = document.getElementById('cfg-ui-theme');
  if (selectElem) selectElem.value = theme;
  if (syncServer) {
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ui: { theme } })
    }).catch(() => {});
  }
}

function applyTheme(theme) {
  let isDark = true;
  if (theme === 'dark') {
    isDark = true;
  } else if (theme === 'light') {
    isDark = false;
  } else {
    // auto: 跟随系统
    isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');

  // 更新顶部胶囊按钮状态
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-theme-val') === theme);
  });
}

// 启动每日刷新剩余时间倒计时 (距离下一次 09:00:00，中国区 Rewards 刷新点)
function startCountdownTimer() {
  function updateTimer() {
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    const diff = Math.max(0, target.getTime() - now.getTime());
    const hours = String(Math.floor(diff / 3600000)).padStart(2, '0');
    const minutes = String(Math.floor((diff % 3600000) / 60000)).padStart(2, '0');
    const seconds = String(Math.floor((diff % 60000) / 1000)).padStart(2, '0');
    const timerElem = document.getElementById('countdown-timer');
    if (timerElem) {
      timerElem.innerText = `${hours}:${minutes}:${seconds}`;
    }
  }
  updateTimer();
  setInterval(updateTimer, 1000);
}

// ===== 即时悬停提示：替代浏览器原生 title（原生有约 1 秒延迟） =====
let instantTooltipEl = null;
let instantTooltipTarget = null;

function ensureInstantTooltipEl() {
  if (!instantTooltipEl) {
    instantTooltipEl = document.createElement('div');
    instantTooltipEl.className = 'instant-tooltip';
    document.body.appendChild(instantTooltipEl);
  }
  return instantTooltipEl;
}

function showInstantTooltip(target) {
  let text = target.getAttribute('data-tip');
  if (!text && target.hasAttribute('title')) {
    text = target.getAttribute('title');
    target.setAttribute('data-tip', text);
  }
  // 无论走哪条分支都摘掉原生 title，否则约 1 秒后浏览器还会弹出第二套提示
  if (target.hasAttribute('title')) target.removeAttribute('title');
  if (!text) return;

  const el = ensureInstantTooltipEl();
  el.textContent = text;
  el.classList.add('visible');

  const rect = target.getBoundingClientRect();
  const tipRect = el.getBoundingClientRect();
  const left = Math.max(12, Math.min(rect.left + rect.width / 2 - tipRect.width / 2, window.innerWidth - tipRect.width - 12));
  let top = rect.bottom + 8;
  if (top + tipRect.height > window.innerHeight - 8) {
    top = rect.top - tipRect.height - 8;
  }
  el.style.left = `${left}px`;
  el.style.top = `${Math.max(8, top)}px`;
  instantTooltipTarget = target;
}

function hideInstantTooltip() {
  if (instantTooltipEl) instantTooltipEl.classList.remove('visible');
  instantTooltipTarget = null;
}

function initInstantTooltips() {
  document.addEventListener('mouseover', (e) => {
    const target = e.target?.closest?.('[title], [data-tip]');
    if (!target || target === instantTooltipTarget) return;
    showInstantTooltip(target);
  });

  document.addEventListener('mouseout', (e) => {
    const target = e.target?.closest?.('[title], [data-tip]');
    if (!target) return;
    if (e.relatedTarget && target.contains(e.relatedTarget)) return;
    hideInstantTooltip();
  });

  window.addEventListener('scroll', hideInstantTooltip, true);
  window.addEventListener('resize', hideInstantTooltip);
}

function initUIEvents() {
  // 立即运行 & 停止 (支持全局与单账号)
  document.getElementById('btn-run')?.addEventListener('click', runTasks);
  document.getElementById('btn-stop')?.addEventListener('click', stopTasks);
  document.getElementById('btn-run-single-header')?.addEventListener('click', runTasks);
  document.getElementById('btn-stop-single-header')?.addEventListener('click', stopTasks);


  // 历史记录天数切换
  document.getElementById('btn-history-7')?.addEventListener('click', () => switchHistoryDays(7));
  document.getElementById('btn-history-30')?.addEventListener('click', () => switchHistoryDays(30));

  // 顶部快捷测试账号登录
  document.getElementById('btn-check-account').addEventListener('click', () => {
    diagMode = 'single';
    diagAccountId = selectedAccountId !== 'all'
      ? selectedAccountId
      : (currentConfig?.accounts?.[0]?.id || 'acc_1');
    openModal('diag-modal');
    runAccountDiagnosis();
  });
  document.getElementById('btn-close-diag').addEventListener('click', () => closeModal('diag-modal'));
  document.getElementById('btn-confirm-diag').addEventListener('click', () => closeModal('diag-modal'));
  document.getElementById('btn-retest-diag').addEventListener('click', runAccountDiagnosis);

  // 硬件监控指标点击立即刷新
  document.getElementById('sys-metrics-pill')?.addEventListener('click', async () => {
    const pill = document.getElementById('sys-metrics-pill');
    pill?.classList.add('refreshing');
    await fetchSystemMetrics();
    setTimeout(() => pill?.classList.remove('refreshing'), 600);
  });

  // 顶部一键同步微软官网真实状态
  document.getElementById('btn-sync-status')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-sync-status');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span>⏳</span> 同步中...';
    openEpicActionModal('官网同步', '正在从微软官网同步真实任务完成度...', ['锁定账号上下文', '请求官网数据', '解析真实进度', '刷新看板'], 0);
    startActionProgressTicker(12, 88, 8, '正在从微软官网同步真实任务完成度...');
    try {
      const res = await fetch('/api/status/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedAccountId !== 'all' ? selectedAccountId : null })
      }).then(r => r.json());
      stopActionProgressTicker();
      if (res.success && res.data) {
        currentStatus = res.data;
        renderDashboard(res.data);
        if (res.skipped) {
          updateEpicActionModal({
            progress: 100,
            badge: { text: '已跳过', cls: 'warn' },
            message: res.message || '任务正在执行中，已跳过同步',
            result: '为避免多账号上下文串台，本次同步已安全跳过。'
          });
        } else {
          updateEpicActionModal({
            activeIndex: 4,
            progress: 100,
            badge: { text: '同步完成', cls: 'ok' },
            message: '微软官网真实状态已同步',
            result: buildMicrosoftStatusDetails(res.data)
          });
        }
      }
    } catch (e) {
      stopActionProgressTicker();
      updateEpicActionModal({
        progress: 100,
        badge: { text: '同步异常', cls: 'err' },
        message: e.message,
        result: `同步异常：${e.message}`
      });
    } finally {
      btn.innerHTML = origHtml;
    }
  });

  // 单次安全测试搜索按钮 (真实按键输入，不触发冷冻)
  document.getElementById('btn-trigger-single-search')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-trigger-single-search');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span>⏳</span> 搜索验证中...';
    const targetId = selectedAccountId !== 'all' ? selectedAccountId : (currentConfig?.accounts?.[0]?.id || 'acc_1');
    const targetName = currentConfig?.accounts?.find(a => a.id === targetId)?.name || targetId;
    openEpicActionModal(
      `单次安全测搜 · ${targetName}`,
      '正在准备浏览器并执行一次拟人搜索...',
      ['准备浏览器环境', '校验账号登录态', '执行拟人键盘搜索', '同步积分与配额', '输出测试明细'],
      0
    );
    startMicrosoftActionPolling();
    try {
      const res = await fetch('/api/tasks/single-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: targetId })
      }).then(r => r.json());
      stopMicrosoftActionPolling();
      if (res.success) {
        updateEpicActionModal({
          activeIndex: 5,
          progress: 100,
          badge: { text: '测试成功', cls: 'ok' },
          message: '单次测试搜索已完成',
          result: `账号：${targetName}\n${res.data.message || '已完成拟人按键输入与积分同步'}\n\n提示：该测试用于验证浏览器登录态与搜索通道，不会替代每日完整搜索配额。`
        });
        fetchStatus();
      } else {
        updateEpicActionModal({
          progress: 100,
          badge: { text: '测试失败', cls: 'err' },
          message: res.message || '搜索测试失败',
          result: `失败原因：${res.message || '未知错误'}`
        });
      }
    } catch (e) {
      stopMicrosoftActionPolling();
      updateEpicActionModal({
        progress: 100,
        badge: { text: '请求异常', cls: 'err' },
        message: e.message,
        result: `请求异常：${e.message}`
      });
    } finally {
      btn.innerHTML = origHtml;
    }
  });

  // 时段开始时间联动计算结束时间 (+4h)
  const syncEndHour = (startInputId, endInputId) => {
    const sElem = document.getElementById(startInputId);
    const eElem = document.getElementById(endInputId);
    if (!sElem || !eElem) return;
    let sh = parseInt(sElem.value, 10);
    if (isNaN(sh)) sh = 9;
    sh = Math.max(0, Math.min(23, sh));
    const eh = (sh + 4) % 24;
    eElem.value = `${String(eh).padStart(2, '0')}:00`;
  };

  document.getElementById('cfg-account-starthour')?.addEventListener('input', () => {
    syncEndHour('cfg-account-starthour', 'cfg-account-endhour');
  });

  document.getElementById('guide-account-starthour')?.addEventListener('input', () => {
    syncEndHour('guide-account-starthour', 'guide-account-endhour');
  });

  // 配置中心：拟人错峰时段 4 个快捷按钮 + 自定义交互
  document.querySelectorAll('#cfg-slot-presets .slot-pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#cfg-slot-presets .slot-pill-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const startVal = btn.getAttribute('data-start');
      const customBox = document.getElementById('cfg-custom-slot-box');
      const shInput = document.getElementById('cfg-account-starthour');
      if (startVal === 'custom') {
        if (customBox) customBox.style.display = 'block';
        if (shInput) shInput.focus();
      } else {
        if (customBox) customBox.style.display = 'none';
        if (shInput) shInput.value = startVal;
        syncEndHour('cfg-account-starthour', 'cfg-account-endhour');
      }
    });
  });

  // 配置向导：拟人错峰时段 4 个快捷按钮 + 自定义交互
  document.querySelectorAll('#guide-slot-presets .slot-pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#guide-slot-presets .slot-pill-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const startVal = btn.getAttribute('data-start');
      const customBox = document.getElementById('guide-custom-slot-box');
      const shInput = document.getElementById('guide-account-starthour');
      if (startVal === 'custom') {
        if (customBox) customBox.style.display = 'block';
        if (shInput) shInput.focus();
      } else {
        if (customBox) customBox.style.display = 'none';
        if (shInput) shInput.value = startVal;
        syncEndHour('guide-account-starthour', 'guide-account-endhour');
      }
    });
  });

  // 测试词库来源按钮
  document.getElementById('btn-test-search-api')?.addEventListener('click', handleTestSearchApi);
  document.getElementById('btn-close-words-modal')?.addEventListener('click', () => closeModal('search-words-modal'));
  document.getElementById('btn-close-words-modal-btn')?.addEventListener('click', () => closeModal('search-words-modal'));

  // 新建账号弹窗相关
  document.getElementById('btn-add-account-card')?.addEventListener('click', () => openQuickAddAccountModal());
  document.getElementById('btn-close-quick-add')?.addEventListener('click', () => closeModal('account-quick-add-modal'));
  document.getElementById('btn-cancel-quick-add')?.addEventListener('click', () => closeModal('account-quick-add-modal'));
  document.getElementById('btn-save-quick-add')?.addEventListener('click', handleQuickAddAccount);

  // 通用网页确认框
  document.getElementById('btn-web-confirm-ok')?.addEventListener('click', () => resolveWebConfirm(true));
  document.getElementById('btn-web-confirm-cancel')?.addEventListener('click', () => resolveWebConfirm(false));
  document.getElementById('btn-web-confirm-close')?.addEventListener('click', () => resolveWebConfirm(false));

  // Epic 操作进度弹窗
  document.getElementById('btn-epic-action-close')?.addEventListener('click', closeEpicActionModal);
  document.getElementById('btn-close-epic-action')?.addEventListener('click', closeEpicActionModal);
  document.getElementById('btn-epic-action-background')?.addEventListener('click', () => {
    stopEpicActionPolling();
    stopMicrosoftActionPolling();
    stopActionProgressTicker();
    closeModal('epic-action-modal');
  });
  document.getElementById('btn-epic-action-stop')?.addEventListener('click', stopEpicTask);

  // 向导 Modal (默认创建全新账号，绝不覆盖已有账号)
  document.getElementById('btn-guide').addEventListener('click', openGuideModal);
  document.getElementById('btn-close-guide').addEventListener('click', () => closeModal('guide-modal'));
  document.getElementById('btn-finish-guide').addEventListener('click', () => closeModal('guide-modal'));

  // 顶部与任务清单栏的快捷编辑当前账号按钮
  document.getElementById('btn-edit-active-account')?.addEventListener('click', () => {
    const targetId = selectedAccountId !== 'all' ? selectedAccountId : (currentConfig?.accounts?.[0]?.id || null);
    if (targetId) openQuickAddAccountModal(targetId);
  });
  document.getElementById('btn-edit-current-account-header')?.addEventListener('click', () => {
    const targetId = selectedAccountId !== 'all' ? selectedAccountId : (currentConfig?.accounts?.[0]?.id || null);
    if (targetId) openQuickAddAccountModal(targetId);
  });
  document.getElementById('btn-quick-clear-cookie')?.addEventListener('click', async () => {
    const ok = await showWebConfirm('确定要清空该账号保存的 Cookie 吗？保存后生效。', '清空 Cookie 确认');
    if (!ok) return;
    quickAddCookieCleared = true;
    const cookieInput = document.getElementById('quick-add-cookie');
    if (cookieInput) {
      cookieInput.value = '（已标记清空，保存后生效）';
      cookieInput.disabled = true;
    }
    const clearBtn = document.getElementById('btn-quick-clear-cookie');
    if (clearBtn) clearBtn.style.display = 'none';
  });

  // 任务列表标题旁的刷新当前账号进度按钮
  document.getElementById('btn-sync-current-account')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-sync-current-account');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span>⏳</span> 同步中...';
    const targetId = selectedAccountId !== 'all' ? selectedAccountId : null;
    const targetName = targetId
      ? (currentConfig?.accounts?.find(a => a.id === targetId)?.name || targetId)
      : '全部账号汇总';
    openEpicActionModal(
      `刷新账号进度 · ${targetName}`,
      '正在从微软官网拉取真实任务进度...',
      ['锁定账号上下文', '请求微软官网数据', '解析任务与积分', '刷新控制台看板'],
      0
    );
    startActionProgressTicker(12, 88, 8, '正在从微软官网拉取真实任务进度...');
    try {
      const res = await fetch('/api/status/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: targetId })
      }).then(r => r.json());
      stopActionProgressTicker();
      if (res.success) {
        currentStatus = res.data;
        renderDashboard(res.data);
        if (res.skipped) {
          updateEpicActionModal({
            progress: 100,
            badge: { text: '已跳过', cls: 'warn' },
            message: res.message || '任务正在执行中，已跳过同步',
            result: '为避免多账号上下文串台，本次同步已安全跳过。可等待当前任务结束后再刷新。'
          });
        } else {
          updateEpicActionModal({
            activeIndex: 4,
            progress: 100,
            badge: { text: '同步完成', cls: 'ok' },
            message: '微软官网真实进度已同步',
            result: buildMicrosoftStatusDetails(res.data)
          });
        }
      } else {
        updateEpicActionModal({
          progress: 100,
          badge: { text: '同步失败', cls: 'err' },
          message: res.message || '同步失败',
          result: `失败原因：${res.message || '未知错误'}`
        });
      }
    } catch (e) {
      stopActionProgressTicker();
      updateEpicActionModal({
        progress: 100,
        badge: { text: '同步异常', cls: 'err' },
        message: e.message,
        result: `同步异常：${e.message}`
      });
    } finally {
      btn.innerHTML = origHtml;
    }
  });

  // 配置中心 Modal
  document.getElementById('btn-settings').addEventListener('click', () => {
    populateSettingsForm();
    openModal('settings-modal');
  });
  document.getElementById('btn-close-settings').addEventListener('click', () => closeModal('settings-modal'));
  document.getElementById('btn-cancel-settings').addEventListener('click', () => closeModal('settings-modal'));
  document.getElementById('btn-save-settings').addEventListener('click', saveSettingsFromModal);

  // 配置中心：切换账号编辑
  document.getElementById('cfg-account-select')?.addEventListener('change', (e) => {
    editingAccountIdInModal = e.target.value;
    loadAccountIntoForm(editingAccountIdInModal);
  });
  document.getElementById('btn-modal-add-acc')?.addEventListener('click', () => {
    closeModal('settings-modal');
    openQuickAddAccountModal();
  });
  document.getElementById('btn-modal-del-acc')?.addEventListener('click', handleDeleteCurrentAccountInModal);

  // 向导换取 Token
  document.getElementById('guide-btn-exchange').addEventListener('click', async () => {
    const input = document.getElementById('guide-code-input').value.trim();
    const resultDiv = document.getElementById('guide-token-result');
    if (!input) {
      resultDiv.innerHTML = '<span style="color:#EF4444;">请先填入地址栏跳转后的完整 URL</span>';
      return;
    }
    resultDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在换取并验证 Token...</span>';
    try {
      guideDraftAccount.authCodeUrl = input;
      // 同步第一步填写的名称与序号，新建账号时一并写入
      guideDraftAccount.name = document.getElementById('guide-account-name')?.value.trim() || guideDraftAccount.name;
      guideDraftAccount.order = parseInt(document.getElementById('guide-account-order')?.value, 10) || guideDraftAccount.order;
      const res = await fetch('/api/auth/exchange-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urlOrCode: input,
          accountId: guideDraftAccount.id,
          name: guideDraftAccount.name,
          order: guideDraftAccount.order
        })
      }).then(r => r.json());
      if (res.success) {
        guideDraftAccount.accessToken = res.data.accessToken;
        guideDraftAccount.refreshToken = res.data.refreshToken;
        guideDraftAccount.tokenTime = Date.now();
        resultDiv.innerHTML = '<span style="color:#34D399;">✅ Token 换取成功！已绑定至新账号草稿</span>';
      } else {
        resultDiv.innerHTML = `<span style="color:#EF4444;">❌ 换取失败: ${escapeHtml(res.message)}</span>`;
      }
    } catch (e) {
      resultDiv.innerHTML = `<span style="color:#EF4444;">❌ 请求异常: ${escapeHtml(e.message)}</span>`;
    }
  });

  // 向导测试 Cookie
  document.getElementById('guide-btn-test-cookie').addEventListener('click', async () => {
    const cookie = document.getElementById('guide-cookie-input').value.trim();
    const resultDiv = document.getElementById('guide-cookie-result');
    if (!cookie) {
      resultDiv.innerHTML = '<span style="color:#EF4444;">请先粘贴 Cookie</span>';
      return;
    }
    resultDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在请求微软官网验证 Cookie...</span>';
    try {
      guideDraftAccount.cookie = cookie;
      const testRes = await fetch('/api/auth/test-cookie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie, accountId: guideDraftAccount.id })
      }).then(r => r.json());
      const d = testRes.data || {};
      if (testRes.success && d.valid) {
        const meta = getIdentityMeta(d);
        resultDiv.innerHTML = `<span style="color:#34D399;">✅ ${escapeHtml(d.message || 'Cookie 有效')}</span>`
          + identityInlineHtml(d);
      } else if (isIdentityUnavailable(d)) {
        resultDiv.innerHTML = `<span style="color:#F59E0B;">⚠️ Cookie 有效性暂时无法确认</span>`
          + `<div style="margin-top:5px; color:#F59E0B;">${escapeHtml(d.message || testRes.message || '')}</div>`
          + identityInlineHtml(d);
      } else {
        resultDiv.innerHTML = `<span style="color:#EF4444;">❌ ${escapeHtml(d.message || testRes.message || 'Cookie 检测无效')}</span>`
          + identityInlineHtml(d);
      }
    } catch (e) {
      resultDiv.innerHTML = `<span style="color:#EF4444;">❌ 检测请求出错: ${escapeHtml(e.message)}</span>`;
    }
  });

  // 向导测试代理与 IP
  document.getElementById('guide-btn-test-proxy').addEventListener('click', async () => {
    const useProxy = document.getElementById('guide-use-proxy').checked;
    const proxyUrl = document.getElementById('guide-proxy-url').value.trim();
    const resultDiv = document.getElementById('guide-proxy-result');
    resultDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在检测网络连通性与出口归属...</span>';
    try {
      const res = await fetch('/api/proxy/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useProxy, proxyUrl })
      }).then(r => r.json());
      if (res.success) {
        if (res.regionPass) {
          resultDiv.innerHTML = `<span style="color:#34D399;">✅ 地区检测通过！当前出口位于：中国大陆 (${escapeHtml(res.region)})<br>${escapeHtml(res.ipInfo)}</span>`;
        } else {
          resultDiv.innerHTML = `<span style="color:#F59E0B;">⚠️ 警告：当前出口为非大陆地区 (${escapeHtml(res.region)})！若开启国区保护任务将被自动暂停。<br>${escapeHtml(res.ipInfo)}</span>`;
        }
      } else {
        resultDiv.innerHTML = `<span style="color:#EF4444;">❌ 测试失败: ${escapeHtml(res.message)}</span>`;
      }
    } catch (e) {
      resultDiv.innerHTML = `<span style="color:#EF4444;">❌ 测试异常: ${escapeHtml(e.message)}</span>`;
    }
  });

  // 清空日志：只清空当前页面显示（设置本地时间戳过滤），
  // 后端内存日志与 data/app.log 文件均保留，新日志照常继续显示。
  document.getElementById('btn-clear-logs').addEventListener('click', () => {
    logViewSince = Date.now();
    renderLogs();
  });

  // 配置中心：一键换取/刷新 Token
  document.getElementById('btn-exchange-token')?.addEventListener('click', async () => {
    const input = document.getElementById('cfg-authcode').value.trim();
    const resDiv = document.getElementById('cfg-auth-test-result');
    if (!input) {
      if (resDiv) resDiv.innerHTML = '<span style="color:#EF4444;">请先在输入框中粘贴包含 code= 的跳转链接</span>';
      return alert('请先填入包含 code 的链接或授权码');
    }
    if (resDiv) resDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在向微软官方请求兑换 OAuth Token...</span>';
    const targetId = editingAccountIdInModal || 'acc_1';
    const res = await fetch('/api/auth/exchange-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urlOrCode: input, accountId: targetId })
    }).then(r => r.json());
    if (res.success) {
      if (resDiv) resDiv.innerHTML = '<span style="color:#34D399;">✅ Token 换取并自动保存成功！</span>';
      document.getElementById('cfg-refresh-token').value = '********';
      document.getElementById('cfg-authcode').placeholder = '已配置授权码（内容已隐藏）';
      document.getElementById('cfg-authcode').value = '';
      fetchConfig();
      fetchStatus();
    } else {
      if (resDiv) resDiv.innerHTML = `<span style="color:#EF4444;">❌ 换取失败: ${escapeHtml(res.message)}</span>`;
    }
  });

  // 配置中心：单独测试已输入或已配置的 Cookie
  document.getElementById('btn-test-modal-cookie')?.addEventListener('click', async () => {
    const input = document.getElementById('cfg-cookie').value.trim();
    const resDiv = document.getElementById('cfg-cookie-test-result');
    const targetId = editingAccountIdInModal || 'acc_1';
    if (resDiv) resDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在请求微软官网验证 Cookie 有效性...</span>';
    try {
      const testRes = await fetch('/api/auth/test-cookie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie: input || SECRET_PLACEHOLDER, accountId: targetId })
      }).then(r => r.json());
      const d = testRes.data || {};
      if (testRes.success && d.valid) {
        if (resDiv) resDiv.innerHTML = `<span style="color:#34D399;">✅ ${escapeHtml(d.message || 'Cookie 有效')}</span>`
          + identityInlineHtml(d);
      } else if (isIdentityUnavailable(d)) {
        if (resDiv) resDiv.innerHTML = `<span style="color:#F59E0B;">⚠️ Cookie 有效性暂时无法确认</span>`
          + `<div style="margin-top:5px; color:#F59E0B;">${escapeHtml(d.message || testRes.message || '')}</div>`
          + identityInlineHtml(d);
      } else {
        if (resDiv) resDiv.innerHTML = `<span style="color:#EF4444;">❌ ${escapeHtml(d.message || testRes.message || 'Cookie 检测无效')}</span>`
          + identityInlineHtml(d);
      }
    } catch (e) {
      if (resDiv) resDiv.innerHTML = `<span style="color:#EF4444;">❌ 检测异常: ${escapeHtml(e.message)}</span>`;
    }
  });

  // 配置中心：清空该账号保存的 Cookie
  document.getElementById('btn-clear-modal-cookie')?.addEventListener('click', () => {
    if (confirm('确定要清空该账号保存的 Cookie 吗？保存配置后生效。')) {
      const input = document.getElementById('cfg-cookie');
      input.value = '__MSR_SECRET_CLEAR__';
      input.placeholder = '已标记清空（点击下方保存配置后生效）';
      const resDiv = document.getElementById('cfg-cookie-test-result');
      if (resDiv) resDiv.innerHTML = '<span style="color:#F59E0B;">⚠️ 已标记清空，请点击弹窗底部「保存配置」使变更落盘</span>';
    }
  });

  // 配置中心：清空该账号保存的授权码与 Token
  document.getElementById('btn-clear-modal-auth')?.addEventListener('click', () => {
    if (confirm('确定要清空该账号保存的移动端授权码与 Token 吗？保存配置后生效。')) {
      const input = document.getElementById('cfg-authcode');
      input.value = '__MSR_SECRET_CLEAR__';
      input.placeholder = '已标记清空（点击下方保存配置后生效）';
      document.getElementById('cfg-refresh-token').value = '';
      const resDiv = document.getElementById('cfg-auth-test-result');
      if (resDiv) resDiv.innerHTML = '<span style="color:#F59E0B;">⚠️ 已标记清空，请点击弹窗底部「保存配置」使变更落盘</span>';
    }
  });

  // 全局点击关闭卡片操作菜单
  document.addEventListener('click', () => {
    document.querySelectorAll('.acc-more-dropdown.show').forEach(m => m.classList.remove('show'));
  });

  // 点击待领积分卡片一键触发领取
  document.getElementById('hero-claimable-card')?.addEventListener('click', async () => {
    const claimBtn = document.getElementById('hero-claim-btn-text');
    const origText = claimBtn ? claimBtn.innerText : '';
    if (claimBtn) claimBtn.innerText = '⏳ 领取中...';
    try {
      const res = await fetch('/api/tasks/claim-points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedAccountId })
      }).then(r => r.json());
      if (res.success) {
        alert(`🎉 ${res.message}`);
        fetchStatus();
      } else if (res.skipped) {
        // 明确告诉用户是谁占用了账号上下文锁
        alert(`⏳ 暂时无法领取\n\n${res.message}\n\n提示：通常是一次任务/同步/领取正在进行中，等它结束后再试。`);
      } else {
        alert(`领取失败: ${res.message}`);
      }
    } catch (e) {
      alert(`请求异常: ${e.message}`);
    } finally {
      if (claimBtn) claimBtn.innerText = origText;
    }
  });

  // 配置中心：测试当前账号 (详细展示 Cookie、Code、Token 是否可用)
  document.getElementById('btn-test-account')?.addEventListener('click', async () => {
    const resultDiv = document.getElementById('test-account-result');
    resultDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在全面测试当前账号凭据可用性...</span>';
    const targetId = editingAccountIdInModal || 'acc_1';
    const res = await fetch('/api/auth/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: targetId })
    }).then(r => r.json());
    if (res.success) {
      const c = res.data.cookie;
      const code = res.data.code;
      const t = res.data.token;
      const net = res.data.network;
      const identity = getIdentityMeta(res.data);
      const cookieText = isIdentityUnavailable(c)
        ? '<span style="color:#F59E0B; font-weight:700;">⚠️ 暂时无法确认</span>'
        : (c?.valid ? '<span style="color:#34D399; font-weight:700;">✅ 可用</span>' : '<span style="color:#F87171; font-weight:700;">❌ 不可用或失效</span>');
      resultDiv.innerHTML = `
        <div style="background:var(--card-inner); padding:10px 14px; border-radius:10px; border:1px solid var(--border-color); display:flex; flex-direction:column; gap:8px; margin-top:8px;">
          <div><strong>1. 必应网页端 Cookie:</strong> ${cookieText} <small style="color:var(--text-sub);">(${escapeHtml(c?.message || '')})</small></div>
          <div><strong>2. 授权码链接 Code:</strong> ${code?.valid ? '<span style="color:#34D399; font-weight:700;">✅ 可用</span>' : '<span style="color:#F59E0B; font-weight:700;">⚠️ 待配置</span>'} <small style="color:var(--text-sub);">(${escapeHtml(code?.message || '')})</small></div>
          <div><strong>3. 移动端 OAuth Token:</strong> ${t?.valid ? '<span style="color:#34D399; font-weight:700;">✅ 可用</span>' : '<span style="color:#F87171; font-weight:700;">❌ 不可用或失效</span>'} <small style="color:var(--text-sub);">(${escapeHtml(t?.message || '')})</small></div>
          <div><strong>4. Cookie 与 OAuth 身份:</strong> <span style="color:${identity.color}; font-weight:700;">${identity.icon} ${identity.text}</span> <small style="color:var(--text-sub);">(${escapeHtml(identity.message || '')})</small></div>
          <div><strong>5. 网络出口与 IP 地区:</strong> ${net?.regionPass ? '<span style="color:#34D399; font-weight:700;">✅ 中国大陆 (安全通过)</span>' : '<span style="color:#F59E0B; font-weight:700;">⚠️ 非大陆出口</span>'} <small style="color:var(--text-sub);">(${escapeHtml(net?.ipInfo || '')})</small></div>
        </div>
      `;
      fetchStatus();
    } else {
      resultDiv.innerHTML = `<span style="color:#F87171;">测试出错: ${escapeHtml(res.message || '')}</span>`;
    }
  });

  // 配置中心：测试网络代理
  document.getElementById('btn-test-proxy-settings')?.addEventListener('click', async () => {
    const useProxy = document.getElementById('cfg-use-proxy').checked;
    const proxyUrl = document.getElementById('cfg-proxy-url').value.trim();
    const resultDiv = document.getElementById('test-proxy-result');
    resultDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在测试网络与代理...</span>';
    const res = await fetch('/api/proxy/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ useProxy, proxyUrl })
    }).then(r => r.json());
    if (res.success) {
      resultDiv.innerHTML = `<div>地区检测: ${res.regionPass ? '✅ 通过 (' + escapeHtml(res.region) + ')' : '⚠️ 报警 (' + escapeHtml(res.region) + ')'}</div><div>${escapeHtml(res.ipInfo)}</div>`;
    } else {
      resultDiv.innerHTML = `<div style="color:#EF4444;">测试失败: ${escapeHtml(res.message)}</div>`;
    }
  });

  // 配置中心 Tabs 切换
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      document.getElementById(targetId)?.classList.add('active');
    });
  });

  // 向导 Steps 切换
  document.querySelectorAll('.step-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const step = item.getAttribute('data-step');
      switchStep(step);
    });
  });

  // 凭据输入框的显示 / 隐藏切换
  initSecretToggles();
  document.getElementById('cfg-cookie')?.addEventListener('input', updateCookieHint);

  // 账号体检范围（单个 / 全部）
  document.querySelectorAll('#diag-scope-group .diag-scope-btn').forEach(btn => {
    btn.addEventListener('click', () => setDiagMode(btn.getAttribute('data-mode')));
  });
  document.getElementById('diag-account-select')?.addEventListener('change', (e) => {
    diagAccountId = e.target.value;
  });

  // 搜索节奏：输入时实时刷新预估执行时间与 3 小时窗口校验
  document.getElementById('cfg-search-interval')?.addEventListener('input', updateSearchRhythmHint);
  document.getElementById('cfg-search-jitter')?.addEventListener('input', updateSearchRhythmHint);

  // 顶层功能选项卡切换（微软积分 / Epic 游戏 / 施工中）
  document.querySelectorAll('#app-tabs .app-tab').forEach(btn => {
    btn.addEventListener('click', () => switchAppTab(btn.getAttribute('data-tab')));
  });
  initEpicUI();
  initLogsModal();
  switchAppTab(localStorage.getItem('ms_rewards_app_tab') || 'ms', false);
}

// 切换顶层选项卡：同一时刻只显示一个面板
function switchAppTab(tab, persist = true) {
  const target = ['ms', 'epic', 'wip'].includes(tab) ? tab : 'ms';
  document.querySelectorAll('#app-tabs .app-tab').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === target);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-panel-${target}`);
  });
  if (persist) localStorage.setItem('ms_rewards_app_tab', target);
  hideInstantTooltip();
  // 切到 Epic 时按需加载数据
  if (target === 'epic') refreshEpicTab();
}

function initSecretToggles() {
  document.querySelectorAll('.secret-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.getAttribute('data-target'));
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? '🙈' : '👁';
      btn.title = show ? '隐藏内容' : '显示内容';
    });
  });
}

// Cookie 提示文案：只暴露「是否已配置」，不暴露内容与长度
function updateCookieHint(hasStoredSecret = null) {
  const hint = document.getElementById('cfg-cookie-hint');
  const input = document.getElementById('cfg-cookie');
  if (!hint || !input) return;
  const hasValue = !!input.value.trim();
  const stored = hasStoredSecret === null
    ? !!currentConfig?.accounts?.find(a => a.id === editingAccountIdInModal)?.hasCookie
    : hasStoredSecret;
  if (hasValue) {
    hint.textContent = '⚠️ Cookie 已修改但尚未保存，保存后生效';
    hint.style.color = '#F59E0B';
  } else if (stored) {
    hint.textContent = '✅ 已配置 Cookie（内容已隐藏，点击右侧眼睛按钮可查看或重新粘贴）';
    hint.style.color = '#34D399';
  } else {
    hint.textContent = 'PC 搜索、每日活动集与桌面任务必备；内容默认隐藏，不会明文展示';
    hint.style.color = '';
  }
}

function switchStep(stepNum) {
  document.querySelectorAll('.step-nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.step-content').forEach(c => c.classList.remove('active'));
  document.querySelector(`.step-nav-item[data-step="${stepNum}"]`)?.classList.add('active');
  document.getElementById(`step-${stepNum}`)?.classList.add('active');
}

function openModal(id) {
  document.getElementById(id)?.classList.add('show');
}

function closeModal(id) {
  document.getElementById(id)?.classList.remove('show');
}

function showWebConfirm(message, title = '请确认') {
  return new Promise((resolve) => {
    const modal = document.getElementById('web-confirm-modal');
    if (!modal) {
      resolve(window.confirm(message));
      return;
    }
    document.getElementById('web-confirm-title').innerText = title;
    document.getElementById('web-confirm-message').innerText = message;
    webConfirmResolver = resolve;
    openModal('web-confirm-modal');
  });
}

function resolveWebConfirm(value) {
  closeModal('web-confirm-modal');
  if (webConfirmResolver) {
    const resolve = webConfirmResolver;
    webConfirmResolver = null;
    resolve(!!value);
  }
}

function setActionSteps(steps, activeIndex = 0) {
  const box = document.getElementById('epic-action-steps');
  if (!box) return;
  box.innerHTML = steps.map((step, idx) => {
    const cls = idx < activeIndex ? 'done' : (idx === activeIndex ? 'active' : '');
    const icon = idx < activeIndex ? '✓' : (idx === activeIndex ? '●' : '○');
    return `<div class="action-step ${cls}"><span>${icon}</span><span>${escapeHtml(step)}</span></div>`;
  }).join('');
}

function openEpicActionModal(title, message, steps = [], activeIndex = 0, showStop = false) {
  document.getElementById('epic-action-title').innerText = title;
  document.getElementById('epic-action-message').innerText = message;
  document.getElementById('epic-action-badge').className = 'epic-badge idle';
  document.getElementById('epic-action-badge').innerText = '准备中';
  document.getElementById('epic-action-progress').style.width = '0%';
  document.getElementById('epic-action-result').style.display = 'none';
  document.getElementById('epic-action-result').innerText = '';
  const stopBtn = document.getElementById('btn-epic-action-stop');
  if (stopBtn) stopBtn.style.display = showStop ? 'inline-flex' : 'none';
  const backgroundBtn = document.getElementById('btn-epic-action-background');
  if (backgroundBtn) backgroundBtn.style.display = 'inline-flex';
  setActionSteps(steps, activeIndex);
  openModal('epic-action-modal');
}

function updateEpicActionModal({ title, badge, message, progress, activeIndex, result, final } = {}) {
  if (title) document.getElementById('epic-action-title').innerText = title;
  if (badge) {
    const badgeEl = document.getElementById('epic-action-badge');
    badgeEl.innerText = badge.text || badge;
    badgeEl.className = `epic-badge ${badge.cls || 'idle'}`;
  }
  if (message) document.getElementById('epic-action-message').innerText = message;
  if (typeof progress === 'number') {
    document.getElementById('epic-action-progress').style.width = `${Math.max(0, Math.min(100, progress))}%`;
  }
  if (typeof activeIndex === 'number') {
    const steps = [...document.querySelectorAll('#epic-action-steps .action-step')];
    steps.forEach((el, idx) => {
      el.classList.toggle('active', idx === activeIndex);
      el.classList.toggle('done', idx < activeIndex);
      const icon = el.querySelector('span');
      if (icon) icon.innerText = idx < activeIndex ? '✓' : (idx === activeIndex ? '●' : '○');
    });
  }
  if (result !== undefined) {
    const resultEl = document.getElementById('epic-action-result');
    resultEl.style.display = 'block';
    resultEl.innerText = result;
  }
  if (final === true || progress === 100) {
    const stopBtn = document.getElementById('btn-epic-action-stop');
    const backgroundBtn = document.getElementById('btn-epic-action-background');
    if (stopBtn) stopBtn.style.display = 'none';
    if (backgroundBtn) backgroundBtn.style.display = 'none';
  }
}

function closeEpicActionModal() {
  stopEpicActionPolling();
  stopMicrosoftActionPolling();
  stopActionProgressTicker();
  const stopBtn = document.getElementById('btn-epic-action-stop');
  if (stopBtn) stopBtn.style.display = 'none';
  const backgroundBtn = document.getElementById('btn-epic-action-background');
  if (backgroundBtn) backgroundBtn.style.display = 'inline-flex';
  closeModal('epic-action-modal');
}

function stopEpicActionPolling() {
  if (epicActionPollTimer) {
    clearInterval(epicActionPollTimer);
    epicActionPollTimer = null;
  }
}

function stopMicrosoftActionPolling() {
  if (microsoftActionPollTimer) {
    clearInterval(microsoftActionPollTimer);
    microsoftActionPollTimer = null;
  }
}

function stopActionProgressTicker() {
  if (actionProgressTimer) {
    clearInterval(actionProgressTimer);
    actionProgressTimer = null;
  }
}

function startActionProgressTicker(start = 10, max = 90, step = 7, message = '正在执行...') {
  stopActionProgressTicker();
  let progress = start;
  updateEpicActionModal({ progress, message });
  actionProgressTimer = setInterval(() => {
    progress = Math.min(max, progress + step);
    updateEpicActionModal({ progress, message });
  }, 800);
}

function startMicrosoftActionPolling() {
  stopMicrosoftActionPolling();
  const poll = async () => {
    try {
      const res = await fetch('/api/browser/status').then(r => r.json());
      if (!res.success) return;
      const b = res.data || {};
      const total = Number(b.totalTarget || 0);
      const count = Number(b.searchCount || 0);
      const progress = total > 0 ? Math.min(95, Math.max(15, Math.round((count / total) * 85))) : 35;
      const active = ['starting', 'navigating', 'typing', 'dwelling', 'waiting'].includes(b.status);
      updateEpicActionModal({
        progress,
        badge: { text: active ? '执行中' : '准备中', cls: active ? 'ok' : 'idle' },
        message: b.lastAction || '正在执行微软账号操作...'
      });
    } catch {}
  };
  poll();
  microsoftActionPollTimer = setInterval(poll, 1000);
}

function buildMicrosoftStatusDetails(data) {
  const summary = data?.summary || {};
  const stats = data?.stats || {};
  const lines = [
    `今日已增：+${Number(stats.earned ?? summary.totalEarned ?? 0)} 积分`,
    `当前总分：${Number(stats.balance ?? summary.totalBalance ?? 0).toLocaleString()}`,
    `任务达成：${Number(stats.doneTasks ?? summary.doneTasksCount ?? 0)}/${Number(stats.totalTasks ?? summary.totalTasksCount ?? 0)} 项`
  ];
  if (stats.streakDays !== undefined) lines.push(`连续签到：${stats.streakDays} 天`);
  if (summary.accountsList?.length > 1) lines.push(`账号数量：${summary.accountsList.length}`);
  return lines.join('\n');
}

function startEpicActionPolling() {
  stopEpicActionPolling();
  const poll = async () => {
    try {
      const res = await fetch('/api/epic/status').then(r => r.json());
      if (!res.success) return;
      const data = res.data || {};
      const st = data.state || {};
      const activeStatuses = ['checking', 'navigating', 'challenge', 'clicking', 'ordering', 'waiting', 'retrying', 'verifying', 'stopping'];
      const active = !!data.running || !!data.verifying || activeStatuses.includes(st.status);
      const badgeCls = st.status === 'challenge' ? 'warn' : (active ? 'ok' : 'idle');
      updateEpicActionModal({
        badge: { text: EPIC_STATUS_TEXT[st.status] || '执行中', cls: badgeCls },
        message: st.lastAction || '正在执行...',
        progress: typeof st.progress === 'number' ? st.progress : undefined
      });
    } catch {}
  };
  poll();
  epicActionPollTimer = setInterval(poll, 1000);
}

async function stopEpicTask() {
  const ok = await showWebConfirm('确定立即停止当前 Epic 任务吗？\n正在进行的浏览器页面会被关闭，浏览器资源会尽快释放给微软积分任务。', '停止 Epic 任务');
  if (!ok) return;
  try {
    const res = await fetch('/api/epic/stop', { method: 'POST' }).then(r => r.json());
    updateEpicActionModal({
      badge: { text: '停止中', cls: 'warn' },
      message: res.message || '停止指令已发送',
      progress: 100
    });
    await fetchEpicStatus();
    await fetchEpicAccounts();
  } catch (e) {
    updateEpicActionModal({
      badge: { text: '停止失败', cls: 'err' },
      message: e.message,
      result: `停止失败：${e.message}`
    });
  }
}

let quickAddCookieCleared = false;

function openQuickAddAccountModal(accountId = null) {
  editingAccountIdInQuickModal = accountId;
  quickAddCookieCleared = false;
  const modalTitle = document.getElementById('quick-add-modal-title');
  const saveBtn = document.getElementById('btn-save-quick-add');
  const nameInput = document.getElementById('quick-add-name');
  const orderInput = document.getElementById('quick-add-order');
  const cookieInput = document.getElementById('quick-add-cookie');
  const authInput = document.getElementById('quick-add-authcode');
  const enabledInput = document.getElementById('quick-add-enabled');
  const cookieHint = document.getElementById('quick-add-cookie-hint');
  const clearCookieBtn = document.getElementById('btn-quick-clear-cookie');

  if (clearCookieBtn) {
    clearCookieBtn.style.display = 'none';
    clearCookieBtn.innerText = '清空已有 Cookie';
  }
  if (cookieInput) cookieInput.disabled = false;

  if (accountId) {
    const acc = currentConfig?.accounts?.find(a => a.id === accountId);
    if (modalTitle) modalTitle.innerText = `编辑微软账号：${acc?.name || accountId}`;
    if (saveBtn) saveBtn.innerText = '保存修改';
    if (nameInput) nameInput.value = acc?.name || '';
    if (orderInput) orderInput.value = acc?.order !== undefined ? acc.order : 1;
    if (enabledInput) enabledInput.checked = acc?.enabled !== false;
    if (cookieInput) {
      cookieInput.value = '';
      cookieInput.placeholder = acc?.hasCookie
        ? '已配置 Cookie（内容已隐藏，留空保持不变，可直接粘贴新 Cookie 覆盖）'
        : '粘贴该账号从 cn.bing.com 抓取的完整 Cookie（必须包含 _U）';
    }
    if (authInput) {
      authInput.value = '';
      authInput.placeholder = acc?.hasAuthCodeUrl || acc?.hasToken
        ? '已配置移动端凭据（留空保持不变，可粘贴包含 code= 的新跳转链接）'
        : '粘贴包含 code= 的跳转链接（可选）';
    }
    if (cookieHint) cookieHint.innerText = '💡 编辑已有账号时：Cookie 与授权码留空均表示保持原配置不变。';
    if (clearCookieBtn && acc?.hasCookie) {
      clearCookieBtn.style.display = 'inline-block';
    }
  } else {
    const nextOrder = (currentConfig?.accounts?.length || 1) + 1;
    if (modalTitle) modalTitle.innerText = '添加新微软账号';
    if (saveBtn) saveBtn.innerText = '确认创建并添加';
    if (nameInput) nameInput.value = `账号 ${nextOrder}`;
    if (orderInput) orderInput.value = nextOrder;
    if (enabledInput) enabledInput.checked = true;
    if (cookieInput) {
      cookieInput.value = '';
      cookieInput.placeholder = '粘贴该账号从 cn.bing.com 抓取的完整 Cookie（必须包含 _U）';
    }
    if (authInput) {
      authInput.value = '';
      authInput.placeholder = '粘贴包含 code= 的跳转链接（可选）';
    }
    if (cookieHint) cookieHint.innerText = '可选填 Cookie 或授权码，稍后也可随时点击「编辑」补充。';
  }
  openModal('account-quick-add-modal');
}

function openGuideModal() {
  const nextOrder = (currentConfig?.accounts?.length || 1) + 1;
  guideDraftAccount = {
    id: `acc_${Date.now()}`,
    name: `账号 ${nextOrder}`,
    order: nextOrder,
    cookie: '',
    authCodeUrl: '',
    refreshToken: '',
    accessToken: '',
    tokenTime: 0
  };
  const nameInput = document.getElementById('guide-account-name');
  if (nameInput) nameInput.value = guideDraftAccount.name;
  const orderInput = document.getElementById('guide-account-order');
  if (orderInput) orderInput.value = guideDraftAccount.order;
  document.getElementById('guide-code-input').value = '';
  document.getElementById('guide-token-result').innerHTML = '';
  document.getElementById('guide-cookie-input').value = '';
  document.getElementById('guide-cookie-result').innerHTML = '';
  switchStep(1);
  openModal('guide-modal');
}

// 快速新建账号提交
async function handleQuickAddAccount() {
  const isEditing = !!editingAccountIdInQuickModal;
  const name = document.getElementById('quick-add-name')?.value.trim();
  const order = parseInt(document.getElementById('quick-add-order')?.value, 10) || 1;
  const cookieInput = document.getElementById('quick-add-cookie');
  const cookieVal = cookieInput?.value.trim();
  const authCodeUrl = document.getElementById('quick-add-authcode')?.value.trim();
  const enabled = document.getElementById('quick-add-enabled')?.checked !== false;

  if (!isEditing && !name && !cookieVal) {
    openEpicActionModal('无法保存微软账号', '请至少填写账号备注名称或粘贴 Cookie。', ['填写账号资料', '重新保存'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '参数缺失', cls: 'warn' } });
    return;
  }

  const payload = {
    name: name || (isEditing ? '账号' : '新账号'),
    order,
    enabled
  };
  if (isEditing) {
    payload.id = editingAccountIdInQuickModal;
  }
  if (quickAddCookieCleared) {
    payload.cookie = '__MSR_SECRET_CLEAR__';
  } else if (cookieVal && !cookieVal.startsWith('（已标记清空')) {
    payload.cookie = cookieVal;
  } else if (!isEditing) {
    payload.cookie = '';
  }

  if (authCodeUrl) {
    payload.authCodeUrl = authCodeUrl;
  } else if (!isEditing) {
    payload.authCodeUrl = '';
  }

  try {
    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(r => r.json());

    if (res.success) {
      let msg = isEditing
        ? '账号配置已成功更新！'
        : (res.tokenExchanged ? '账号添加成功，且移动端 Token 已自动换取就绪！' : '账号添加成功！');
      if (res.warning) msg += `\n\n⚠️ ${res.warning}`;
      closeModal('account-quick-add-modal');
      // 清空表单
      document.getElementById('quick-add-name').value = '';
      document.getElementById('quick-add-order').value = '';
      document.getElementById('quick-add-cookie').value = '';
      if (document.getElementById('quick-add-cookie')) {
        document.getElementById('quick-add-cookie').disabled = false;
      }
      document.getElementById('quick-add-authcode').value = '';
      editingAccountIdInQuickModal = null;
      const clearedBeforeReset = quickAddCookieCleared;
      quickAddCookieCleared = false;
      selectedAccountId = res.data?.id || (isEditing ? payload.id : 'all');
      fetchStatus();
      fetchConfig();
      openEpicActionModal(
        isEditing ? '账号配置已更新' : '账号添加成功',
        msg,
        ['保存账号资料', '处理登录凭据', '刷新账号列表'],
        3
      );
      updateEpicActionModal({
        progress: 100,
        badge: { text: '已保存', cls: 'ok' },
        result: `账号 [${payload.name}] 已就绪。\n${clearedBeforeReset ? '已清空原 Cookie，请重新配置后再执行任务。' : '如 Cookie 已更新，建议点击「账号状态体检」确认登录态。'}`
      });
    } else {
      openEpicActionModal('账号保存失败', res.message || '保存失败', ['保存账号资料', '校验结果'], 0);
      updateEpicActionModal({ progress: 100, badge: { text: '保存失败', cls: 'err' }, result: `保存失败：${res.message || '未知错误'}` });
    }
  } catch (err) {
    openEpicActionModal('账号保存异常', err.message, ['保存账号资料', '校验结果'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '请求异常', cls: 'err' }, result: `请求异常：${err.message}` });
  }
}

// 配置中心中删除当前账号
async function handleDeleteCurrentAccountInModal() {
  if (!editingAccountIdInModal) return;
  const ok = await showWebConfirm('确定要删除当前选中的这个账号吗？\n该账号的浏览器会话也会被清理。', '删除微软账号');
  if (!ok) return;

  const res = await fetch(`/api/accounts/${editingAccountIdInModal}`, { method: 'DELETE' }).then(r => r.json());
  if (res.success) {
    selectedAccountId = 'all';
    fetchConfig();
    fetchStatus();
    closeModal('settings-modal');
    openEpicActionModal('账号已删除', '账号及其浏览器会话已清理。', ['删除账号配置', '清理浏览器会话', '刷新账号列表'], 3);
    updateEpicActionModal({ progress: 100, badge: { text: '已删除', cls: 'ok' } });
  } else {
    openEpicActionModal('账号删除失败', res.message || '删除失败', ['删除账号配置', '校验结果'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '删除失败', cls: 'err' }, result: `删除失败：${res.message || '未知错误'}` });
  }
}

// 获取状态并渲染大屏
async function fetchStatus() {
  try {
    const res = await fetch(`/api/status?accountId=${selectedAccountId}`).then(r => r.json());
    if (res.success && res.data) {
      currentStatus = res.data;
      renderDashboard(res.data);
    }
  } catch (e) {
    console.error('获取状态失败:', e);
  }
}

// 获取并渲染无头浏览器实时状态监控数据
async function fetchBrowserStatus() {
  try {
    const res = await fetch('/api/browser/status').then(r => r.json());
    if (res.success && res.data) {
      renderBrowserMonitor(res.data);
    }
  } catch {}
}

// 获取并渲染系统硬件与网络实时状态
async function fetchSystemMetrics() {
  try {
    const res = await fetch('/api/system/metrics').then(r => r.json());
    if (res.success && res.data) {
      const d = res.data;
      lastSystemMetrics = d;
      const cpuEl = document.getElementById('metric-cpu');
      const memEl = document.getElementById('metric-mem');
      const pingEl = document.getElementById('metric-ping');
      const pill = document.getElementById('sys-metrics-pill');
      if (cpuEl) cpuEl.innerText = `CPU ${d.cpu}`;
      if (memEl) memEl.innerText = `内存 ${d.procMem}`;
      if (pingEl) pingEl.innerText = `延时 ${d.ping}`;

      if (pill && d.containerDetails) {
        const cd = d.containerDetails;
        const memLine = cd.containerMemory
          ? `🧠 容器内存占用: ${cd.containerMemory} / ${cd.containerMemoryLimit}${cd.containerMemoryPercent !== null ? ` (${cd.containerMemoryPercent}%)` : ''}${cd.containerMemorySource ? ` [来源: ${cd.containerMemorySource}]` : ''}`
          : `🧠 容器内存占用: 读取不到 cgroup，回退为 Node 进程 ${cd.processRss}`;
        const cpuLine = d.cpuIsContainer
          ? `💻 容器 CPU 占用: ${d.cpu}（占单核百分比）`
          : `💻 CPU 占用: ${d.cpu}（宿主机整机，未读到容器 cgroup）`;
        pill.setAttribute('data-tip', `📦 容器运行环境: Node.js ${cd.nodeVersion} on ${cd.platform}\n⏱️ 容器运行时间: ${cd.uptime}\n${memLine}\n🧩 Node 进程 RSS: ${cd.processRss} (堆内存: ${cd.heap})\n${cpuLine}\n🖥️ 宿主机物理内存: ${cd.hostMemory}\n🌐 微软网络延时: ${d.ping}\n🔄 提示: 点击立即刷新`);
      }
    }
  } catch {}
}

let taskRunning = false;
// 本地二开版本：仅用于展示，不再监控上游仓库更新。
let localVersion = '1.9.0';
let localRevision = '';
let localBuildTime = '';

// 版本胶囊只展示本地版本与运行状态，不再请求上游仓库更新。
function refreshVersionPillTooltip() {
  const pill = document.getElementById('version-status-pill');
  if (!pill) return;
  const statusLine = taskRunning
    ? '🟦 系统状态：正在执行自动化任务打卡中…'
    : '🟢 系统状态：后台定时就绪中';
  pill.setAttribute('data-tip', `${statusLine}\n本地二开版本：v${localVersion}${localRevision ? `\n构建提交：${localRevision}` : ''}${localBuildTime ? `\n构建时间：${localBuildTime}` : ''}`);
}

async function loadVersion() {
  try {
    const res = await fetch('/api/system/version').then(r => r.json());
    const current = res?.data?.currentVersion;
    if (!current) return;
    localVersion = String(current);
    const label = document.getElementById('version-label');
    localRevision = String(res?.data?.revision || '');
    localBuildTime = String(res?.data?.buildTime || '');
    if (label) {
      label.innerText = localRevision && localRevision !== 'dev'
        ? `v${localVersion} · ${localRevision.slice(0, 7)}`
        : `v${localVersion}`;
    }
    refreshVersionPillTooltip();
  } catch {}
}

function renderBrowserMonitor(b) {
  const pill = document.getElementById('browser-pill-status');
  const pillText = document.getElementById('browser-pill-text');
  const bmAccount = document.getElementById('bm-account');
  const bmQuery = document.getElementById('bm-query');
  const bmRound = document.getElementById('bm-round');
  const bmCountdown = document.getElementById('bm-countdown');
  const bmMem = document.getElementById('bm-mem');
  const bmAction = document.getElementById('bm-action-text');

  if (!pill) return;

  const isRunning = b.status !== 'idle' && b.status !== 'stopped';
  pill.className = `browser-status-pill ${isRunning ? 'status-running' : 'status-idle'}`;

  const statusMap = {
    idle: '空闲休眠中',
    starting: '正在启动 Chromium...',
    navigating: '打开 Bing 页面中...',
    typing: '正在模拟真人键盘打字...',
    dwelling: '等待页面渲染与滚动...',
    waiting: '拟人呼吸休眠中...',
    stopped: '已停止'
  };

  pillText.innerText = statusMap[b.status] || (isRunning ? '运行中' : '空闲休眠中');
  bmAccount.innerText = b.activeAccountName || '--';
  bmQuery.innerText = b.currentQuery || '--';
  if (bmRound) {
    bmRound.innerText = b.totalTarget > 0 ? `${b.searchCount} / ${b.totalTarget}` : '0 / 0';
    // 说明口径：这里统计的是「本次为补足剩余配额需要跑几轮搜索」，不是总进度
    bmRound.setAttribute('data-tip', b.totalTarget > 0
      ? `本次需补足剩余配额 ${b.pointsNeeded || b.totalTarget * 3} 分，每次搜索约 +3 分，共安排 ${b.totalTarget} 轮；与上方总进度是两个口径`
      : '本次补分搜索轮次');
  }
  bmCountdown.innerText = b.nextSearchIn > 0 ? `${b.nextSearchIn} 秒` : '--';
  // 用容器真实内存（含 Chromium 子进程）替代原来写死的 180MB
  const containerMem = lastSystemMetrics?.procMem;
  bmMem.innerText = containerMem || (isRunning ? `${b.memoryMB || '--'} MB` : '--');
  bmAction.innerText = b.lastAction || '浏览器当前处于空闲休眠状态 (0 内存占用)';
}

// 渲染多账号切换胶囊栏
function renderAccountSelectorBar(summary) {
  const bar = document.getElementById('account-selector-bar');
  if (!bar || !summary) return;

  const accounts = summary.accountsList || [];
  let html = '';

  // 记录 id → 账号名映射，供日志与打卡明细按账号过滤使用
  accountNameById = {};
  accounts.forEach(acc => { accountNameById[acc.id] = acc.name; });

  // 1. 全部账号汇总胶囊
  const isAllActive = selectedAccountId === 'all';
  html += `
    <button class="account-chip ${isAllActive ? 'active' : ''}" data-acc-id="all">
      <span class="chip-icon">🌐</span>
      <span class="chip-name">全部账号汇总</span>
      <span class="chip-badge">${summary.totalAccounts || 1} 个账号</span>
    </button>
  `;

  // 2. 各独立账号胶囊
  accounts.forEach(acc => {
    const isActive = selectedAccountId === acc.id;
    const auth = getAccountAuthStatus(acc);
    html += `
      <button class="account-chip ${isActive ? 'active' : ''}" data-acc-id="${acc.id}">
        <span class="chip-icon">${auth.icon || (auth.cls === 'badge-auth-valid' ? '🟢' : auth.cls === 'badge-auth-invalid' ? '🔴' : (acc.enabled ? '👤' : '⏸️'))}</span>
        <span class="chip-name">${escapeHtml(acc.name)}</span>
        <span class="chip-sub">${(acc.balance || 0).toLocaleString()} 分</span>
      </button>
    `;
  });

  // 3. 添加账号按钮
  html += `
    <button class="account-chip chip-add" id="btn-add-account-chip">
      <span>➕</span> 添加账号
    </button>
  `;

  bar.innerHTML = html;

  // 绑定切换事件
  bar.querySelectorAll('.account-chip[data-acc-id]').forEach(chip => {
    chip.addEventListener('click', () => {
      selectedAccountId = chip.getAttribute('data-acc-id');
      fetchStatus();
      fetchHistory(currentHistoryDays);
      renderLogs(); // 日志按选中账号实时过滤
    });
  });

  bar.querySelector('#btn-add-account-chip')?.addEventListener('click', () => {
    openModal('account-quick-add-modal');
  });
}

function describeRunOwner(owner) {
  const value = String(owner || '');
  if (value === 'task-run') return { icon: '▶️', title: '自动化任务正在执行中', detail: '正在逐个处理账号任务' };
  if (value === 'web-sync') return { icon: '🔄', title: '官网进度同步中', detail: '正在从微软官网读取真实进度' };
  if (value === 'web-action') return { icon: '🔍', title: '单次测搜执行中', detail: '正在执行一次拟人搜索验证' };
  if (value === 'claim-points') return { icon: '🎁', title: '额外积分领取中', detail: '正在打开 Dashboard 并领取待领积分' };
  if (value === 'rewards-browser') return { icon: '🌐', title: '浏览器任务执行中', detail: '共享 Chromium 正在处理积分任务' };
  if (value.startsWith('earn-page:')) return { icon: '🌐', title: '官网页面抓取中', detail: '正在等待页面渲染并读取真实数据' };
  if (value.startsWith('epic-verify:')) return { icon: '🎮', title: 'Epic 会话校验中', detail: '正在校验 Epic 登录态' };
  if (value.startsWith('epic-claim:')) return { icon: '🎮', title: 'Epic 游戏领取中', detail: '正在领取免费游戏' };
  return { icon: '⏳', title: '后台操作正在执行中', detail: value ? '资源持有者：' + value : '正在处理请求' };
}

function formatRunHeldTime(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  if (total < 60) return total + ' 秒';
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return minutes + ' 分 ' + seconds + ' 秒';
  const hours = Math.floor(minutes / 60);
  return hours + ' 小时 ' + (minutes % 60) + ' 分';
}

// 全局运行横幅：任务/同步/体检/领取等只要占用账号上下文或浏览器资源，都在同一处展示。
function renderGlobalRunBanner(data = {}) {
  const banner = document.getElementById('global-run-banner');
  if (!banner) return;

  const accountLock = data.locks?.accountContext || {};
  const browserLock = data.locks?.browserSlot || {};
  const accountOwner = accountLock.owner || (data.running ? 'task-run' : '');
  const browserOwner = browserLock.owner || '';
  const primaryOwner = accountOwner || browserOwner;

  if (!primaryOwner) {
    banner.style.display = 'none';
    return;
  }

  const meta = describeRunOwner(primaryOwner);
  const iconEl = document.getElementById('global-run-icon');
  const titleEl = document.getElementById('global-run-title');
  const detailEl = document.getElementById('global-run-detail');
  const sinceEl = document.getElementById('global-run-since');

  const accountId = data.runningAccountId || accountLock.accountId || data.selectedAccountId || '';
  const account = (data.summary?.accountsList || []).find(a => a.id === accountId);
  const queue = Array.isArray(data.runQueue) ? data.runQueue : [];
  const queueIndex = Number.isInteger(data.runQueueIndex) ? data.runQueueIndex : -1;
  const currentAccount = queue[queueIndex] || account || null;
  const nextAccount = queue[queueIndex + 1] || null;
  const isTaskRun = accountOwner === 'task-run' || data.running;

  let detail = '';
  if (isTaskRun) {
    detail = data.runPhaseDetail || meta.detail;
    if (currentAccount?.name) detail += ' · 当前账号：' + currentAccount.name;
    if (nextAccount?.name) detail += ' · 下一账号：' + nextAccount.name;
  } else {
    detail = meta.detail;
    if (account?.name) detail += ' · 当前账号：' + account.name;
    if (!accountOwner && browserOwner) {
      const browserMeta = describeRunOwner(browserOwner);
      detail = browserMeta.detail;
    }
  }

  const heldMs = accountOwner ? accountLock.heldMs : browserLock.heldMs;
  if (iconEl) iconEl.innerText = meta.icon;
  if (titleEl) titleEl.innerText = meta.title;
  if (detailEl) detailEl.innerText = detail;
  if (sinceEl) sinceEl.innerText = heldMs > 0 ? '已持续 ' + formatRunHeldTime(heldMs) : '';
  banner.style.display = 'block';
}

// 渲染大屏
function renderDashboard(data) {
  const { running, runningAccountId, summary, stats, timeline } = data;

  // 1. 全局运行横幅：任务、同步、体检、领取或浏览器资源占用都统一展示
  renderGlobalRunBanner(data);
  if (summary) {
    renderAccountSelectorBar(summary);
  }

  // 2. 多账号胶囊与系统运行状态
  const versionPill = document.getElementById('version-status-pill');
  const btnRun = document.getElementById('btn-run');
  const btnStop = document.getElementById('btn-stop');
  const btnRunSingle = document.getElementById('btn-run-single-header');
  const btnStopSingle = document.getElementById('btn-stop-single-header');

  const isAllMode = selectedAccountId === 'all';

  taskRunning = !!running;

  if (running) {
    if (versionPill) {
      versionPill.classList.remove('status-idle');
      versionPill.classList.add('status-running');
    }
    if (btnRun) btnRun.style.display = 'none';
    if (btnStop) btnStop.style.display = 'inline-flex';
    if (btnRunSingle) btnRunSingle.style.display = 'none';
    if (btnStopSingle) btnStopSingle.style.display = 'inline-flex';
  } else {
    if (versionPill) {
      versionPill.classList.remove('status-running');
      versionPill.classList.add('status-idle');
    }
    if (btnRun) btnRun.style.display = 'inline-flex';
    if (btnStop) btnStop.style.display = 'none';
    if (btnRunSingle) btnRunSingle.style.display = isAllMode ? 'none' : 'inline-flex';
    if (btnStopSingle) btnStopSingle.style.display = 'none';
  }

  // 汇总卡片可能在前一轮仍显示运行中；每次状态刷新都按账号 ID 重新同步按钮。
  document.querySelectorAll('.account-overview-card').forEach(card => {
    const button = card.querySelector('.btn-run-single');
    const owner = button?.getAttribute('data-running-account-id');
    const active = !!owner && owner === runningAccountId && !!running;
    if (button) {
      button.disabled = active;
      button.innerText = active ? '⏳ 运行中' : '▶️ 运行';
    }
  });

  refreshVersionPillTooltip();

  if (btnRunSingle && !isAllMode) {
    btnRunSingle.innerHTML = `<span>▶️</span> 运行当前账号 [${escapeHtml(stats.name || '')}]`;
  }

  // 3. Hero 5 大卡片数据渲染
  const displayEarned = isAllMode ? (summary?.totalEarned || 0) : (stats.earned || 0);
  const displayBalance = isAllMode ? (summary?.totalBalance || 0) : (stats.balance || 0);
  const displayClaimable = isAllMode ? Number(summary?.totalClaimable || 0) : Number(stats.claimablePoints || 0);
  const displayStreak = isAllMode ? (summary?.maxStreak || 0) : (stats.streakDays || 0);
  const stamps = isAllMode ? (summary?.stamps || { progress: 0, max: 12 }) : (stats.stamps || { progress: 0, max: 12 });

  document.getElementById('stat-earned').innerText = `+${displayEarned}`;
  document.getElementById('stat-balance').innerText = displayBalance.toLocaleString();

  // 卡片 3：待领取额外积分
  const statClaimable = document.getElementById('stat-claimable');
  const statClaimableDesc = document.getElementById('stat-claimable-desc');
  const heroClaimBtn = document.getElementById('hero-claim-btn-text');
  if (statClaimable) {
    statClaimable.innerText = `${displayClaimable} 分`;
    statClaimable.style.color = displayClaimable > 0 ? '#38BDF8' : 'var(--text-muted)';
  }
  if (statClaimableDesc) {
    statClaimableDesc.innerText = displayClaimable > 0
      ? (isAllMode ? `共 ${displayClaimable} 点待领，点击一键领取` : `当前账号有 ${displayClaimable} 点待领，点击领取`)
      : '平台额外赠分均已领取完毕';
  }
  if (heroClaimBtn) {
    heroClaimBtn.innerText = displayClaimable > 0 ? '立即领取 ➜' : '已领完';
    heroClaimBtn.style.opacity = displayClaimable > 0 ? '1' : '0.5';
  }

  document.getElementById('stat-streak').innerText = `${displayStreak} 天`;

  const statStamps = document.getElementById('stat-stamps');
  const statStampsDesc = document.getElementById('stat-stamps-desc');
  const statStampsFill = document.getElementById('stat-stamps-fill');
  if (statStamps) {
    statStamps.innerText = `${stamps.progress || 0} / ${stamps.max || 12}`;
  }
  if (statStampsFill) {
    const sMax = Number(stamps.max || 12) || 12;
    const sProg = Number(stamps.progress || 0) || 0;
    const sPct = Math.min(100, Math.max(0, Math.round((sProg / sMax) * 100)));
    statStampsFill.style.width = `${sPct}%`;
  }
  if (statStampsDesc) {
    const diff = Math.max(0, (stamps.max || 12) - (stamps.progress || 0));
    statStampsDesc.innerText = diff > 0 ? `差 ${diff} 个集满 1,000 分大奖` : '1,000 奖励印章已集满！';
  }

  // 顶部工具条面包屑/范围更新
  const scopeBadge = document.getElementById('ms-toolbar-scope');
  if (scopeBadge) {
    if (isAllMode) {
      scopeBadge.innerHTML = '👥 全部账号汇总';
    } else {
      scopeBadge.innerHTML = `👤 当前账号：${escapeHtml(stats.name || selectedAccountId)}`;
    }
  }

  const btnEditActive = document.getElementById('btn-edit-active-account');
  if (btnEditActive) {
    btnEditActive.style.display = isAllMode ? 'none' : 'inline-flex';
  }

  // 运行按钮提示
  const btnRunIcon = btnRun.querySelector('.icon') || btnRun;
  btnRun.innerHTML = isAllMode ? '<span>▶️</span> 立即执行全部账号' : `<span>▶️</span> 运行当前账号 [${escapeHtml(stats.name || '')}]`;

  // 4. 汇总视图 vs 单账号视图渲染
  const overviewCard = document.getElementById('accounts-overview-card');
  const taskListTitle = document.getElementById('task-list-title');
  const historyTitle = document.getElementById('history-chart-title');

  if (historyTitle) {
    if (isAllMode) {
      historyTitle.innerText = `每日积分增长历史记录 (全部账号汇总)`;
    } else {
      historyTitle.innerText = `每日积分增长历史记录 [${stats.name || selectedAccountId}]`;
    }
  }

  if (isAllMode) {
    // 汇总模式：显示全账号概览卡片矩阵，隐藏单任务清单（避免在汇总下显示误导的任务列表）
    if (overviewCard) {
      overviewCard.style.display = 'flex';
      renderAccountsOverviewGrid(summary?.accountsList || [], { running, runningAccountId, schedule: data.schedule || {} });
    }
    const taskListSection = document.getElementById('task-list-section');
    if (taskListSection) {
      taskListSection.style.display = 'none';
    }
  } else {
    // 单账号模式：隐藏全账号矩阵，聚焦当前选中账号的专属任务清单
    if (overviewCard) {
      overviewCard.style.display = 'none';
    }
    const taskListSection = document.getElementById('task-list-section');
    if (taskListSection) {
      taskListSection.style.display = 'flex';
    }
    if (taskListTitle) {
      taskListTitle.innerText = `账号 [${escapeHtml(stats.name || '')}] 今日自动化任务进度清单`;
    }
  }

  // 「最后更新」时间：单账号取该账号的 lastUpdate，汇总视图取所有账号里最新的一次。
  // 这个元素以前只写在 HTML 里、JS 从来没赋值，所以一直显示 "--"。
  const lastUpdateEl = document.getElementById('last-update-time');
  if (lastUpdateEl) {
    const lastUpdateTs = isAllMode
      ? Math.max(0, ...(summary?.accountsList || []).map(a => Number(a.lastUpdate) || 0))
      : Number(stats.lastUpdate) || 0;
    lastUpdateEl.innerText = lastUpdateTs > 0
      ? `最后更新：${new Date(lastUpdateTs).toLocaleString('zh-CN', { hour12: false })}`
      : '最后更新：--';
  }

function formatPunchCardTooltip(t) {
  const p = Number(t.progress || 0);
  const m = Number(t.max || 1);
  const logs = Array.isArray(t.stepLogs) ? t.stepLogs : [];
  const lines = [
    `📋 ${t.name || '打孔卡'} 推进历史明细 (${p}/${m}):`
  ];
  if (t.expiresText) {
    lines.push(`⏳ ${t.expiresText}`);
  }
  lines.push('───────────────────────');

  for (let s = 1; s <= m; s++) {
    const log = logs.find(l => l.step === s);
    if (log && log.at) {
      const d = new Date(log.at);
      const dateStr = !isNaN(d.getTime())
        ? `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        : '已完成';
      const label = log.name ? ` · ${log.name}` : '';
      lines.push(`● 第 ${s} 项: ${dateStr} 已完成${label}`);
    } else if (s <= p) {
      lines.push(`● 第 ${s} 项: 已完成`);
    } else if (s === p + 1) {
      lines.push(`○ 第 ${s} 项: 待打卡 / 待解锁`);
    } else {
      lines.push(`○ 第 ${s} 项: 待解锁 (完成上一项后满 24 小时)`);
    }
  }
  return lines.join('\n');
}

  // 5. 渲染任务网格
  const taskGrid = document.getElementById('task-grid');
  taskGrid.innerHTML = '';
  const tasksList = Object.entries(stats.tasks || {});

  for (const [key, t] of tasksList) {
    const card = document.createElement('div');
    card.className = 'task-card';
    const isDone = t.done || (t.max > 0 && t.progress >= t.max);
    
    let subtext = isDone ? '状态: ✅ 已完成' : (running ? '状态: ⏳ 进行中' : '状态: 待执行');
    const taskPoints = Number(t.points || 0);
    // 非打孔卡任务的 points 是「完成可得的固定奖励」，未完成时必须写明「可得」，
    // 否则用户会误以为这些分已经到账。
    let pointsBadge = isDone
      ? `已得 +${taskPoints} 积分`
      : (taskPoints > 0 ? `可得 +${taskPoints} 积分` : '+0 积分');
    let progressLabel = `进度: ${t.progress || 0} / ${t.max || 1} ${t.unit || ''}`;
    let progPercent = t.max > 0 ? Math.min(100, Math.round((t.progress / t.max) * 100)) : (isDone ? 100 : 0);

    const isPunchCard = t.isPunchCard || key === 'desktopApp' || key === 'monthlyQuest' || key.startsWith('quest_');
    if (isPunchCard) {
      const p = Number(t.progress || 0);
      const m = Number(t.max || (key === 'desktopApp' ? 8 : (key === 'quest_halloween' ? 6 : 5))) || 1;
      progPercent = Math.min(100, Math.round((p / m) * 100));
      const typeLabel = t.name?.includes('每周') ? '每周打孔卡' : (t.name?.includes('月') ? '每月打孔卡' : '活动打孔卡');
      const punchPoints = Number(t.points || (key === 'desktopApp' ? 20 : 50));
      if (isDone) {
        subtext = `已全部达成 · ${typeLabel} (悬停查看记录)`;
        pointsBadge = `已得 +${punchPoints} 积分`;
      } else if (t.available === false && p === 0) {
        subtext = `未检测到该任务 · ${typeLabel}`;
        pointsBadge = '+0 积分';
      } else {
        subtext = t.expiresText ? `${t.expiresText} · ${typeLabel} (悬停查看记录)` : `${typeLabel} (悬停查看记录)`;
        // 打孔卡逐项解锁、全部完成才结算，未完成时显示「满额可得」，避免误读为已得分。
        pointsBadge = `满额 +${punchPoints} 积分 (当前未得)`;
      }
      progressLabel = `进度: ${p} / ${m} 个任务`;
      card.setAttribute('data-tip', formatPunchCardTooltip(t));
      card.style.cursor = 'help';
    }

    if (key === 'sign') {
      // 双端签入是否完成以官网「必应应用连续打卡」为准。
      // 这里把官网真实状态直接标在卡片上，避免出现「脚本显示已完成、
      // 官网 App 连签还是 0/1」这种对不上的情况。
      const appStreak = stats.streaks?.bingapp;
      if (appStreak) {
        const days = Number(appStreak.completedDays || 0);
        const todayText = appStreak.isCurrentDayCompleted ? '今日已签' : '今日未签';
        subtext = `${subtext} · 官网 App 连签 ${days}/7 天（${todayText}）`;
      }
    }

    card.innerHTML = `
      <div class="task-top">
        <div class="task-info">
          <div class="task-icon">${t.icon || '📌'}</div>
          <div>
            <div class="task-name">${t.name}</div>
            <div class="task-subtext">${subtext}</div>
          </div>
        </div>
        <div class="pts-badge">${pointsBadge}</div>
      </div>
      <div class="progress-wrap">
        <div class="progress-labels">
          <span>${progressLabel}</span>
          <span>${progPercent}%</span>
        </div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" style="width: ${progPercent}%;"></div>
        </div>
      </div>
    `;
    taskGrid.appendChild(card);
  }

  // 6. 渲染时间轴（每行带账号名，服务端已按选中账号过滤）
  const timelineList = document.getElementById('timeline-list');
  if (timelineList) {
    if (timeline && timeline.length > 0) {
      timelineList.innerHTML = timeline.map(item => {
        const acc = item.accountName || item.tag || '系统';
        return `
      <div class="timeline-item">
        <span class="timeline-time">${item.time}</span>
        <span class="timeline-tag">[${escapeHtml(acc)}]</span>
        <span>${escapeHtml(item.text)}</span>
      </div>`;
      }).join('');
    } else {
      timelineList.innerHTML = selectedAccountId === 'all'
        ? '<div class="timeline-empty">暂无打卡明细</div>'
        : '<div class="timeline-empty">当前账号暂无打卡明细</div>';
    }
  }
}

// 渲染多账号概览矩阵卡片 (在“全部账号汇总”视图中展示)
function formatDiagnosisTime(ts) {
  if (!ts) return '未知时间';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '未知时间';
  }
}

// 账号凭据体检状态：有效 / 需修复 / 身份冲突 / 身份待确认 / 失效 / 未检测
function getAccountAuthStatus(acc) {
  const d = acc?.authDiagnosis;
  if (!d || !d.checkedAt) {
    return {
      text: '未检测',
      cls: 'badge-auth-unknown',
      icon: '👤',
      tip: '尚未体检该账号\n点击右上角「账号体检」可检测 Cookie 与 Token 是否过期'
    };
  }

  const identity = getIdentityMeta(d);
  const cookieLine = isIdentityUnavailable({ identityMatch: d.identityMatch, valid: d.cookieValid, message: d.cookieMessage })
    ? '⚠️ Cookie 有效性暂时无法确认'
    : (d.cookieValid ? '✅ Cookie 有效' : '❌ Cookie 失效');
  const tokenLine = d.tokenValid ? '✅ Token 有效' : '❌ Token 失效';
  const identityLine = `${identity.icon} Cookie 与 OAuth 身份：${identity.text}`;
  const tip = [
    `上次检测：${formatDiagnosisTime(d.checkedAt)}`,
    `检测结果：${d.overallValid ? (d.warning ? '已登录但存在异常' : '整体有效') : '存在失效项'}`,
    cookieLine,
    tokenLine,
    identityLine,
    ...(identity.message ? [identity.message] : []),
    ...(d.warning ? [`⚠️ ${d.warningMessage || 'Cookie 存在异常，请重新抓取'}`] : [])
  ].join('\n');

  if (d.identityMatch === 'mismatch') {
    return { text: '身份冲突', cls: 'badge-auth-invalid', icon: '🔴', tip };
  }
  if (d.identityMatch === 'unknown' && d.overallValid) {
    return { text: '身份待确认', cls: 'badge-auth-warn', icon: '🟡', tip };
  }
  if (!d.overallValid) {
    return { text: '失效', cls: 'badge-auth-invalid', icon: '🔴', tip };
  }
  if (d.warning) {
    return { text: '需修复', cls: 'badge-auth-warn', icon: '🟡', tip };
  }
  return { text: '有效', cls: 'badge-auth-valid', icon: '🟢', tip };
}

// 下次自动启动时间：今日计划 / 即将启动 / 明日窗口 / 停用等
// 倒计时格式化：把「距下次执行的分钟数」显示为 HH:MM
function formatCountdown(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 下次自动启动：统一只显示倒计时（如 ⏰21:50 = 21 小时 50 分后执行）
function formatNextRun(sched) {
  if (!sched) return { text: '⏰ --', tip: '调度信息尚未就绪' };
  const windowText = `${sched.windowStart} - ${sched.windowEnd}`;
  switch (sched.status) {
    case 'scheduled': {
      const mins = Math.max(0, Math.round(sched.minutesUntil || 0));
      return {
        text: `⏰ ${formatCountdown(mins)}`,
        tip: `距下次自动启动约 ${Math.floor(mins / 60)} 小时 ${mins % 60} 分\n作息窗口：${windowText}`
      };
    }
    case 'imminent':
      return { text: '⏰ 00:00', tip: `已进入 ${windowText} 窗口，调度器下一分钟启动` };
    case 'disabled':
      return { text: '⏰ 已停用', tip: '该账号已停用，不会自动启动' };
    case 'no-credential':
      return { text: '⏰ 未配凭据', tip: '未配置 Cookie / Token，不会自动启动' };
    case 'done-today':
      return {
        text: '✅ 今日已执行',
        tip: `今日任务已启动过\n作息窗口：${windowText}\n下次将按明日窗口执行`
      };
    case 'window-passed':
      return {
        text: '⏭️ 今日窗口已过',
        tip: `今日 ${windowText} 窗口已结束，本日不再自动启动\n如仍需执行，请点「立即执行」`
      };
    case 'schedule-off':
      return { text: '⏰ 定时关闭', tip: '后台定时巡检已关闭（可在「配置中心 → 定时巡检」开启）' };
    default:
      return { text: '⏰ --', tip: '调度信息尚未就绪' };
  }
}

function renderAccountTaskSummary(tasks = {}) {
  const entries = Object.entries(tasks || {});
  if (entries.length === 0) return '<span class="acc-task-empty">暂无任务数据</span>';
  return entries.map(([key, task]) => {
    if (!task) return '';
    const done = !!task.done || (Number(task.max) > 0 && Number(task.progress || 0) >= Number(task.max));
    const progress = Number(task.progress || 0);
    const max = Number(task.max || 1) || 1;
    const name = task.name || key;
    const statusText = done ? '已完成' : progress + '/' + max;
    return '<span class="acc-task-chip ' + (done ? 'done' : 'pending') + '" title="' + escapeHtml(name + '：' + progress + '/' + max + (done ? '（已完成）' : '')) + '">'
      + '<span class="acc-task-dot"></span>'
      + '<span class="acc-task-name">' + escapeHtml(name) + '</span>'
      + '<span class="acc-task-state">' + escapeHtml(statusText) + '</span>'
      + '</span>';
  }).join('');
}

function renderAccountsOverviewGrid(accounts, runtime = {}) {
  const grid = document.getElementById('accounts-grid');
  if (!grid) return;
  grid.innerHTML = '';

  const { running = false, runningAccountId = null, schedule = {} } = runtime;

  accounts.forEach(acc => {
    const isRunning = running && runningAccountId === acc.id;
    const auth = getAccountAuthStatus(acc);
    const nextRun = formatNextRun(schedule[acc.id]);
    const card = document.createElement('div');
    card.className = 'account-overview-card';
    card.innerHTML = `
      <div class="acc-card-top">
        <div class="acc-card-title">
          <span>👤</span>
          <span class="acc-card-name" title="${escapeHtml(acc.name)}">${escapeHtml(acc.name)}</span>
        </div>
        <div class="acc-card-badges">
          ${isRunning
            ? '<span class="badge-mini badge-running">● 运行中</span>'
            : `<span class="badge-mini" style="background:${acc.enabled ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)'}; color:${acc.enabled ? '#34D399' : '#F87171'};">${acc.enabled ? '已启用' : '已停用'}</span>`}
          <span class="badge-mini ${auth.cls}" data-tip="${escapeHtml(auth.tip)}">
            ${auth.text}
          </span>
          <span class="badge-mini badge-schedule" data-tip="${escapeHtml(nextRun.tip)}">${nextRun.text}</span>
        </div>
      </div>

      <div class="acc-card-stats">
        <div class="acc-stat-box">
          <span class="acc-stat-lbl">今日已增</span>
          <span class="acc-stat-num" style="color:#34D399;">+${acc.earned || 0}</span>
        </div>
        <div class="acc-stat-box">
          <span class="acc-stat-lbl">当前总分</span>
          <span class="acc-stat-num">${(acc.balance || 0).toLocaleString()}</span>
        </div>
        <div class="acc-stat-box">
          <span class="acc-stat-lbl">连续签到</span>
          <span class="acc-stat-num" style="color:#F59E0B;">${acc.streakDays || 0}天</span>
        </div>
      </div>

      <div class="acc-task-summary">
        <div class="acc-task-summary-head">
          <span>任务摘要</span>
          <strong>${acc.doneTasks || 0} / ${acc.totalTasks || 0} 项已完成</strong>
        </div>
        <div class="acc-task-list">${renderAccountTaskSummary(acc.tasks)}</div>
      </div>

      <div class="progress-wrap">
        <div class="progress-labels">
          <span>任务达成率: ${acc.doneTasks || 0}/${acc.totalTasks || 0} 项</span>
          <span>${acc.percent || 0}%</span>
        </div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" style="width: ${acc.percent || 0}%;"></div>
        </div>
      </div>

      <div class="acc-card-actions">
        <button class="btn btn-primary btn-sm btn-run-single" title="立即运行此账号打卡" data-running-account-id="${escapeHtml(acc.id)}" ${isRunning ? 'disabled' : ''}>${isRunning ? '⏳ 运行中' : '▶️ 运行'}</button>
        <button class="btn btn-secondary btn-sm btn-sync-single" title="从微软官网同步该账号今日真实进度">🔄 刷新</button>
        <button class="btn btn-secondary btn-sm btn-view-acc" title="进入该账号明细大屏">明细 ➜</button>
        <div class="acc-more-wrap">
          <button class="btn btn-secondary btn-sm btn-more-actions" title="更多账号操作">•••</button>
          <div class="acc-more-dropdown">
            <button class="dropdown-item btn-edit-account" title="编辑账号信息与 Cookie 凭据">✏️ 编辑账号 / 更新凭据</button>
            <button class="dropdown-item btn-test-single-search" title="单独搜索一次 (拟人键盘输入，安全验证)">🔍 单次安全测搜</button>
            <button class="dropdown-item btn-test-single" title="测试该账号登录状态">📋 账号状态体检</button>
            <div class="dropdown-sep"></div>
            <button class="dropdown-item btn-toggle-single">${acc.enabled ? '⏸️ 暂停自动巡检' : '▶️ 恢复自动巡检'}</button>
          </div>
        </div>
      </div>
    `;

    const moreBtn = card.querySelector('.btn-more-actions');
    const moreMenu = card.querySelector('.acc-more-dropdown');
    moreBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.acc-more-dropdown.show').forEach(m => {
        if (m !== moreMenu) m.classList.remove('show');
      });
      moreMenu?.classList.toggle('show');
    });

    card.querySelector('.btn-edit-account')?.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.acc-more-dropdown.show').forEach(m => m.classList.remove('show'));
      openQuickAddAccountModal(acc.id);
    });

    // 绑定卡片上的各快捷按钮
    card.querySelector('.btn-sync-single')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.target;
      const origText = btn.innerText;
      btn.innerText = '⏳ 同步中';
      openEpicActionModal(
        `刷新账号进度 · ${acc.name}`,
        '正在从微软官网拉取该账号真实进度...',
        ['锁定账号上下文', '请求微软官网数据', '解析任务与积分', '刷新账号卡片'],
        0
      );
      startActionProgressTicker(12, 88, 8, '正在从微软官网拉取该账号真实进度...');
      try {
        const res = await fetch('/api/status/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId: acc.id })
        }).then(r => r.json());
        stopActionProgressTicker();
        if (res.success) {
          fetchStatus();
          if (res.skipped) {
            updateEpicActionModal({
              progress: 100,
              badge: { text: '已跳过', cls: 'warn' },
              message: res.message || '任务正在执行中，已跳过同步',
              result: '为避免多账号上下文串台，本次同步已安全跳过。'
            });
          } else {
            updateEpicActionModal({
              activeIndex: 4,
              progress: 100,
              badge: { text: '同步完成', cls: 'ok' },
              message: `账号 [${acc.name}] 进度已刷新`,
              result: buildMicrosoftStatusDetails(res.data)
            });
          }
        } else {
          updateEpicActionModal({
            progress: 100,
            badge: { text: '同步失败', cls: 'err' },
            message: res.message || '同步失败',
            result: `失败原因：${res.message || '未知错误'}`
          });
        }
      } catch (err) {
        stopActionProgressTicker();
        updateEpicActionModal({
          progress: 100,
          badge: { text: '同步异常', cls: 'err' },
          message: err.message,
          result: `同步异常：${err.message}`
        });
      } finally {
        btn.innerText = origText;
      }
    });

    card.querySelector('.btn-test-single-search')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.target;
      const origText = btn.innerText;
      btn.innerText = '⏳ 测搜中...';
      openEpicActionModal(
        `单次安全测搜 · ${acc.name}`,
        '正在执行一次拟人搜索并校验积分...',
        ['准备浏览器环境', '校验账号登录态', '执行拟人键盘搜索', '同步积分与配额', '输出测试明细'],
        0
      );
      startMicrosoftActionPolling();
      try {
        const res = await fetch('/api/tasks/single-search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId: acc.id })
        }).then(r => r.json());
        stopMicrosoftActionPolling();
        if (res.success) {
          updateEpicActionModal({
            activeIndex: 5,
            progress: 100,
            badge: { text: '测试成功', cls: 'ok' },
            message: `账号 [${acc.name}] 单次测试搜索成功`,
            result: `${res.data.message || '已完成拟人键盘输入与积分同步'}\n\n提示：该测试仅验证浏览器登录态与搜索通道。`
          });
          fetchStatus();
        } else {
          updateEpicActionModal({
            progress: 100,
            badge: { text: '测搜失败', cls: 'err' },
            message: res.message || '测搜失败',
            result: `失败原因：${res.message || '未知错误'}`
          });
        }
      } catch (err) {
        stopMicrosoftActionPolling();
        updateEpicActionModal({
          progress: 100,
          badge: { text: '请求异常', cls: 'err' },
          message: err.message,
          result: `请求异常：${err.message}`
        });
      } finally {
        btn.innerText = origText;
      }
    });

    card.querySelector('.btn-run-single')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const res = await fetch('/api/tasks/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: acc.id })
      }).then(r => r.json());
      if (res.success) fetchStatus();
      else alert(res.message);
    });

    card.querySelector('.btn-toggle-single')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const res = await fetch(`/api/accounts/${acc.id}/toggle`, { method: 'POST' }).then(r => r.json());
      if (res.success) {
        fetchStatus();
        fetchConfig();
      }
    });

    card.querySelector('.btn-test-single')?.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedAccountId = acc.id;
      diagMode = 'single';
      diagAccountId = acc.id;
      openModal('diag-modal');
      runAccountDiagnosis();
    });

    card.querySelector('.btn-view-acc')?.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedAccountId = acc.id;
      fetchStatus();
      fetchHistory(currentHistoryDays);
    });

    card.addEventListener('click', () => {
      selectedAccountId = acc.id;
      fetchStatus();
      fetchHistory(currentHistoryDays);
    });

    grid.appendChild(card);
  });
}

// 建立 SSE 实时日志流
// 实时日志：保留全量日志，按当前选中账号过滤后渲染
let allLogs = [];
let accountNameById = {};

function logAccountName(log) {
  return log?.accountName || log?.tag || '系统';
}

function logMatchesSelectedAccount(log) {
  if (selectedAccountId === 'all') return true;
  const target = accountNameById[selectedAccountId];
  if (!target) return true;
  return logAccountName(log) === target;
}

function buildLogLine(log) {
  const div = document.createElement('div');
  div.className = 'log-line';
  const acc = logAccountName(log);
  const cls = acc === '系统' ? 'log-acc log-acc-system' : 'log-acc';
  div.innerHTML = `<span class="log-time">[${log.time}]</span> <span>${log.icon}</span> <strong class="${cls}">[${escapeHtml(acc)}]</strong> ${escapeHtml(log.message)}`;
  return div;
}

function renderLogs() {
  const terminal = document.getElementById('terminal-logs');
  if (!terminal) return;
  const chkAutoScroll = document.getElementById('chk-auto-scroll');
  const visible = allLogs.filter(log => (log.timestamp || 0) >= logViewSince && logMatchesSelectedAccount(log));
  terminal.innerHTML = '';
  if (visible.length === 0) {
    terminal.innerHTML = `<div class="log-empty">${logViewSince ? '暂无新日志（已清空当前页面显示，后端日志仍保留）' : '当前账号暂无日志记录'}</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  visible.forEach(log => frag.appendChild(buildLogLine(log)));
  terminal.appendChild(frag);
  if (chkAutoScroll?.checked) terminal.scrollTop = terminal.scrollHeight;
}

function initLogStream() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/logs/stream');

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'history') {
        allLogs = Array.isArray(data.logs) ? data.logs : [];
        renderLogs();
      } else if (data.type === 'log') {
        allLogs.push(data.entry);
        if (allLogs.length > 800) allLogs.shift();
        appendLogToModal(data.entry);
        if ((data.entry.timestamp || 0) >= logViewSince && logMatchesSelectedAccount(data.entry)) {
          const terminal = document.getElementById('terminal-logs');
          const chkAutoScroll = document.getElementById('chk-auto-scroll');
          if (terminal) {
            terminal.appendChild(buildLogLine(data.entry));
            if (chkAutoScroll?.checked) terminal.scrollTop = terminal.scrollHeight;
          }
        }
      }
    } catch (e) {
      console.error('解析日志流失败:', e);
    }
  };
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 身份一致性展示：match / mismatch / unknown 三种语义严格区分
function getIdentityMeta(data) {
  const raw = data && data.identityMatch;
  const identityMatch = ['match', 'mismatch', 'unknown'].includes(raw) ? raw : 'unknown';
  const table = {
    match: { icon: '✅', color: '#34D399', cls: 'pill-ok', text: '身份一致' },
    mismatch: { icon: '❌', color: '#F87171', cls: 'pill-err', text: '身份冲突' },
    unknown: { icon: '⚠️', color: '#F59E0B', cls: 'pill-warn', text: '身份待确认' }
  };
  const meta = table[identityMatch];
  return {
    identityMatch,
    icon: meta.icon,
    color: meta.color,
    cls: meta.cls,
    text: meta.text,
    message: (data && data.identityMessage) || ''
  };
}

function identityInlineHtml(data) {
  const meta = getIdentityMeta(data);
  const text = meta.message || meta.text;
  return '<div style="margin-top:5px; color:' + meta.color + ';">' + meta.icon + ' ' + escapeHtml(text) + '</div>';
}

// 身份接口暂时不可用（HTTP 5xx / 网络异常）时只能显示「待确认」
function isIdentityUnavailable(data) {
  if (!data || data.identityMatch !== 'unknown') return false;
  if (data.valid) return false;
  const merged = String(data.message || '') + ' ' + String(data.identityMessage || '');
  return /HTTP\s+5\d\d|暂时不可用|无法确认|请求失败/.test(merged);
}

async function runTasks() {
  const reqBody = selectedAccountId !== 'all' ? { accountId: selectedAccountId } : {};
  const res = await fetch('/api/tasks/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reqBody)
  }).then(r => r.json());
  if (res.success) {
    fetchStatus();
  } else {
    alert(res.message);
  }
}

async function stopTasks() {
  await fetch('/api/tasks/stop', { method: 'POST' });
  fetchStatus();
}

async function fetchConfig() {
  try {
    const res = await fetch('/api/config').then(r => r.json());
    if (res.success) {
      currentConfig = res.data;
      if (res.data.ui?.theme && !localStorage.getItem('ms_rewards_theme')) {
        setTheme(res.data.ui.theme, false);
      }
      const cronHint = document.getElementById('cron-hint');
      if (cronHint) {
        cronHint.innerText = `定时巡检: ${res.data.schedule?.enabled ? res.data.schedule?.cron : '已停用'}`;
      }
    }
  } catch (e) {
    console.error('获取配置失败:', e);
  }
}

// ===== 全局搜索节奏（任务与防风控） =====
const SEARCH_MAX_ROUNDS = 20;            // 单账号最多 20 次搜索（60 分 ÷ 3 分/次）
const SEARCH_WINDOW_MAX_SEC = 3 * 3600;  // 4 小时时段抛去首小时随机启动 = 3 小时执行窗口
const SEARCH_INTERVAL_MIN = 60;          // 安全下限：基础间隔（秒）
const SEARCH_INTERVAL_MAX = 900;
const SEARCH_JITTER_MIN = 30;            // 安全下限：随机浮动（秒）
const SEARCH_JITTER_MAX = 300;
const SEARCH_STAGNANT_MIN = 1;           // 停滞保护下限
const SEARCH_STAGNANT_MAX = 50;

// 停滞保护：连续多少次搜索官网进度不涨就停手
function readSearchStagnantLimit() {
  let value = parseInt(document.getElementById('cfg-search-stagnant')?.value, 10);
  if (isNaN(value)) value = 10;
  return Math.max(SEARCH_STAGNANT_MIN, Math.min(SEARCH_STAGNANT_MAX, value));
}

function readSearchRhythmInputs() {
  const intervalEl = document.getElementById('cfg-search-interval');
  const jitterEl = document.getElementById('cfg-search-jitter');
  let interval = parseInt(intervalEl?.value, 10);
  let jitter = parseInt(jitterEl?.value, 10);
  if (isNaN(interval)) interval = 180;
  if (isNaN(jitter)) jitter = 30;
  interval = Math.max(1, Math.min(SEARCH_INTERVAL_MAX, interval));
  jitter = Math.max(0, Math.min(SEARCH_JITTER_MAX, jitter));
  return { interval, jitter };
}

function formatDurationCN(sec) {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}

// 校验搜索节奏，返回错误文案；空字符串表示通过
function validateSearchRhythm() {
  const { interval, jitter } = readSearchRhythmInputs();
  if (interval < SEARCH_INTERVAL_MIN) {
    return `基础间隔不能低于 ${SEARCH_INTERVAL_MIN} 秒（防风控安全下限）`;
  }
  if (jitter < SEARCH_JITTER_MIN) {
    return `随机浮动不能低于 ${SEARCH_JITTER_MIN} 秒（防风控安全下限）`;
  }
  const slowestSec = (interval + jitter) * SEARCH_MAX_ROUNDS;
  if (slowestSec > SEARCH_WINDOW_MAX_SEC) {
    return `按最多 ${SEARCH_MAX_ROUNDS} 次搜索估算最慢需要 ${formatDurationCN(slowestSec)}，`
      + `超过 3 小时上限；请让「基础间隔 + 随机浮动」≤ 540 秒`;
  }
  return '';
}

// 更新预估执行时间提示；返回是否通过全部校验
function updateSearchRhythmHint() {
  const hint = document.getElementById('cfg-search-rhythm-hint');
  if (!hint) return true;
  const { interval, jitter } = readSearchRhythmInputs();
  // 随机浮动是「只延后」的叠加模型：单次实际等待 = 间隔 + 0~浮动 秒
  const fastestSec = interval * SEARCH_MAX_ROUNDS;
  const slowestSec = (interval + jitter) * SEARCH_MAX_ROUNDS;
  const err = validateSearchRhythm();

  if (!err) {
    hint.innerHTML = `按最多 ${SEARCH_MAX_ROUNDS} 次搜索估算：单次 ${interval}~${interval + jitter} 秒，`
      + `总耗时约 <strong>${formatDurationCN(fastestSec)} ~ ${formatDurationCN(slowestSec)}</strong>，`
      + `在 3 小时执行窗口内 ✅（安全下限：间隔 ≥ ${SEARCH_INTERVAL_MIN} 秒、浮动 ≥ ${SEARCH_JITTER_MIN} 秒）`;
    hint.style.color = '';
  } else {
    hint.innerHTML = `⚠️ ${err}`;
    hint.style.color = '#F87171';
  }
  return !err;
}

function populateSettingsForm() {
  if (!currentConfig) return;
  const c = currentConfig;
  const accounts = c.accounts || [];

  // 1. 填充多账号下拉框
  const accSelect = document.getElementById('cfg-account-select');
  if (accSelect) {
    accSelect.innerHTML = accounts.map(a => `
      <option value="${a.id}" ${editingAccountIdInModal === a.id ? 'selected' : ''}>
        ${escapeHtml(a.name || a.id)}
      </option>
    `).join('');
    if (!editingAccountIdInModal && accounts.length > 0) {
      editingAccountIdInModal = accounts[0].id;
    }
  }

  loadAccountIntoForm(editingAccountIdInModal);

  // 网络
  document.getElementById('cfg-use-proxy').checked = !!c.network?.useProxy;
  document.getElementById('cfg-proxy-url').value = c.network?.proxyUrl || '';
  document.getElementById('cfg-lock-region').checked = c.network?.lockRegion !== false;
  // 任务
  document.getElementById('cfg-task-sign').checked = c.tasks?.sign !== false;
  document.getElementById('cfg-task-read').checked = c.tasks?.read !== false;
  document.getElementById('cfg-task-search').checked = c.tasks?.search !== false;
  document.getElementById('cfg-task-promos').checked = c.tasks?.promos !== false;
  document.getElementById('cfg-task-dailyset').checked = c.tasks?.dailySet !== false;
  document.getElementById('cfg-task-desktop').checked = c.tasks?.desktopApp !== false;
  document.getElementById('cfg-task-keep').checked = c.tasks?.keepRunning !== false;
  const intervalEl = document.getElementById('cfg-search-interval');
  const jitterEl = document.getElementById('cfg-search-jitter');
  if (intervalEl) intervalEl.value = c.tasks?.searchIntervalSec ?? 180;
  if (jitterEl) jitterEl.value = c.tasks?.searchJitterSec ?? 30;
  const stagnantEl = document.getElementById('cfg-search-stagnant');
  if (stagnantEl) stagnantEl.value = c.tasks?.searchStagnantLimit ?? 10;
  updateSearchRhythmHint();
  document.getElementById('cfg-search-engine').value = c.tasks?.searchEngineMode || 'browser';
  document.getElementById('cfg-search-api').value = c.tasks?.searchApi || 'baidu.official';
  // 主题
  const themeVal = c.ui?.theme || localStorage.getItem('ms_rewards_theme') || 'auto';
  const themeSelect = document.getElementById('cfg-ui-theme');
  if (themeSelect) themeSelect.value = themeVal;
  // 调度
  document.getElementById('cfg-sched-enabled').checked = c.schedule?.enabled !== false;
  document.getElementById('cfg-sched-cron').value = c.schedule?.cron || '*/25 * * * *';
  // 通知
  document.getElementById('cfg-notify-wework').value = c.notify?.wework || '';
  const weworkApp = c.notify?.weworkApp || {};
  const weworkAppEnabled = document.getElementById('cfg-notify-wework-app-enabled');
  if (weworkAppEnabled) weworkAppEnabled.checked = !!weworkApp.enabled;
  document.getElementById('cfg-notify-wework-app-base-url').value = weworkApp.baseUrl || '';
  document.getElementById('cfg-notify-wework-app-corp-id').value = weworkApp.corpId || '';
  document.getElementById('cfg-notify-wework-app-agent-id').value = weworkApp.agentId || '';
  const weworkSecretElem = document.getElementById('cfg-notify-wework-app-secret');
  if (weworkSecretElem) weworkSecretElem.value = weworkApp.hasSecret ? SECRET_PLACEHOLDER : '';
  const weworkSecretHint = document.getElementById('cfg-notify-wework-app-secret-hint');
  if (weworkSecretHint) weworkSecretHint.textContent = weworkApp.hasSecret ? '已保存 Secret，留空或保持占位符不会覆盖。' : '';
  document.getElementById('cfg-notify-wework-app-to-user').value = weworkApp.toUser || '@all';
  document.getElementById('cfg-notify-wework-app-max-retries').value = Number.isFinite(Number(weworkApp.maxRetries)) ? weworkApp.maxRetries : 5;
  document.getElementById('cfg-notify-dingding').value = c.notify?.dingding || '';
  document.getElementById('cfg-notify-feishu').value = c.notify?.feishu || '';
  document.getElementById('cfg-notify-bark').value = c.notify?.bark || '';
  document.getElementById('cfg-notify-pushme').value = c.notify?.pushme || '';
  document.getElementById('cfg-notify-tg-token').value = c.notify?.telegram?.botToken || '';
  document.getElementById('cfg-notify-tg-chat').value = c.notify?.telegram?.chatId || '';
}

function loadAccountIntoForm(accId) {
  if (!currentConfig || !Array.isArray(currentConfig.accounts)) return;
  const acc = currentConfig.accounts.find(a => a.id === accId) || currentConfig.accounts[0];
  if (!acc) return;

  editingAccountIdInModal = acc.id;
  document.getElementById('cfg-account-name').value = acc.name || '';
  const orderElem = document.getElementById('cfg-account-order');
  if (orderElem) orderElem.value = acc.order !== undefined ? acc.order : 1;
  document.getElementById('cfg-account-enabled').checked = acc.enabled !== false;

  // 凭据字段：接口已脱敏，这里只回填占位符，避免把明文重新渲染到 DOM
  const cookieElem = document.getElementById('cfg-cookie');
  const authCodeElem = document.getElementById('cfg-authcode');
  const hasCookie = acc.cookie === SECRET_PLACEHOLDER || !!acc.hasCookie;
  const hasAuthCode = acc.authCodeUrl === SECRET_PLACEHOLDER || !!acc.hasAuthCodeUrl;
  cookieElem.value = '';
  authCodeElem.value = '';
  cookieElem.placeholder = hasCookie ? '已配置 Cookie（内容已隐藏，可重新粘贴覆盖）' : '粘贴浏览器 cn.bing.com 的完整 Cookie（必须包含 _U）';
  authCodeElem.placeholder = hasAuthCode ? '已配置授权码（内容已隐藏，可重新粘贴覆盖）' : '粘贴包含 code= 的完整跳转链接';
  cookieElem.type = 'password';
  authCodeElem.type = 'password';
  document.querySelectorAll('.secret-toggle').forEach(btn => { btn.textContent = '👁'; });
  updateCookieHint(hasCookie);

  document.getElementById('cfg-refresh-token').value = acc.refreshToken ? '********' : '';
  const cookieRes = document.getElementById('cfg-cookie-test-result');
  if (cookieRes) cookieRes.innerHTML = '';
  const authRes = document.getElementById('cfg-auth-test-result');
  if (authRes) authRes.innerHTML = '';

  // 拟人化错峰时段
  const slot = acc.timeSlot || { startHour: 9, endHour: 13, randomDelayMin: 60, durationHours: 2 };
  const sh = slot.startHour ?? 9;
  const eh = slot.endHour ?? ((sh + 4) % 24);
  const shInput = document.getElementById('cfg-account-starthour');
  if (shInput) shInput.value = sh;
  const ehInput = document.getElementById('cfg-account-endhour');
  if (ehInput) ehInput.value = `${String(eh).padStart(2, '0')}:00`;

  // 联动高亮 4 个快捷按钮或自定义
  const standardHours = [9, 13, 17, 21];
  const customBox = document.getElementById('cfg-custom-slot-box');
  document.querySelectorAll('#cfg-slot-presets .slot-pill-btn').forEach(b => {
    const bStart = b.getAttribute('data-start');
    if (standardHours.includes(sh) && bStart === String(sh)) {
      b.classList.add('active');
    } else if (!standardHours.includes(sh) && bStart === 'custom') {
      b.classList.add('active');
    } else {
      b.classList.remove('active');
    }
  });
  if (customBox) {
    customBox.style.display = standardHours.includes(sh) ? 'none' : 'block';
  }
}

async function saveSettingsFromModal() {
  // 保护：配置还没加载完成时保存，会用空数据覆盖掉所有账号（连同 Cookie/Token）
  if (!currentConfig || !Array.isArray(currentConfig.accounts) || currentConfig.accounts.length === 0) {
    alert('配置尚未加载完成，为避免覆盖账号数据，请稍后重试。');
    return;
  }
  // 搜索节奏必须满足安全下限并落在 3 小时执行窗口内，否则拒绝保存
  const rhythmError = validateSearchRhythm();
  if (rhythmError) {
    updateSearchRhythmHint();
    alert(`搜索节奏设置无效：${rhythmError}`);
    return;
  }
  const searchRhythm = readSearchRhythmInputs();
  const currentAccId = editingAccountIdInModal || 'acc_1';
  const currentAccounts = currentConfig?.accounts || [];
  const idx = currentAccounts.findIndex(a => a.id === currentAccId);

  let sh = 9;
  const activePreset = document.querySelector('#cfg-slot-presets .slot-pill-btn.active');
  const presetVal = activePreset ? activePreset.getAttribute('data-start') : '9';
  if (presetVal === 'custom') {
    sh = parseInt(document.getElementById('cfg-account-starthour')?.value, 10);
    if (isNaN(sh)) sh = 9;
  } else {
    sh = parseInt(presetVal, 10) || 9;
  }
  sh = Math.max(0, Math.min(23, sh));

  const updatedAccountData = {
    id: currentAccId,
    name: document.getElementById('cfg-account-name').value.trim() || '账号',
    order: parseInt(document.getElementById('cfg-account-order')?.value, 10) || 1,
    enabled: document.getElementById('cfg-account-enabled').checked,
    cookie: document.getElementById('cfg-cookie').value.trim(),
    authCodeUrl: document.getElementById('cfg-authcode').value.trim(),
    timeSlot: {
      startHour: sh,
      endHour: (sh + 4) % 24,
      randomDelayMin: 60,
      durationHours: 2
    }
  };

  if (idx !== -1) {
    currentAccounts[idx] = { ...currentAccounts[idx], ...updatedAccountData };
  } else {
    currentAccounts.push(updatedAccountData);
  }

  const selectedTheme = document.getElementById('cfg-ui-theme')?.value || 'auto';
  setTheme(selectedTheme);

  const updateData = {
    accounts: currentAccounts,
    network: {
      useProxy: document.getElementById('cfg-use-proxy').checked,
      proxyUrl: document.getElementById('cfg-proxy-url').value.trim(),
      lockRegion: document.getElementById('cfg-lock-region').checked
    },
    tasks: {
      sign: document.getElementById('cfg-task-sign').checked,
      read: document.getElementById('cfg-task-read').checked,
      search: document.getElementById('cfg-task-search').checked,
      promos: document.getElementById('cfg-task-promos').checked,
      dailySet: document.getElementById('cfg-task-dailyset').checked,
      desktopApp: document.getElementById('cfg-task-desktop').checked,
      keepRunning: document.getElementById('cfg-task-keep').checked,
      searchIntervalSec: searchRhythm.interval,
      searchJitterSec: searchRhythm.jitter,
      searchStagnantLimit: readSearchStagnantLimit(),
      searchEngineMode: document.getElementById('cfg-search-engine')?.value || 'browser',
      searchApi: document.getElementById('cfg-search-api')?.value || 'baidu.official'
    },
    ui: {
      theme: selectedTheme
    },
    schedule: {
      enabled: document.getElementById('cfg-sched-enabled').checked,
      cron: document.getElementById('cfg-sched-cron').value.trim()
    },
    notify: {
      wework: document.getElementById('cfg-notify-wework').value.trim(),
      weworkApp: {
        enabled: !!document.getElementById('cfg-notify-wework-app-enabled')?.checked,
        baseUrl: document.getElementById('cfg-notify-wework-app-base-url')?.value.trim() || '',
        corpId: document.getElementById('cfg-notify-wework-app-corp-id')?.value.trim() || '',
        agentId: document.getElementById('cfg-notify-wework-app-agent-id')?.value.trim() || '',
        secret: document.getElementById('cfg-notify-wework-app-secret')?.value.trim() || '',
        toUser: document.getElementById('cfg-notify-wework-app-to-user')?.value.trim() || '@all',
        maxRetries: Math.max(0, Math.min(10, Number(document.getElementById('cfg-notify-wework-app-max-retries')?.value) || 0))
      },
      dingding: document.getElementById('cfg-notify-dingding').value.trim(),
      feishu: document.getElementById('cfg-notify-feishu').value.trim(),
      bark: document.getElementById('cfg-notify-bark').value.trim(),
      pushme: document.getElementById('cfg-notify-pushme').value.trim(),
      telegram: {
        botToken: document.getElementById('cfg-notify-tg-token').value.trim(),
        chatId: document.getElementById('cfg-notify-tg-chat').value.trim()
      }
    }
  };

  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updateData)
  }).then(r => r.json());

  if (res.success) {
    alert('配置已成功保存并即时生效！');
    closeModal('settings-modal');
    fetchConfig();
    fetchStatus();
  } else {
    alert(`保存失败: ${res.message}`);
  }
}

async function saveGuideSettings() {
  const useProxy = document.getElementById('guide-use-proxy').checked;
  const proxyUrl = document.getElementById('guide-proxy-url').value.trim();
  const lockRegion = document.getElementById('guide-lock-region').checked;

  let sh = 9;
  const activePreset = document.querySelector('#guide-slot-presets .slot-pill-btn.active');
  const presetVal = activePreset ? activePreset.getAttribute('data-start') : '9';
  if (presetVal === 'custom') {
    sh = parseInt(document.getElementById('guide-account-starthour')?.value, 10);
    if (isNaN(sh)) sh = 9;
  } else {
    sh = parseInt(presetVal, 10) || 9;
  }
  sh = Math.max(0, Math.min(23, sh));
  const eh = (sh + 4) % 24;

  // 1) 保存账号本身：名称 / 序号 / Cookie / Token / 时段
  //    以前这里只提交 account.timeSlot，会被 update() 写到第一个账号上，
  //    向导里填的名称和序号则完全没有保存过。
  const name = document.getElementById('guide-account-name')?.value.trim() || guideDraftAccount.name;
  const order = parseInt(document.getElementById('guide-account-order')?.value, 10) || guideDraftAccount.order;
  const cookie = document.getElementById('guide-cookie-input')?.value.trim() || guideDraftAccount.cookie;

  try {
    const accRes = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: guideDraftAccount.id,
        name,
        order,
        enabled: true,
        cookie,
        authCodeUrl: guideDraftAccount.authCodeUrl,
        refreshToken: guideDraftAccount.refreshToken,
        accessToken: guideDraftAccount.accessToken,
        tokenTime: guideDraftAccount.tokenTime,
        timeSlot: { startHour: sh, endHour: eh, randomDelayMin: 60, durationHours: 2 }
      })
    }).then(r => r.json());
    if (accRes.success && accRes.data?.id) {
      selectedAccountId = accRes.data.id;
    }
    if (accRes.success && accRes.warning) {
      alert(`⚠️ ${accRes.warning}`);
    }
  } catch (e) {
    console.error('保存向导账号失败:', e);
  }

  // 2) 保存网络与代理设置
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ network: { useProxy, proxyUrl, lockRegion } })
  });

  fetchConfig();
  fetchStatus();
  switchStep(4);
}

window.testNotifyChannel = async function(channel) {
  let val = '';
  if (channel === 'weworkApp') {
    const secret = document.getElementById('cfg-notify-wework-app-secret')?.value.trim() || '';
    val = {
      enabled: true,
      baseUrl: document.getElementById('cfg-notify-wework-app-base-url')?.value.trim() || '',
      corpId: document.getElementById('cfg-notify-wework-app-corp-id')?.value.trim() || '',
      agentId: document.getElementById('cfg-notify-wework-app-agent-id')?.value.trim() || '',
      secret,
      toUser: document.getElementById('cfg-notify-wework-app-to-user')?.value.trim() || '@all',
      maxRetries: Math.max(0, Math.min(10, Number(document.getElementById('cfg-notify-wework-app-max-retries')?.value) || 0))
    };
    if (!val.corpId || !val.agentId) return alert('请先填写企业 CorpID 与 AgentId');
    if (!val.secret && !currentConfig?.notify?.weworkApp?.hasSecret) return alert('请先填写应用 Secret');
  } else if (channel === 'telegram') {
    const botToken = document.getElementById('cfg-notify-tg-token')?.value.trim();
    const chatId = document.getElementById('cfg-notify-tg-chat')?.value.trim();
    if (!botToken || !chatId) return alert('请先输入 Telegram Bot Token 和 Chat ID');
    val = JSON.stringify({ botToken, chatId });
  } else {
    const idMap = {
      wework: 'cfg-notify-wework',
      dingding: 'cfg-notify-dingding',
      feishu: 'cfg-notify-feishu',
      bark: 'cfg-notify-bark',
      pushme: 'cfg-notify-pushme'
    };
    val = document.getElementById(idMap[channel])?.value.trim();
    if (!val) return alert('请先输入配置的值');
  }

  try {
    const res = await fetch('/api/notify/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, value: val })
    }).then(r => r.json());
    if (res.success) {
      alert(`「${channel}」测试消息发送成功，请查收！`);
    } else {
      alert(`测试发送失败: ${res.message}`);
    }
  } catch (e) {
    alert(`测试异常: ${e.message}`);
  }
};

// 账号体检：根据范围选择分发到「单个账号」或「全部账号」
function syncDiagScopeUI() {
  document.querySelectorAll('#diag-scope-group .diag-scope-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === diagMode);
  });
  const selectWrap = document.getElementById('diag-account-select');
  if (selectWrap) selectWrap.style.display = diagMode === 'single' ? '' : 'none';
}

function populateDiagAccountSelect() {
  const select = document.getElementById('diag-account-select');
  if (!select) return;
  const accounts = currentConfig?.accounts || [];
  if (!diagAccountId || !accounts.some(a => a.id === diagAccountId)) {
    diagAccountId = accounts[0]?.id || 'acc_1';
  }
  select.innerHTML = accounts.map(a =>
    `<option value="${a.id}" ${a.id === diagAccountId ? 'selected' : ''}>${escapeHtml(a.name || a.id)}</option>`
  ).join('');
}

function setDiagMode(mode) {
  diagMode = mode === 'all' ? 'all' : 'single';
  syncDiagScopeUI();
  if (diagMode === 'single') populateDiagAccountSelect();
  runAccountDiagnosis();
}

async function runAccountDiagnosis() {
  syncDiagScopeUI();
  if (diagMode === 'single') {
    populateDiagAccountSelect();
    await runSingleAccountDiagnosis(diagAccountId);
  } else {
    await runAllAccountDiagnosis();
  }
}

function setDiagLoading(show, text) {
  const loading = document.getElementById('diag-loading');
  const content = document.getElementById('diag-content');
  const loadingText = document.getElementById('diag-loading-text');
  if (loadingText && text) loadingText.innerText = text;
  if (loading) loading.style.display = show ? 'block' : 'none';
  if (content) content.style.display = show ? 'none' : 'block';
}

// 单个账号：完整的三维检测详情
async function runSingleAccountDiagnosis(accountId) {
  setDiagLoading(true, '正在全面请求微软官方接口检测当前 Docker 中的登录态...');
  document.getElementById('diag-all-summary').style.display = 'none';
  document.getElementById('diag-all-list').style.display = 'none';
  document.getElementById('diag-banner').style.display = '';
  document.getElementById('diag-cards').style.display = '';
  document.querySelector('.diag-summary-box').style.display = '';
  document.getElementById('diag-tips').style.display = '';

  const targetId = accountId
    || (selectedAccountId !== 'all' ? selectedAccountId : (currentConfig?.accounts?.[0]?.id || 'acc_1'));

  try {
    const res = await fetch('/api/auth/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: targetId })
    }).then(r => r.json());
    if (!res.success) throw new Error(res.message || '诊断接口异常');

    const data = res.data;
    const cookie = data.cookie || {};
    const token = data.token || {};
    const net = data.network || {};
    const accName = data.accountName || '当前账号';

    // 1. 综合 Banner
    const banner = document.getElementById('diag-banner');
    const bIcon = document.getElementById('diag-banner-icon');
    const bTitle = document.getElementById('diag-banner-title');
    const bSub = document.getElementById('diag-banner-sub');

    const identity = getIdentityMeta(data);
    const identityConflict = data.identityMatch === 'mismatch' || data.sameAccount === false;
    const identityUnavailable = isIdentityUnavailable(cookie) || (
      data.identityMatch === 'unknown' && !data.warning && cookie.valid && token.valid && data.overallValid
    );

    if (identityConflict) {
      banner.className = 'diag-banner failed';
      bIcon.innerText = '🔴';
      bTitle.innerText = `账号 [${escapeHtml(accName)}] Cookie 与 OAuth 身份冲突`;
      bSub.innerText = data.identityMessage || 'Cookie 所属微软账号与 OAuth Token 不一致，存在串号风险，请重新导出同一账号的凭据。';
    } else if (identityUnavailable) {
      banner.className = 'diag-banner partial';
      bIcon.innerText = '🟡';
      bTitle.innerText = `账号 [${escapeHtml(accName)}] 身份状态待确认`;
      bSub.innerText = data.identityMessage || '身份校验接口暂时不可用，暂时无法确认 Cookie 与 OAuth 是否为同一账号，请稍后重试。';
    } else if (data.allValid && net.regionPass) {
      banner.className = 'diag-banner ok';
      bIcon.innerText = '🟢';
      bTitle.innerText = `账号 [${escapeHtml(accName)}] 登录完全正常 (双端在线)`;
      bSub.innerText = '当前 Docker 环境已完美就绪，所有任务通道与网络环境均处于最佳状态！';
    } else if (data.warning) {
      banner.className = 'diag-banner partial';
      bIcon.innerText = '🟡';
      bTitle.innerText = `账号 [${escapeHtml(accName)}] 已登录，但 Cookie 存在异常`;
      bSub.innerText = data.warningMessage || '网页端 Cookie 缺少 _U 标头，PC 搜索不会计分，请重新抓取完整 Cookie。';
    } else if (data.overallValid) {
      banner.className = 'diag-banner partial';
      bIcon.innerText = '🟡';
      bTitle.innerText = `账号 [${escapeHtml(accName)}] 部分登录有效`;
      bSub.innerText = '部分通道已连接，但仍有项未就绪（如网页端或移动端单边未登录），请根据下方提示补充。';
    } else {
      banner.className = 'diag-banner failed';
      bIcon.innerText = '🔴';
      bTitle.innerText = `账号 [${escapeHtml(accName)}] 尚未成功在 Docker 中登录`;
      bSub.innerText = '未检测到有效的微软登录凭据，请点击右上角「新手配置向导」进行绑定。';
    }

    // 2. 网页端 Cookie 卡片
    const pillCookie = document.getElementById('diag-pill-cookie');
    const detailCookie = document.getElementById('diag-detail-cookie');
    if (cookie.valid && cookie.warning) {
      pillCookie.className = 'diag-status-pill pill-warn';
      pillCookie.innerText = '已登录 · 需修复';
      detailCookie.innerHTML = `
        <div style="color:#F59E0B;">状态：⚠️ 身份认证有效，但 Cookie 不完整 —— ${escapeHtml(cookie.warningMessage || '缺少 _U 登录标头')}</div>
        <div style="margin-top:4px; font-size:11.5px; color:#94A3B8;">建议：在电脑登录 cn.bing.com 后重新抓取完整 Cookie（必须包含 _U），否则 PC 搜索不会计分。</div>
      `;
    } else if (isIdentityUnavailable(cookie)) {
      pillCookie.className = 'diag-status-pill pill-warn';
      pillCookie.innerText = '暂时无法确认';
      detailCookie.innerHTML = `
        <div style="color:#F59E0B;">状态：⚠️ ${escapeHtml(cookie.message || data.identityMessage || '身份校验接口暂时不可用，暂时无法确认 Cookie 有效性')}</div>
        <div style="margin-top:4px; color:#F59E0B;">${escapeHtml(cookie.identityMessage || data.identityMessage || 'Cookie 与 OAuth 身份暂时无法比对，请稍后重新体检。')}</div>
      `;
    } else if (cookie.valid) {
      pillCookie.className = 'diag-status-pill pill-ok';
      pillCookie.innerText = '已登录正常';
      detailCookie.innerHTML = `
        <div>状态：✅ 身份认证有效，可执行 PC 搜索、每日活动集与桌面专属任务</div>
        <div style="margin-top:4px; color:#E2E8F0;">${escapeHtml(cookie.message || '')}</div>
      `;
    } else {
      pillCookie.className = 'diag-status-pill pill-err';
      pillCookie.innerText = '未登录 / 失效';
      detailCookie.innerHTML = `
        <div style="color:#F87171;">状态：❌ ${escapeHtml(cookie.message || 'Cookie 缺失或已失效')}</div>
        <div style="margin-top:4px; font-size:11.5px; color:#94A3B8;">建议：在电脑登录 cn.bing.com，复制完整 Cookie（必须包含 _U；KievRPSSecAuth 不能替代）粘贴到配置中心。</div>
      `;
    }

    // 3. 移动端 Token 卡片
    const pillToken = document.getElementById('diag-pill-token');
    const detailToken = document.getElementById('diag-detail-token');
    if (token.valid) {
      pillToken.className = 'diag-status-pill pill-ok';
      pillToken.innerText = '已授权正常';
      detailToken.innerHTML = `
        <div>状态：✅ OAuth Token 活跃，可执行 App 静默签到与新闻资讯阅读 (30分)</div>
        <div style="margin-top:4px; color:#E2E8F0;">${escapeHtml(token.message || '')}</div>
      `;
    } else {
      pillToken.className = 'diag-status-pill pill-err';
      pillToken.innerText = '未授权 / 失效';
      detailToken.innerHTML = `
        <div style="color:#F87171;">状态：❌ ${escapeHtml(token.message || '未获取到移动端 OAuth 授权')}</div>
        <div style="margin-top:4px; font-size:11.5px; color:#94A3B8;">建议：点击「新手配置向导」第一步，打开官方链接授权并粘贴跳转 URL。</div>
      `;
    }

    // 4. 网络卡片
    const pillNet = document.getElementById('diag-pill-network');
    const detailNet = document.getElementById('diag-detail-network');
    if (net.regionPass) {
      pillNet.className = 'diag-status-pill pill-ok';
      pillNet.innerText = '中国大陆 (安全)';
      detailNet.innerHTML = `
        <div>状态：✅ 出口 IP 符合微软国区要求 (${net.region})，防风控检测通过</div>
        <div style="margin-top:4px; font-size:11.5px; color:#94A3B8;">${escapeHtml(net.ipInfo || '')}</div>
      `;
    } else {
      pillNet.className = 'diag-status-pill pill-err';
      pillNet.innerText = `非大陆地区 (${net.region || '未知'})`;
      detailNet.innerHTML = `
        <div style="color:#F87171;">状态：⚠️ 出口位于非大陆地区，若开启国区保护将被自动停止打卡防风控。</div>
        <div style="margin-top:4px; font-size:11.5px; color:#94A3B8;">建议：如果是境外 VPS，请在配置中心设置走国内 HTTP/SOCKS5 代理。</div>
      `;
    }

    // 5. 数据概览明细
    document.getElementById('diag-val-balance').innerText = data.balance ? `${data.balance.toLocaleString()} 积分` : '--';
    document.getElementById('diag-val-search').innerText = cookie.pcSearch || '--';
    document.getElementById('diag-val-read').innerText = token.readProgress || '--';

    // 6. 建议区
    const tipsBox = document.getElementById('diag-tips');
    if (data.allValid) {
      tipsBox.innerHTML = `💡 <strong>检测完毕：</strong>账号 [${escapeHtml(accName)}] 在 Docker 中运行环境完美，点击「▶️ 立即执行」即可开始打卡！`;
    } else {
      tipsBox.innerHTML = '💡 <strong>下一步建议：</strong>请点击右上角「💡 新手配置向导」，根据缺失的项（Cookie 或 Token）补充配置即可。';
    }

    setDiagLoading(false);

    // 同步刷新大屏
    fetchStatus();
  } catch (e) {
    setDiagLoading(false);
    document.getElementById('diag-banner-title').innerText = '诊断请求失败';
    document.getElementById('diag-banner-sub').innerText = e.message;
  }
}

// 全部账号：逐个串行体检，避免并发触发微软风控
async function runAllAccountDiagnosis() {
  const accounts = currentConfig?.accounts || [];
  document.getElementById('diag-banner').style.display = 'none';
  document.getElementById('diag-cards').style.display = 'none';
  document.querySelector('.diag-summary-box').style.display = 'none';
  document.getElementById('diag-tips').style.display = 'none';
  document.getElementById('diag-all-summary').style.display = 'none';
  document.getElementById('diag-all-list').style.display = 'none';

  if (accounts.length === 0) {
    setDiagLoading(false);
    document.getElementById('diag-all-summary').style.display = 'block';
    document.getElementById('diag-all-summary').innerText = '当前没有可体检的账号。';
    return;
  }

  setDiagLoading(true, '正在批量体检所有账号，请稍候...');
  try {
    const res = await fetch('/api/auth/test-all', { method: 'POST' }).then(r => r.json());
    if (res.success && res.data?.results) {
      renderAllAccountDiagnosisResults(res.data.results);
    } else {
      throw new Error(res.message || '体检接口异常');
    }
  } catch (e) {
    const summaryBox = document.getElementById('diag-all-summary');
    summaryBox.style.display = 'block';
    summaryBox.innerHTML = `<span style="color:#EF4444;">体检失败: ${escapeHtml(e.message)}</span>`;
  } finally {
    setDiagLoading(false);
    fetchStatus();
  }
}

function renderAllAccountDiagnosisResults(results) {
  const summaryBox = document.getElementById('diag-all-summary');
  const listBox = document.getElementById('diag-all-list');
  const validCount = results.filter(r => r.allValid).length;
  const partialCount = results.filter(r => r.overallValid && !r.allValid).length;
  const failedCount = results.length - validCount - partialCount;
  summaryBox.style.display = 'block';
  summaryBox.innerHTML = `共体检 <strong>${results.length}</strong> 个账号：`
    + `<span style="color:#34D399; font-weight:700;">完全有效 ${validCount}</span> / `
    + `<span style="color:#F59E0B; font-weight:700;">部分有效 ${partialCount}</span> / `
    + `<span style="color:#F87171; font-weight:700;">失效 ${failedCount}</span>`;
  listBox.style.display = 'flex';
  listBox.innerHTML = results.map(r => {
    const name = escapeHtml(r.accountName || r.accountId || '未知账号');
    const cookieOk = !!r.cookie?.valid;
    const tokenOk = !!r.token?.valid;
    const overallOk = !!r.overallValid;
    const identity = getIdentityMeta(r);
    const cookieUnavailable = isIdentityUnavailable(r.cookie);
    const cookieCls = cookieUnavailable ? 'pill-warn' : (cookieOk ? 'pill-ok' : 'pill-err');
    const cookieText = cookieUnavailable ? '无法确认' : (cookieOk ? '有效' : '失效');
    const err = r.error ? ` · ${escapeHtml(r.error)}` : '';
    const cls = overallOk ? 'pill-ok' : 'pill-err';
    const statusText = overallOk ? (r.allValid ? '整体有效' : '部分有效') : '失效';
    return `
      <div class="diag-all-row">
        <span class="diag-all-name">${name}</span>
        <span class="diag-status-pill ${cookieCls}">Cookie ${cookieText}</span>
        <span class="diag-status-pill ${tokenOk ? 'pill-ok' : 'pill-err'}">Token ${tokenOk ? '有效' : '失效'}</span>
        <span class="diag-status-pill ${identity.cls}">${identity.icon} ${identity.text}</span>
        <span class="diag-status-pill ${cls}">${statusText}</span>
        <span class="diag-all-detail">${r.balance ? r.balance.toLocaleString() + ' 分' : '--'}${err}</span>
      </div>
    `;
  }).join('');
}

function switchHistoryDays(days) {
  currentHistoryDays = days;
  document.getElementById('btn-history-7')?.classList.toggle('active', days === 7);
  document.getElementById('btn-history-30')?.classList.toggle('active', days === 30);
  fetchHistory(days, selectedAccountId);
}

// 拉取历史记录数据 (支持单账号与全局汇总)
async function fetchHistory(days = 7, accId = selectedAccountId) {
  try {
    const target = accId || 'all';
    const res = await fetch(`/api/history?days=${days}&accountId=${target}`).then(r => r.json());
    if (res.success && Array.isArray(res.data)) {
      renderHistoryChart(res.data, days);
    }
  } catch (e) {
    console.error('获取历史记录失败:', e);
  }
}

// 渲染历史柱形图与 Hover Tooltip
function renderHistoryChart(dataList, days) {
  const container = document.getElementById('history-chart-container');
  const tooltip = document.getElementById('history-tooltip');
  if (!container || !tooltip) return;

  container.innerHTML = '';
  if (dataList.length === 0) return;

  // 计算最大值，方便归一化高度
  const maxEarned = Math.max(...dataList.map(d => d.earned || 0), 160);

  dataList.forEach((item, index) => {
    const isToday = index === dataList.length - 1;
    const heightPercent = Math.max(12, Math.min(100, Math.round((item.earned / maxEarned) * 100)));

    const col = document.createElement('div');
    col.className = `chart-col ${isToday ? 'today' : ''}`;

    col.innerHTML = `
      <div class="chart-val-hint">+${item.earned}</div>
      <div class="chart-bar-wrap">
        <div class="chart-bar" style="height: ${heightPercent}%;"></div>
      </div>
      <div class="chart-date-label">${days === 30 ? (index % 4 === 0 || isToday ? item.dayLabel : '') : item.dayLabel}</div>
    `;

    // Hover 交互
    const showTooltip = (e) => {
      document.getElementById('tt-date').innerText = `${item.date} (${item.weekday})`;
      document.getElementById('tt-earned').innerText = `+${item.earned} 积分`;
      
      const bdList = document.getElementById('tt-breakdown');
      const accList = Array.isArray(item.accounts) ? item.accounts : null;

      if (accList && accList.length > 0) {
        // 全部账号汇总模式：显示每个账号的当日数值与占比
        const total = Number(item.earned || 0);
        const rows = [...accList].sort((a, b) => Number(b.earned || 0) - Number(a.earned || 0));
        bdList.innerHTML = `
          <div class="tooltip-section-title">各账号占比（${rows.length} 个账号）</div>
          ${rows.map(a => {
            const earned = Number(a.earned || 0);
            const pct = total > 0 ? (earned / total) * 100 : 0;
            return `
              <div class="tooltip-item">
                <span class="tt-acc-name">👤 ${escapeHtml(a.name)}</span>
                <span class="tt-acc-val">+${earned}<em>${pct.toFixed(1)}%</em></span>
              </div>`;
          }).join('')}
        `;
      } else if (item.breakdown && item.breakdown.length > 0) {
        bdList.innerHTML = item.breakdown.map(b => `
          <div class="tooltip-item">
            <span>${b.icon || '📌'} ${b.name}</span>
            <span style="font-weight: 600; color: #34D399;">+${b.points}</span>
          </div>
        `).join('');
      } else {
        bdList.innerHTML = '<div style="color:#64748B;">打卡任务已满额到账</div>';
      }

      document.getElementById('tt-balance').innerText = `当日结余: ${(item.balance || 0).toLocaleString()} 积分`;

      tooltip.style.display = 'block';

      // 先显示再测量，保证多账号长列表时提示框不会被视口裁掉
      const barEl = col.querySelector('.chart-bar') || col;
      const rect = barEl.getBoundingClientRect();
      const tipRect = tooltip.getBoundingClientRect();
      const tipW = tipRect.width;
      const tipH = tipRect.height;
      const centerX = Math.max(
        tipW / 2 + 8,
        Math.min(window.innerWidth - tipW / 2 - 8, rect.left + rect.width / 2)
      );
      let top = rect.top - tipH - 12;
      if (top < 8) top = rect.bottom + 12; // 上方放不下就改放到柱子下方
      if (top + tipH > window.innerHeight - 8) {
        top = Math.max(8, window.innerHeight - tipH - 8);
      }
      tooltip.style.left = `${centerX - tipW / 2}px`;
      tooltip.style.top = `${top}px`;
    };

    col.addEventListener('mouseenter', showTooltip);
    col.addEventListener('mousemove', showTooltip);
    col.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
    });

    container.appendChild(col);
  });
}

// 测试词库来源并展示明细
async function handleTestSearchApi() {
  const selectElem = document.getElementById('cfg-search-api');
  const selectedMode = selectElem?.value || 'offline';
  const statusDiv = document.getElementById('words-modal-status');
  const tagsDiv = document.getElementById('words-modal-tags');
  
  openModal('search-words-modal');
  statusDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在请求并测试所选词库接口...</span>';
  tagsDiv.innerHTML = '';

  try {
    const res = await fetch('/api/tasks/test-search-api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchApi: selectedMode })
    }).then(r => r.json());

    if (res.success && Array.isArray(res.sample)) {
      statusDiv.innerHTML = `<span style="color:#34D399; font-weight:700;">✅ [${escapeHtml(res.name)}] 接口通畅！成功抓取 ${res.count} 条热词，前 ${res.sample.length} 条明细预览：</span>`;
      tagsDiv.innerHTML = res.sample.map((w, i) => `
        <span style="font-size:12px; padding:4px 9px; background:var(--card-bg); border:1px solid var(--border-color); border-radius:6px; color:var(--text-main);">
          ${i + 1}. ${escapeHtml(w)}
        </span>
      `).join('');
    } else {
      statusDiv.innerHTML = `<span style="color:#F87171; font-weight:700;">❌ [${escapeHtml(res.name || selectedMode)}] 获取失败: ${escapeHtml(res.message || '未知错误')}</span>`;
      tagsDiv.innerHTML = '<span style="color:var(--text-muted); font-size:12px;">未能获取到有效词条，建议切换回「本地离线智能词库（最稳定）」。</span>';
    }
  } catch (e) {
    statusDiv.innerHTML = `<span style="color:#F87171;">❌ 请求异常: ${escapeHtml(e.message)}</span>`;
  }
}

// ===== Epic 免费游戏领取 =====
let epicAccountCache = [];
let epicGamesCache = [];
let epicSettingsCache = {};
let epicStatusCache = {};

function getEpicInitial(name) {
  return Array.from(String(name || 'E').trim())[0]?.toUpperCase() || 'E';
}

function getEpicCoverHue(title) {
  let hash = 0;
  for (const ch of String(title || '')) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return hash;
}

function formatEpicShortTime(ts) {
  if (!ts) return '--';
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return '--';
  }
}

function formatEpicDeadline(value) {
  if (!value) return '结束时间待公布';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '结束时间待公布';
  const text = date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const remainMs = date.getTime() - Date.now();
  if (remainMs <= 0) return `${text} · 已结束`;
  const days = Math.max(1, Math.ceil(remainMs / 86400000));
  return `${text} · 剩 ${days} 天`;
}

function formatEpicUpcomingDeadline(startDate) {
  if (!startDate) return '即将推出';
  const d = new Date(startDate);
  if (Number.isNaN(d.getTime())) return '即将推出';
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${m}月${day}日 ${h}:${min} 解锁免费`;
}

function getEpicGameProgress(game) {
  if (game.isUpcoming) {
    return { cls: 'pending', text: '预告待开放' };
  }
  const enabledAccounts = epicAccountCache.filter(a => a.enabled !== false);
  const handled = enabledAccounts.filter(a => {
    if ((a.handledGameIds || []).includes(game.id)) return true;
    if (a.handledGames && (a.handledGames[game.id] || Object.values(a.handledGames).some(v => v.title === game.title))) return true;
    return false;
  }).length;
  if (enabledAccounts.length > 0 && handled >= enabledAccounts.length) {
    return { cls: 'complete', text: `已全入库 (${handled}/${enabledAccounts.length})` };
  }
  if (handled > 0) return { cls: 'partial', text: `已处理 ${handled}/${enabledAccounts.length}` };
  return { cls: 'pending', text: enabledAccounts.length > 0 ? '待领取' : '等待添加账号' };
}

function getEpicNextCheckText() {
  if (!epicSettingsCache.enabled || !epicStatusCache.lastCheckAt || !epicSettingsCache.checkIntervalMin) return '';
  const nextAt = epicStatusCache.lastCheckAt + Number(epicSettingsCache.checkIntervalMin) * 60000;
  if (nextAt <= Date.now()) return '即将';
  return formatEpicShortTime(nextAt);
}

function renderEpicStats() {
  const enabledAccounts = epicAccountCache.filter(a => a.enabled !== false);
  const pendingCount = epicGamesCache.filter(game => {
    const handled = enabledAccounts.filter(a => (a.handledGameIds || []).includes(game.id)).length;
    return enabledAccounts.length === 0 || handled < enabledAccounts.length;
  }).length;

  const gamesEl = document.getElementById('epic-stat-games');
  const pendingEl = document.getElementById('epic-stat-pending');
  const accountsEl = document.getElementById('epic-stat-accounts');
  const checkedEl = document.getElementById('epic-stat-checked');
  const checkedLabel = document.getElementById('epic-stat-checked-label');
  const demoBanner = document.getElementById('epic-demo-banner');

  if (gamesEl) gamesEl.innerText = epicGamesCache.length;
  if (pendingEl) pendingEl.innerText = pendingCount;
  if (accountsEl) {
    accountsEl.innerText = enabledAccounts.length;
    accountsEl.title = `共 ${epicAccountCache.length} 个账号，${enabledAccounts.length} 个已启用`;
  }
  if (checkedEl) checkedEl.innerText = epicStatusCache.lastCheckAt ? formatEpicShortTime(epicStatusCache.lastCheckAt) : '尚未检查';
  const nextCheck = getEpicNextCheckText();
  if (checkedLabel) checkedLabel.innerText = nextCheck ? `下次检查 ${nextCheck}` : '上次检查';
  if (demoBanner) demoBanner.style.display = epicStatusCache.demo ? 'flex' : 'none';
}

function initEpicUI() {
  document.getElementById('btn-epic-add')?.addEventListener('click', () => openEpicModal(null));
  document.getElementById('btn-close-epic-modal')?.addEventListener('click', () => closeModal('epic-account-modal'));
  document.getElementById('btn-cancel-epic-modal')?.addEventListener('click', () => closeModal('epic-account-modal'));
  document.getElementById('btn-save-epic-modal')?.addEventListener('click', saveEpicAccount);
  document.getElementById('btn-epic-claim-all')?.addEventListener('click', () => claimEpic(null));
  document.getElementById('btn-epic-refresh-games')?.addEventListener('click', () => fetchEpicFreeGames(true));
  document.getElementById('btn-epic-save-settings')?.addEventListener('click', saveEpicSettings);
  document.getElementById('btn-epic-stop')?.addEventListener('click', stopEpicTask);

  // 商店检测周期预设（常规每周 vs 节日每日）
  document.querySelectorAll('.cycle-pill').forEach(btn => {
    btn.addEventListener('click', async () => {
      const min = Number(btn.getAttribute('data-min'));
      document.querySelectorAll('.cycle-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const intervalInput = document.getElementById('epic-set-interval');
      if (intervalInput) intervalInput.value = min;
      try {
        const res = await fetch('/api/epic/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ checkIntervalMin: min })
        }).then(r => r.json());
        if (res.success) {
          epicSettingsCache = res.data;
          renderEpicStats();
        }
      } catch {}
    });
  });

  // Epic 页激活时轮询浏览器状态，方便判断是否卡死
  setInterval(() => {
    if (document.getElementById('tab-panel-epic')?.classList.contains('active')) {
      fetchEpicStatus();
    }
  }, 3000);
}

function formatEpicTime(ts) {
  if (!ts) return '--';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '--';
  }
}

async function fetchEpicAccounts() {
  try {
    const res = await fetch('/api/epic/accounts').then(r => r.json());
    if (res.success) {
      epicAccountCache = res.data || [];
      renderEpicAccounts(epicAccountCache);
      if (epicGamesCache && epicGamesCache.length > 0) renderEpicGames(epicGamesCache);
    }
  } catch {}
}

function renderEpicAccounts(accounts) {
  const grid = document.getElementById('epic-accounts-grid');
  const empty = document.getElementById('epic-empty');
  if (!grid) return;
  if (!accounts || accounts.length === 0) {
    grid.innerHTML = '';
    if (empty) empty.style.display = 'block';
    renderEpicStats();
    return;
  }
  if (empty) empty.style.display = 'none';

  grid.innerHTML = accounts.map(a => {
    const sessionBadge = !a.hasSession
      ? '<span class="epic-badge warn">未导入会话</span>'
      : a.sessionValid === true
        ? '<span class="epic-badge ok">会话有效</span>'
        : a.sessionValid === false
          ? '<span class="epic-badge err">会话失效</span>'
          : '<span class="epic-badge idle">未校验</span>';
    const enabledBadge = a.enabled ? '<span class="epic-badge ok">已启用</span>' : '<span class="epic-badge idle">已停用</span>';
    const handledCount = (a.handledGameIds || []).length;
    const verifyTip = a.lastVerifyMessage ? ` title="${escapeHtml(a.lastVerifyMessage)}"` : '';
    return `
      <div class="epic-account-card">
        <div class="epic-account-top">
          <div class="epic-account-identity">
            <span class="epic-account-avatar">${escapeHtml(getEpicInitial(a.name))}</span>
            <span class="epic-account-copy">
              <span class="epic-account-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>
              <span class="epic-account-order">Epic 账号 #${escapeHtml(String(a.order || '-'))}</span>
            </span>
          </div>
          <span class="epic-account-badges">${enabledBadge}${sessionBadge}</span>
        </div>
        <div class="epic-account-meta">
          <div class="epic-account-meta-item">
            <span>会话凭据</span>
            <strong>${a.cookieCount || 0} 条${a.hasEpicSession ? ' · 含登录态' : ''}</strong>
          </div>
          <div class="epic-account-meta-item"${verifyTip}>
            <span>上次校验</span>
            <strong>${formatEpicTime(a.lastVerifyAt)}</strong>
          </div>
          <div class="epic-account-meta-item">
            <span>已处理游戏</span>
            <strong>${handledCount} 个</strong>
          </div>
          <div class="epic-account-meta-item">
            <span>上次领取</span>
            <strong>${formatEpicTime(a.lastClaimAt)}</strong>
          </div>
        </div>
        <div class="epic-account-actions">
          <button class="btn btn-primary btn-sm epic-claim" data-id="${a.id}" title="为这个账号领取">▶️ 领取</button>
          <button class="btn btn-secondary btn-sm epic-verify" data-id="${a.id}" title="校验浏览器会话">🔍 校验</button>
          <button class="btn btn-secondary btn-sm epic-import" data-id="${a.id}" title="编辑账号名称或更新浏览器会话 Cookie">✏️ 编辑</button>
          <button class="btn btn-secondary btn-sm epic-toggle" data-id="${a.id}" title="${a.enabled ? '停用此账号' : '启用此账号'}">${a.enabled ? '⏸️ 停用' : '▶️ 启用'}</button>
          <button class="btn btn-danger btn-sm epic-delete" data-id="${a.id}" title="删除此账号">🗑️ 删除</button>
        </div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.epic-claim').forEach(b => b.addEventListener('click', () => claimEpic(b.getAttribute('data-id'))));
  grid.querySelectorAll('.epic-verify').forEach(b => b.addEventListener('click', () => verifyEpicSession(b.getAttribute('data-id'))));
  grid.querySelectorAll('.epic-import').forEach(b => b.addEventListener('click', () => openEpicModal(b.getAttribute('data-id'))));
  grid.querySelectorAll('.epic-toggle').forEach(b => b.addEventListener('click', () => toggleEpicAccount(b.getAttribute('data-id'))));
  grid.querySelectorAll('.epic-delete').forEach(b => b.addEventListener('click', () => deleteEpicAccount(b.getAttribute('data-id'))));

  renderEpicStats();
  if (epicStatusCache.records) renderEpicRecords(epicStatusCache.records);
}

function renderEpicGames(games) {
  const list = document.getElementById('epic-games-list');
  const updated = document.getElementById('epic-games-updated');
  if (!list) return;
  epicGamesCache = Array.isArray(games) ? games : [];
  if (updated) updated.innerText = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · 共 ${epicGamesCache.length} 款游戏`;
  if (!games || games.length === 0) {
    list.innerHTML = '<div class="epic-empty">当前没有可领取的免费游戏</div>';
    renderEpicStats();
    return;
  }

  const nowFree = epicGamesCache.filter(g => g.isFreeNow !== false && !g.isUpcoming);
  const upcoming = epicGamesCache.filter(g => g.isUpcoming || g.isFreeNow === false);

  const renderCard = (g) => {
    const isUpcoming = !!g.isUpcoming;
    const progress = getEpicGameProgress(g);
    const cover = g.image
      ? `<img src="${escapeHtml(g.image)}" alt="${escapeHtml(g.title)}" loading="lazy">`
      : `<div class="epic-game-cover-fallback"><span>${escapeHtml(getEpicInitial(g.title))}</span><small>${isUpcoming ? 'COMING SOON' : 'FREE GAME'}</small></div>`;
    const link = g.url
      ? `<a class="btn btn-secondary btn-sm" href="${escapeHtml(g.url)}" target="_blank" rel="noopener">${isUpcoming ? '预告页面' : '打开商店'}</a>`
      : '';

    // 悬停各账号在库详情与领取时间
    const accountRows = (epicAccountCache || []).map(a => {
      const rec = a.handledGames?.[g.id]
        || (a.handledGames && Object.values(a.handledGames).find(v => v.title === g.title));
      let statusCls = 'pending';
      let label = '⏳ 尚未入库 / 待领取';
      let timeText = '';
      if (isUpcoming) {
        label = '⏳ 尚未解锁 (开放后自动领取)';
      } else if (rec) {
        if (rec.status === 'claimed') {
          statusCls = 'claimed';
          label = '✅ 自动化已领取';
          const at = rec.at ? new Date(rec.at).toLocaleString('zh-CN', { hour12: false }) : '';
          timeText = at ? `领取时间: ${at}` : '';
        } else if (rec.status === 'owned') {
          statusCls = 'owned';
          label = '📦 原已在库中';
          const at = rec.at ? new Date(rec.at).toLocaleDateString('zh-CN') : '';
          timeText = at ? `核验于: ${at}` : '';
        }
      }
      return `
        <div class="epic-tooltip-row">
          <div class="epic-tooltip-acc ${statusCls}">
            <span>👤 ${escapeHtml(a.name || a.id)}</span>
            <span>${escapeHtml(label)}</span>
          </div>
          ${timeText ? `<span class="epic-tooltip-time">${escapeHtml(timeText)}</span>` : ''}
        </div>
      `;
    }).join('');

    const deadlineText = isUpcoming
      ? `<span>⏳</span> ${escapeHtml(formatEpicUpcomingDeadline(g.startDate, g.endDate))}`
      : `<span>⏳</span> ${escapeHtml(formatEpicDeadline(g.endDate))}`;

    const freeTagCls = isUpcoming ? 'epic-game-free-tag tag-upcoming' : 'epic-game-free-tag tag-now';
    const freeTagText = isUpcoming ? '即将推出' : '限时免费';

    return `
      <article class="epic-game-card${isUpcoming ? ' card-upcoming' : ''}">
        <div class="epic-game-tooltip">
          <div class="epic-tooltip-title">${escapeHtml(g.title)} · 各账号在库状态</div>
          <div class="epic-tooltip-list">
            ${accountRows || '<div class="epic-tooltip-row"><span class="epic-tooltip-time">暂未配置任何 Epic 账号</span></div>'}
          </div>
        </div>
        <div class="epic-game-cover" style="--cover-h: ${getEpicCoverHue(g.title)};">
          ${cover}
          <span class="${freeTagCls}">${freeTagText}</span>
        </div>
        <div class="epic-game-card-body">
          <div class="epic-game-card-title" title="${escapeHtml(g.title)}">${escapeHtml(g.title)}</div>
          <div class="epic-game-card-deadline">${deadlineText}</div>
        </div>
        <div class="epic-game-card-footer">
          <span class="epic-game-status ${progress.cls}">● ${escapeHtml(progress.text)}</span>
          ${link}
        </div>
      </article>`;
  };

  // 4 款游戏一行陈列（桌面端 4 列紧凑排布，移动端响应式折行）
  list.innerHTML = `
    <div class="epic-cards-row">
      ${epicGamesCache.map(renderCard).join('')}
    </div>
  `;
  renderEpicStats();
}

function renderEpicRecords(records) {
  const box = document.getElementById('epic-records');
  if (!box) return;
  if (!records || records.length === 0) {
    box.innerHTML = '<div class="epic-empty">暂无领取记录</div>';
    return;
  }
  box.innerHTML = records.map(r => {
    const accountName = epicAccountCache.find(a => a.id === r.accountId)?.name || '';
    const statusMap = {
      claimed: { cls: 'ok', text: '已领取' },
      owned: { cls: 'warn', text: '已拥有' },
      failed: { cls: 'err', text: '失败' }
    };
    const status = statusMap[r.status] || { cls: r.ok ? 'ok' : 'err', text: r.ok ? '成功' : '失败' };
    const message = accountName ? `[${accountName}] ${r.message || ''}` : (r.message || '');
    return `
      <div class="epic-record-row">
        <span class="epic-badge ${status.cls}">${status.text}</span>
        <span class="epic-record-time">${formatEpicTime(r.at)}</span>
        <span class="epic-record-title" title="${escapeHtml(r.title)}">${escapeHtml(r.title)}</span>
        <span class="epic-record-message" title="${escapeHtml(message)}">${escapeHtml(message)}</span>
      </div>`;
  }).join('');
}

async function fetchEpicStatus() {
  try {
    const res = await fetch('/api/epic/status').then(r => r.json());
    if (res.success) {
      epicStatusCache = { ...epicStatusCache, ...(res.data || {}) };
      renderEpicRecords(epicStatusCache.records || []);
      renderEpicBrowserStatus(epicStatusCache);
    }
  } catch {}
}

async function fetchEpicFreeGames(manual = false) {
  const list = document.getElementById('epic-games-list');
  if (manual && list) list.innerHTML = '<div class="epic-empty">正在获取免费游戏列表...</div>';
  try {
    const res = await fetch('/api/epic/free-games').then(r => r.json());
    if (res.success) renderEpicGames(res.data || []);
    else if (list) list.innerHTML = `<div class="epic-empty">获取失败：${escapeHtml(res.message || '')}</div>`;
  } catch (e) {
    if (list) list.innerHTML = `<div class="epic-empty">获取失败：${escapeHtml(e.message)}</div>`;
  }
}

function openEpicModal(accountId) {
  if (accountId && (epicStatusCache.running || epicStatusCache.verifying)) {
    openEpicActionModal(
      'Epic 任务正在运行',
      '当前无法编辑会话，请先停止 Epic 任务。',
      ['等待当前任务结束', '或点击停止按钮释放浏览器', '再重新编辑会话'],
      1
    );
    updateEpicActionModal({
      progress: 100,
      badge: { text: '请先停止', cls: 'warn' },
      result: '运行期间更新会话不会被当前浏览器使用，而且可能在结束时覆盖新凭据。请先停止任务。'
    });
    return;
  }
  const acc = accountId ? epicAccountCache.find(a => a.id === accountId) : null;
  document.getElementById('epic-modal-title').innerText = acc ? `编辑 Epic 账号：${acc.name}` : '添加 Epic 账号';
  document.getElementById('epic-account-name').value = acc ? acc.name : '';
  document.getElementById('epic-account-name').dataset.accountId = acc ? acc.id : '';
  const sessionInput = document.getElementById('epic-session-input');
  if (sessionInput) {
    sessionInput.value = '';
    sessionInput.placeholder = acc?.hasSession
      ? '已配置会话 Cookie（内容已隐藏，留空保持不变，可直接粘贴新 JSON 或 Cookie 覆盖）'
      : '粘贴 Cookie-Editor 导出的 JSON、Playwright storageState，或 a=1; b=2 形式的 Cookie 串';
  }
  openModal('epic-account-modal');
}

async function saveEpicAccount() {
  const nameEl = document.getElementById('epic-account-name');
  const sessionEl = document.getElementById('epic-session-input');
  const accountId = nameEl.dataset.accountId || '';
  const name = nameEl.value.trim();
  const session = sessionEl.value.trim();

  if (!name && !accountId) {
    openEpicActionModal('无法保存 Epic 账号', '请先填写账号备注名称。', ['填写账号名称', '重新保存'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '参数缺失', cls: 'warn' } });
    return;
  }

  try {
    const res = await fetch('/api/epic/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(accountId ? { id: accountId, name } : { name })
    }).then(r => r.json());
    if (!res.success) throw new Error(res.message || '保存失败');

    const savedId = res.data?.id || accountId;
    if (session && savedId) {
      const sres = await fetch(`/api/epic/accounts/${savedId}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session })
      }).then(r => r.json());
      if (!sres.success) throw new Error(sres.message || '会话导入失败');
    }

    closeModal('epic-account-modal');
    await fetchEpicAccounts();
    openEpicActionModal(
      'Epic 账号已保存',
      session ? '账号备注已更新，并成功导入新会话 Cookie！' : '账号备注名称已成功更新！',
      ['保存账号信息', session ? '解析并导入 Cookie' : '保留已有会话', '刷新账号列表'],
      2
    );
    updateEpicActionModal({
      progress: 100,
      badge: { text: '已保存', cls: 'ok' },
      result: `账号 [${name || accountId}] 已就绪。\n${session ? '提示：建议点击卡片上的「🔍 校验」按钮通过网页进度弹窗确认会话连通性。' : ''}`
    });
  } catch (e) {
    openEpicActionModal('Epic 账号保存失败', e.message, ['保存账号信息', '校验结果'], 0);
    updateEpicActionModal({
      progress: 100,
      badge: { text: '保存失败', cls: 'err' },
      result: `保存失败：${e.message}`
    });
  }
}

async function verifyEpicSession(accountId) {
  const acc = epicAccountCache.find(a => a.id === accountId);
  const ok = await showWebConfirm(
    `确定要校验 Epic 账号「${acc?.name || accountId}」的会话吗？\n将启动持久化无头浏览器访问 Epic 官网并实时返回检测进度。`,
    '校验 Epic 会话'
  );
  if (!ok) return;

  openEpicActionModal(
    `校验 Epic 账号 · ${acc?.name || accountId}`,
    '正在启动持久化浏览器并检测商城会话...',
    ['初始化持久化配置', '打开 Epic 商城首页', '检测人机验证与覆盖层', '核验登录状态', '同步更新凭据'],
    0,
    true
  );
  startEpicActionPolling();

  try {
    updateEpicActionModal({ activeIndex: 1, message: '正在加载 Epic 商城首页...', progress: 25 });
    const res = await fetch(`/api/epic/accounts/${accountId}/verify`, { method: 'POST' }).then(r => r.json());
    stopEpicActionPolling();
    if (res.success) {
      const d = res.data || {};
      if (d.valid) {
        updateEpicActionModal({
          activeIndex: 5,
          progress: 100,
          badge: { text: '会话有效', cls: 'ok' },
          message: '✅ 校验通过：会话有效且处于已登录状态！',
          result: `账号 [${acc?.name || accountId}] 校验成功！\n状态：${d.message}\n已自动保留持久化指纹与 Cookie，可正常执行自动化领取。`
        });
      } else if (d.blocked) {
        updateEpicActionModal({
          activeIndex: 2,
          progress: 80,
          badge: { text: '人机验证拦截', cls: 'warn' },
          message: '⚠️ 触发 Epic 商店人机验证',
          result: `提示：${d.message}\n持久化配置文件已保留。如果当前网络环境风险较高，可稍后再试，或通过电脑端将最新有效会话重新导入。`
        });
      } else {
        updateEpicActionModal({
          activeIndex: 3,
          progress: 100,
          badge: { text: '会话失效', cls: 'err' },
          message: '❌ 会话已失效或未登录',
          result: `提示：${d.message}\n请在电脑浏览器中登录 store.epicgames.com 后重新导出并粘贴最新 Cookie。`
        });
      }
    } else {
      updateEpicActionModal({
        progress: 100,
        badge: { text: '校验失败', cls: 'err' },
        message: res.message || '校验失败',
        result: `失败原因：${res.message || '未知错误'}`
      });
    }
    await fetchEpicAccounts();
    await fetchEpicStatus();
  } catch (e) {
    stopEpicActionPolling();
    updateEpicActionModal({
      progress: 100,
      badge: { text: '校验异常', cls: 'err' },
      message: e.message,
      result: `请求异常：${e.message}`
    });
  }
}

async function toggleEpicAccount(accountId) {
  const acc = epicAccountCache.find(a => a.id === accountId);
  if (!acc) return;
  try {
    await fetch('/api/epic/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: accountId, name: acc.name, enabled: !acc.enabled })
    });
    await fetchEpicAccounts();
  } catch (e) {
    openEpicActionModal('Epic 账号操作失败', e.message, ['更新账号状态', '刷新账号列表'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '操作失败', cls: 'err' }, result: `操作失败：${e.message}` });
  }
}

async function deleteEpicAccount(accountId) {
  const acc = epicAccountCache.find(a => a.id === accountId);
  const ok = await showWebConfirm(`确定删除 Epic 账号「${acc?.name || accountId}」吗？\n该账号的会话与持久化浏览器数据将被一并清理。`, '删除 Epic 账号');
  if (!ok) return;
  try {
    const res = await fetch(`/api/epic/accounts/${accountId}`, { method: 'DELETE' }).then(r => r.json());
    if (!res.success) {
      openEpicActionModal('Epic 账号删除失败', res.message || '删除失败', ['删除账号配置', '校验结果'], 0);
      updateEpicActionModal({ progress: 100, badge: { text: '删除失败', cls: 'err' } });
      return;
    }
    await fetchEpicAccounts();
  } catch (e) {
    openEpicActionModal('Epic 账号删除异常', e.message, ['删除账号配置', '校验结果'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '删除异常', cls: 'err' }, result: `删除异常：${e.message}` });
  }
}

async function claimEpic(accountId) {
  const label = accountId
    ? `Epic 账号「${epicAccountCache.find(a => a.id === accountId)?.name || accountId}」`
    : '全部已启用的 Epic 账号';
  const ok = await showWebConfirm(
    `立即为${label}领取当前免费游戏？\n系统将启动持久化无头浏览器自动完成订单，弹窗将实时跟踪当前步数。`,
    '领取 Epic 免费游戏'
  );
  if (!ok) return;

  const btn = accountId ? null : document.getElementById('btn-epic-claim-all');
  const orig = btn ? btn.innerHTML : '';
  if (btn) btn.innerHTML = '⏳ 领取中...';

  openEpicActionModal(
    `免费游戏自动领取 · ${label}`,
    '正在检查免费游戏列表与各账号在库状态...',
    ['检查本周免费游戏', '启动持久化浏览器', '进入游戏商品页', '处理人机验证覆盖层', '确认并提交订单', '核销入库结果'],
    0,
    true
  );
  startEpicActionPolling();

  try {
    const res = await fetch('/api/epic/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(accountId ? { accountId } : {})
    }).then(r => r.json());
    stopEpicActionPolling();

    if (!res.success) throw new Error(res.message || '领取失败');

    const data = res.data || {};
    let resultText = '';
    const results = data.results || [];
    if (results.length > 0) {
      const blocks = [];
      results.forEach(group => {
        const title = group.accountName ? `【账号: ${group.accountName}】` : '';
        const items = (group.results || []).map(r => {
          const icon = r.ok ? '✅' : (r.status === 'blocked' ? '🛡️' : '❌');
          return `  ${icon} ${r.title}：${r.message || (r.ok ? '成功' : '失败')}`;
        });
        if (group.error) items.push(`  ⚠️ 异常：${group.error}`);
        blocks.push(`${title}\n${items.join('\n') || '  (无需处理的游戏)'}`);
      });
      resultText = blocks.join('\n\n');
    } else {
      resultText = '本轮执行完毕，所有游戏均无需重复领取。';
    }

    updateEpicActionModal({
      activeIndex: 6,
      progress: 100,
      badge: { text: '领取结束', cls: 'ok' },
      message: '本轮免费游戏领取已全部处理完毕',
      result: resultText
    });

    await fetchEpicAccounts();
    await fetchEpicStatus();
  } catch (e) {
    stopEpicActionPolling();
    updateEpicActionModal({
      progress: 100,
      badge: { text: '领取异常', cls: 'err' },
      message: e.message,
      result: `领取异常：${e.message}`
    });
  } finally {
    if (btn) btn.innerHTML = orig;
  }
}

async function refreshEpicTab() {
  const list = document.getElementById('epic-games-list');
  await Promise.all([
    loadEpicSettings(),
    fetchEpicAccounts(),
    fetchEpicStatus()
  ]);
  if (!list?.dataset.loaded) {
    await fetchEpicFreeGames(false);
    if (list) list.dataset.loaded = '1';
  } else if (epicGamesCache && epicGamesCache.length > 0) {
    renderEpicGames(epicGamesCache);
  }
  renderEpicStats();
}

// ===== Epic 领取设置 =====
async function loadEpicSettings() {
  try {
    const res = await fetch('/api/epic/settings').then(r => r.json());
    if (!res.success) return;
    const s = res.data || {};
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val;
    };
    const enabledEl = document.getElementById('epic-set-enabled');
    if (enabledEl) enabledEl.checked = s.enabled !== false;
    set('epic-set-interval', s.checkIntervalMin ?? 30);
    set('epic-set-retry', s.retryCount ?? 2);
    set('epic-set-retry-interval', s.retryIntervalSec ?? 60);
    set('epic-set-account-gap', s.accountGapSec ?? 20);

    const curMin = Number(s.checkIntervalMin ?? 720);
    document.querySelectorAll('.cycle-pill').forEach(btn => {
      const bMin = Number(btn.getAttribute('data-min'));
      if (bMin === curMin) btn.classList.add('active');
      else btn.classList.remove('active');
    });

    epicSettingsCache = s;
    renderEpicStats();
  } catch {}
}

async function saveEpicSettings() {
  const body = {
    enabled: document.getElementById('epic-set-enabled')?.checked !== false,
    checkIntervalMin: Number(document.getElementById('epic-set-interval')?.value),
    retryCount: Number(document.getElementById('epic-set-retry')?.value),
    retryIntervalSec: Number(document.getElementById('epic-set-retry-interval')?.value),
    accountGapSec: Number(document.getElementById('epic-set-account-gap')?.value)
  };
  try {
    const res = await fetch('/api/epic/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(r => r.json());
    if (!res.success) throw new Error(res.message || '保存失败');
    epicSettingsCache = res.data || {};
    await loadEpicSettings();
    openEpicActionModal('Epic 领取设置已保存', '新的检查与重试策略已即时生效。', ['校验设置参数', '写入配置', '重启调度器'], 3);
    updateEpicActionModal({ progress: 100, badge: { text: '已保存', cls: 'ok' } });
  } catch (e) {
    openEpicActionModal('Epic 设置保存失败', e.message, ['校验设置参数', '写入配置'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '保存失败', cls: 'err' }, result: `保存失败：${e.message}` });
  }
}

// ===== Epic 无头浏览器状态 =====
const EPIC_STATUS_TEXT = {
  idle: '空闲',
  checking: '检查中',
  navigating: '打开页面',
  clicking: '点击获取',
  ordering: '确认订单',
  waiting: '等待中',
  retrying: '重试中',
  stopping: '停止中',
  done: '已完成'
};

function renderEpicBrowserStatus(data) {
  const badge = document.getElementById('epic-browser-badge');
  const action = document.getElementById('epic-browser-action');
  const meta = document.getElementById('epic-browser-meta');
  const updated = document.getElementById('epic-browser-updated');
  if (!badge || !action) return;

  epicStatusCache = { ...epicStatusCache, ...(data || {}) };
  const st = data.state || {};
  const running = !!data.running;
  const activeStatuses = ['checking', 'navigating', 'challenge', 'clicking', 'ordering', 'waiting', 'retrying', 'verifying', 'stopping'];
  const active = running || data.verifying || activeStatuses.includes(st.status);
  const label = EPIC_STATUS_TEXT[st.status] || '空闲';
  badge.className = `epic-badge ${st.status === 'stopping' || st.status === 'challenge' ? 'warn' : (active || st.status === 'done' ? 'ok' : 'idle')}`;
  badge.innerText = active ? `● ${label}` : label;
  action.innerText = st.lastAction || (active ? '执行中...' : '当前没有正在执行的领取任务');

  const parts = [];
  if (st.accountName) parts.push(`账号：${st.accountName}`);
  if (st.gameTitle) parts.push(`游戏：${st.gameTitle}`);
  if (st.maxAttempts > 0) parts.push(`尝试：${st.attempt || 0}/${st.maxAttempts}`);
  if (data.lastCheckAt) parts.push(`上次检查：${formatEpicTime(data.lastCheckAt)}`);
  const nextCheck = getEpicNextCheckText();
  if (nextCheck) parts.push(`下次检查：${nextCheck}`);
  if (data.demo) parts.push('⚠️ 演示模式（不启动浏览器）');
  if (meta) meta.innerText = parts.length > 0 ? parts.join('  ｜  ') : '等待首次检查';
  if (updated) {
    updated.innerText = st.lastUpdate
      ? `更新于 ${new Date(st.lastUpdate).toLocaleTimeString('zh-CN', { hour12: false })}`
      : '--';
  }
  const stopBtn = document.getElementById('btn-epic-stop');
  if (stopBtn) {
    stopBtn.style.display = active ? 'inline-flex' : 'none';
    stopBtn.disabled = st.status === 'stopping';
    stopBtn.innerText = st.status === 'stopping' ? '⏳ 停止中' : '⏹️ 停止 Epic';
  }
  renderEpicStats();
}

// ===== 全部历史日志弹窗 =====
let logsModalEntries = [];
let logsModalOpen = false;

function initLogsModal() {
  document.getElementById('btn-open-logs')?.addEventListener('click', openLogsModal);
  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    if (!confirm('确定要退出当前管理员登录吗？')) return;
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch {}
    window.location.href = '/login.html';
  });
  document.getElementById('btn-close-logs')?.addEventListener('click', closeLogsModal);
  document.getElementById('btn-close-logs-btn')?.addEventListener('click', closeLogsModal);
  document.getElementById('logs-filter')?.addEventListener('input', () => renderLogsModal());
  document.getElementById('btn-logs-clear')?.addEventListener('click', () => {
    logsModalEntries = [];
    renderLogsModal();
  });
}

async function openLogsModal() {
  logsModalOpen = true;
  openModal('logs-modal');
  const list = document.getElementById('logs-modal-list');
  if (list) list.innerHTML = '<div class="logs-empty">正在加载历史日志...</div>';
  try {
    const res = await fetch('/api/logs/history?limit=500').then(r => r.json());
    logsModalEntries = res.success ? (res.data || []) : [];
  } catch {
    logsModalEntries = [];
  }
  renderLogsModal(true);
}

function closeLogsModal() {
  logsModalOpen = false;
  closeModal('logs-modal');
}

function renderLogsModal(scrollToBottom = false) {
  const list = document.getElementById('logs-modal-list');
  if (!list) return;
  const filter = (document.getElementById('logs-filter')?.value || '').trim().toLowerCase();
  const rows = logsModalEntries.filter(e => {
    if (!filter) return true;
    return `${e.accountName || ''} ${e.message || ''} ${e.icon || ''}`.toLowerCase().includes(filter);
  });
  if (rows.length === 0) {
    list.innerHTML = `<div class="logs-empty">${logsModalEntries.length === 0 ? '暂无日志' : '没有匹配的日志'}</div>`;
    return;
  }
  list.innerHTML = rows.map(e => `
    <div class="logs-line">
      <span class="logs-time">[${escapeHtml(e.fullTime || e.time || '')}]</span>
      <span>${escapeHtml(e.icon || 'ℹ️')}</span>
      ${e.accountName ? `<span class="logs-acc">[${escapeHtml(e.accountName)}]</span>` : ''}
      <span>${escapeHtml(e.message || '')}</span>
    </div>`).join('');

  const auto = document.getElementById('logs-autoscroll');
  if (scrollToBottom || auto?.checked) list.scrollTop = list.scrollHeight;
}

function appendLogToModal(entry) {
  if (!logsModalOpen || !entry) return;
  logsModalEntries.push({
    fullTime: entry.fullTime || '',
    time: entry.time || '',
    icon: entry.icon || 'ℹ️',
    accountName: entry.accountName || '',
    message: entry.message || ''
  });
  if (logsModalEntries.length > 800) logsModalEntries.shift();
  renderLogsModal();
}

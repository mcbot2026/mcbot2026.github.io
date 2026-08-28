const STORAGE_KEY = 'mergedemo.release.console.config.v1';
const POLL_INTERVAL_MS = 5000;
const TERMINAL_JOB_STATUSES = new Set([
  'active-base',
  'blocked',
  'built',
  'cancelled',
  'checked',
  'complete',
  'dry-run',
  'exported',
  'failed',
  'patch-recorded',
  'patch-verified',
  'published',
  'recovered',
  'resources-verified',
  'uploaded',
  'wechat-dev-uploaded',
  'wechat-preview-ready',
]);

const FAILED_JOB_STATUSES = new Set([
  'blocked',
  'cancelled',
  'failed',
]);

const state = {
  view: 'overview',
  tab: {
    android: 'base',
    wechat: 'wechatExport',
  },
  config: loadConfig(),
  lastStatus: null,
  poll: {
    handle: null,
    apiRunId: null,
    jobId: null,
    signature: '',
    statusElement: null,
    actionButton: null,
  },
};

const viewMeta = {
  overview: ['总览', '查看发布状态、锁和最近任务。'],
  android: ['Android 发布', 'Base 和 Patch 发布流程。'],
  wechat: ['微信发布', '开发包导出和资源上传。'],
  tasks: ['任务记录', '查询任务证据并处理终止请求。'],
  logs: ['日志', '查看最近一次接口调用结果。'],
};

const dangerousActions = new Set([
  'runBaseBuild',
  'runPatchBuild',
  'checkPatch',
  'uploadBaseApk',
  'activateBase',
  'publishPatch',
  'recordPatch',
  'recoverPatch',
  'cancelJob',
  'wechatExport',
  'wechatRecover',
  'wechatUploadResources',
  'wechatRecoverResources',
  'setVersion',
  'clearVersion',
]);

const actionLabels = {
  envCheck: '检查环境',
  credentialsCheck: '检查凭据',
  resourcePublishHealth: '检查上传工具',
  lockStatus: '查看发布锁',
  jobStatus: '查询最近任务',
  jobStatusByInput: '查询任务',
  preflightBase: 'Base 预检',
  runBaseBuild: '开始 Base 构建',
  preflightPatch: 'Patch 预检',
  runPatchBuild: '开始 Patch 构建',
  checkPatch: '检测热更',
  uploadBaseApk: '上传 Base APK',
  activateBase: '激活 Base',
  publishPatch: '发布 Patch 资源',
  recordPatch: '记录 Patch',
  recoverPatch: '恢复 Patch',
  cancelJob: '终止任务',
  wechatPreflight: '微信导出预检',
  wechatExport: '导出微信开发包',
  wechatRecover: '恢复微信导出',
  wechatResourcesPreflight: '微信资源预检',
  wechatUploadResources: '上传微信资源',
  wechatRecoverResources: '恢复微信资源上传',
  versionStatus: '查看版本',
  setVersion: '设置临时 AppVersion',
  clearVersion: '清除临时 AppVersion',
};

function $(selector) {
  return document.querySelector(selector);
}

function $all(selector) {
  return [...document.querySelectorAll(selector)];
}

function loadConfig() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return { apiBaseUrl: '', apiToken: '' };
  }
  const value = JSON.parse(raw);
  return {
    apiBaseUrl: typeof value.apiBaseUrl === 'string' ? value.apiBaseUrl : '',
    apiToken: typeof value.apiToken === 'string' ? value.apiToken : '',
  };
}

function saveConfig(config) {
  state.config = config;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

function defaultApiBaseUrl() {
  if (window.location.hostname.endsWith('github.io')) {
    return '';
  }
  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') {
    return '';
  }
  return window.location.origin;
}

function effectiveApiBaseUrl() {
  return state.config.apiBaseUrl.trim() || defaultApiBaseUrl();
}

function apiUrl(path) {
  const base = effectiveApiBaseUrl().replace(/\/+$/u, '');
  if (!base) {
    throw new Error('API 地址未配置。');
  }
  return `${base}${path}`;
}

function authHeaders() {
  if (!state.config.apiToken.trim()) {
    throw new Error('访问 Token 未配置。');
  }
  return { Authorization: `Bearer ${state.config.apiToken.trim()}` };
}

async function readApiResponse(response) {
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json') && text
    ? JSON.parse(text)
    : { raw: text };
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} ${response.statusText}\n${JSON.stringify(body, null, 2)}`);
    error.responseBody = body;
    throw error;
  }
  return body;
}

async function apiGet(path, authenticated = true) {
  const response = await fetch(apiUrl(path), {
    method: 'GET',
    headers: authenticated ? authHeaders() : {},
  });
  return readApiResponse(response);
}

async function apiRun(commandId, params = {}, execute = false) {
  const response = await fetch(apiUrl('/api/run'), {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ commandId, params, execute }),
  });
  return readApiResponse(response);
}

async function apiRunStatus(apiRunId) {
  return apiGet(`/api/api-run-status?apiRunId=${encodeURIComponent(apiRunId)}`);
}

async function apiJobStatus(jobId) {
  const suffix = jobId ? `?jobId=${encodeURIComponent(jobId)}` : '';
  return apiGet(`/api/job-status${suffix}`);
}

function stackOf(error) {
  return error?.stack ?? `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;
}

function log(title, value) {
  const time = new Date().toLocaleString();
  const payload = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  $('#logOutput').textContent = `[${time}] ${title}\n${payload}\n\n${$('#logOutput').textContent}`;
}

function formatFeedback(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function actionStatusFromSource(source) {
  if (source?.classList?.contains('action-status')) {
    return source;
  }
  const panelStatus = source?.closest?.('.panel')?.querySelector('.action-status');
  return panelStatus ?? null;
}

function setActionStatus(source, kind, title, value = '') {
  const status = actionStatusFromSource(source);
  if (!status) {
    return;
  }
  const payload = formatFeedback(value);
  const time = new Date().toLocaleTimeString();
  status.className = `action-status ${kind}`;
  status.textContent = payload ? `[${time}] ${title}\n${payload}` : `[${time}] ${title}`;
}

function markActionButton(button, kind) {
  if (!button) {
    return;
  }
  button.classList.remove('action-running', 'action-ok', 'action-error');
  if (kind) {
    button.classList.add(`action-${kind}`);
  }
}

function responseSucceeded(payload) {
  const result = payload?.result ?? payload;
  const json = result?.json ?? payload?.json ?? null;
  const summary = json?.summary ?? null;
  const exitCode = result?.exitCode;
  return payload?.ok !== false
    && result?.ok !== false
    && json?.ok !== false
    && summary?.ok !== false
    && (exitCode === null || exitCode === undefined || exitCode === 0);
}

function setApiState(kind, text) {
  const pill = $('#apiState');
  const dot = pill.querySelector('.dot');
  dot.className = `dot ${kind === 'ok' ? '' : 'muted'}`;
  pill.lastChild.textContent = text;
}

function setSettingsStatus(kind, text) {
  const status = $('#settingsStatus');
  status.className = `settings-status ${kind}`;
  status.textContent = text;
}

function short(value, fallback = '-') {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  return String(value);
}

function latestJobFromStatus(status) {
  const json = status?.status?.json;
  return json?.latestJobSummary ?? json?.latestJob ?? null;
}

function jobIdFromText(text) {
  const jsonMatch = text.match(/"jobId"\s*:\s*"([A-Za-z0-9._-]+)"/u);
  if (jsonMatch) {
    return jsonMatch[1];
  }
  const eventMatch = text.match(/\bjobId=([A-Za-z0-9._-]+)/u);
  return eventMatch ? eventMatch[1] : null;
}

function jobIdFromPayload(payload) {
  return payload?.result?.json?.jobId
    ?? payload?.result?.json?.summary?.jobId
    ?? payload?.result?.jobId
    ?? payload?.jobId
    ?? null;
}

function apiRunIdFromPayload(payload) {
  return payload?.result?.apiRunId ?? payload?.apiRunId ?? null;
}

function updateJobInputs(jobId, commandId = '') {
  if (!jobId) {
    return;
  }
  $('#taskJobId').value = jobId;
  if (commandId.includes('Base') || jobId.startsWith('base-')) {
    $('#baseJobId').value = jobId;
  }
  if (commandId.includes('Patch') || jobId.startsWith('patch-')) {
    $('#patchJobId').value = jobId;
  }
  if (jobId.startsWith('wechat-')) {
    $('#wechatJobId').value = jobId;
  }
}

function compactJobStatus(payload) {
  const json = payload?.result?.json ?? payload?.json ?? payload;
  const summary = json?.summary ?? null;
  return {
    jobId: json?.jobId ?? summary?.jobId ?? null,
    status: summary?.status ?? json?.status ?? null,
    ok: summary?.ok ?? json?.ok ?? null,
    releaseType: summary?.releaseType ?? null,
    branch: summary?.branch ?? null,
    activeProcess: summary?.activeProcess ?? null,
  };
}

function terminalJobStatus(status) {
  return typeof status === 'string' && TERMINAL_JOB_STATUSES.has(status);
}

function clearPolling() {
  if (state.poll.handle !== null) {
    window.clearInterval(state.poll.handle);
  }
  state.poll = {
    handle: null,
    apiRunId: null,
    jobId: null,
    signature: '',
    statusElement: null,
    actionButton: null,
  };
}

function logPolling(title, value) {
  const signature = JSON.stringify(value);
  if (signature === state.poll.signature) {
    return;
  }
  state.poll.signature = signature;
  log(title, value);
}

function renderStatus(data) {
  state.lastStatus = data;
  const statusJson = data?.status?.json;
  const lockJson = data?.lockStatus?.json;
  const versionJson = data?.versionStatus?.json;
  const activeBase = statusJson?.releaseState?.activeBase ?? statusJson?.activeBase ?? null;
  const latestJob = latestJobFromStatus(data);

  $('#metricApi').textContent = '已连接';
  $('#metricApiDetail').textContent = effectiveApiBaseUrl();
  $('#metricLock').textContent = lockJson?.status ?? (lockJson?.ok ? '空闲' : '未知');
  $('#metricLockDetail').textContent = lockJson?.jobId ?? lockJson?.releaseLock?.jobId ?? '-';
  $('#metricBase').textContent = activeBase?.releaseId ?? activeBase?.jobId ?? '未激活';
  $('#metricBaseDetail').textContent = activeBase?.appVersion ? `AppVersion ${activeBase.appVersion}` : '-';
  $('#metricVersion').textContent = versionJson?.effective?.appVersion ?? versionJson?.versionRequest?.appVersion ?? '未设置';
  $('#metricVersionDetail').textContent = versionJson?.effective?.dataCdn ?? versionJson?.notes?.[0] ?? '-';

  const task = $('#currentTask');
  if (latestJob) {
    task.innerHTML = `
      <strong>${short(latestJob.jobId ?? latestJob.summaryPath, '最近任务')}</strong>
      <span>${short(latestJob.status)} · ${short(latestJob.releaseType ?? latestJob.command)}</span>
    `;
  } else {
    task.innerHTML = '<strong>暂无任务</strong><span>没有读取到最近任务。</span>';
  }
}

function setView(view) {
  state.view = view;
  $all('.view').forEach((item) => item.classList.toggle('active', item.id === `${view}View`));
  $all('[data-view]').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  const [title, subtitle] = viewMeta[view];
  $('#viewTitle').textContent = title;
  $('#viewSubtitle').textContent = subtitle;
}

function setTab(scope, tab) {
  state.tab[scope] = tab;
  const root = scope === 'android' ? $('#androidView') : $('#wechatView');
  root.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item.dataset.tab === tab));
  root.querySelectorAll('.tab-panel').forEach((item) => item.classList.remove('active'));
  $(`#${tab}Tab`).classList.add('active');
}

function settingsToForm() {
  $('#apiBaseUrl').value = state.config.apiBaseUrl;
  $('#apiToken').value = state.config.apiToken;
}

function formToSettings() {
  return {
    apiBaseUrl: $('#apiBaseUrl').value.trim(),
    apiToken: $('#apiToken').value.trim(),
  };
}

function persistSettings(closeDialog = true) {
  saveConfig(formToSettings());
  const apiBaseUrl = effectiveApiBaseUrl();
  setApiState(apiBaseUrl ? 'ok' : 'muted', apiBaseUrl ? '已配置' : '未连接');
  setSettingsStatus(apiBaseUrl && state.config.apiToken ? 'ok' : '', apiBaseUrl && state.config.apiToken ? '配置已保存。' : '配置未完整。');
  log('配置已保存', {
    apiBaseUrl,
    configuredApiBaseUrl: state.config.apiBaseUrl,
    hasToken: Boolean(state.config.apiToken),
  });
  if (closeDialog) {
    $('#settingsDialog').close();
  }
}

function openSettings() {
  settingsToForm();
  setSettingsStatus('', '等待测试。');
  $('#settingsDialog').showModal();
}

async function testConnection() {
  persistSettings(false);
  setSettingsStatus('', '测试中...');
  const health = await apiGet('/api/health', false);
  const commands = await apiGet('/api/commands');
  const status = await apiGet('/api/status');
  setApiState('ok', '已连接');
  renderStatus(status);
  setSettingsStatus('ok', `连接正常。命令 ${commands.commands.length} 个，发布锁 ${status.lockStatus?.json?.releaseLock?.active ? '占用' : '空闲'}。`);
  log('测试连接', {
    health,
    commandCount: commands.commands.length,
    status,
  });
}

async function refreshStatus(writeLog = true) {
  const health = await apiGet('/api/health', false);
  setApiState('ok', '已连接');
  const status = await apiGet('/api/status');
  renderStatus(status);
  if (writeLog) {
    log('刷新状态', { health, status });
  }
}

async function pollReleaseProgress(commandId) {
  let apiRun = null;
  let job = null;
  let apiRunAlive = false;

  if (state.poll.apiRunId) {
    apiRun = await apiRunStatus(state.poll.apiRunId);
    apiRunAlive = apiRun?.process?.alive === true;
    const foundJobId = jobIdFromText(`${apiRun.stdoutTail}\n${apiRun.stderrTail}`);
    if (foundJobId && !state.poll.jobId) {
      state.poll.jobId = foundJobId;
      updateJobInputs(foundJobId, commandId);
    }
  }

  if (state.poll.jobId) {
    job = await apiJobStatus(state.poll.jobId);
    const compact = compactJobStatus(job);
    updateJobInputs(compact.jobId, commandId);
  }

  const compactJob = job ? compactJobStatus(job) : null;
  const finishedOk = compactJob?.ok !== false && !FAILED_JOB_STATUSES.has(compactJob?.status);
  logPolling('发布进度', {
    commandId,
    apiRunId: state.poll.apiRunId,
    apiRunAlive,
    job: compactJob,
    stderrTail: apiRun?.stderrTail ? apiRun.stderrTail.split(/\r?\n/u).slice(-8).join('\n') : null,
  });

  const finished = (!state.poll.apiRunId || !apiRunAlive) && (!compactJob || terminalJobStatus(compactJob.status));
  await refreshStatus(false);

  if (finished) {
    const kind = finishedOk ? 'ok' : 'error';
    markActionButton(state.poll.actionButton, kind);
    setActionStatus(state.poll.statusElement, kind, '发布追踪结束', compactJob ?? { apiRunId: apiRun?.metadata?.apiRunId ?? state.poll.apiRunId });
    clearPolling();
    setApiState('ok', '已连接');
    log('发布追踪结束', compactJob ?? { apiRunId: apiRun?.metadata?.apiRunId ?? state.poll.apiRunId });
  } else {
    setApiState('ok', '执行中');
    setActionStatus(state.poll.statusElement, 'running', '发布执行中', {
      commandId,
      apiRunId: state.poll.apiRunId,
      apiRunAlive,
      job: compactJob,
    });
  }
}

function startReleasePolling(commandId, { apiRunId, jobId }, feedbackSource = null) {
  clearPolling();
  state.poll.apiRunId = apiRunId;
  state.poll.jobId = jobId;
  state.poll.statusElement = actionStatusFromSource(feedbackSource);
  state.poll.actionButton = feedbackSource?.closest?.('button') ?? null;
  updateJobInputs(jobId, commandId);
  setApiState('ok', '执行中');
  log('开始追踪发布', { commandId, apiRunId, jobId });

  const runOnce = () => {
    pollReleaseProgress(commandId).catch((error) => {
      setApiState('error', '追踪异常');
      markActionButton(state.poll.actionButton, 'error');
      setActionStatus(state.poll.statusElement, 'error', '发布追踪失败', stackOf(error));
      log('发布追踪失败', stackOf(error));
      clearPolling();
    });
  };
  runOnce();
  state.poll.handle = window.setInterval(runOnce, POLL_INTERVAL_MS);
}

function valueOf(selector) {
  return $(selector).value.trim();
}

function jobIdForAction(action) {
  if (action.includes('Base')) {
    return valueOf('#baseJobId');
  }
  if (action.includes('Patch')) {
    return valueOf('#patchJobId');
  }
  if (action.startsWith('wechat')) {
    return valueOf('#wechatJobId');
  }
  return valueOf('#taskJobId');
}

function paramsFor(action) {
  if (action === 'preflightBase' || action === 'runBaseBuild') {
    return { branch: valueOf('#baseBranch') };
  }
  if (action === 'preflightPatch' || action === 'runPatchBuild' || action === 'checkPatch') {
    return { branch: valueOf('#patchBranch') };
  }
  if (action === 'setVersion') {
    return { appVersion: valueOf('#appVersion') };
  }
  if (action === 'wechatResourcesPreflight' || action === 'wechatUploadResources' || action === 'wechatRecoverResources') {
    const jobId = valueOf('#wechatJobId');
    return jobId ? { jobId } : {};
  }
  if (action === 'jobStatusByInput') {
    const jobId = valueOf('#taskJobId');
    return jobId ? { jobId } : {};
  }
  if (['uploadBaseApk', 'activateBase', 'publishPatch', 'recordPatch', 'recoverPatch', 'cancelJob'].includes(action)) {
    return { jobId: jobIdForAction(action) };
  }
  return {};
}

function commandIdFor(action) {
  return action === 'jobStatusByInput' ? 'jobStatus' : action;
}

async function handleAction(action, feedbackSource = null) {
  if (action === 'lockStatus') {
    const result = await apiRun('lockStatus');
    const kind = responseSucceeded(result) ? 'ok' : 'error';
    markActionButton(feedbackSource, kind);
    setActionStatus(feedbackSource, kind, '查看发布锁完成', result);
    log('发布锁', result);
    return;
  }
  if (action === 'jobStatus') {
    const result = await apiRun('jobStatus');
    const kind = responseSucceeded(result) ? 'ok' : 'error';
    markActionButton(feedbackSource, kind);
    setActionStatus(feedbackSource, kind, '查询最近任务完成', result);
    log('最近任务', result);
    return;
  }

  const execute = dangerousActions.has(action);
  if (execute) {
    const label = actionLabels[action] ?? action;
    const confirmed = window.confirm(`确认执行：${label}`);
    if (!confirmed) {
      markActionButton(feedbackSource, null);
      setActionStatus(feedbackSource, 'muted', '已取消', label);
      log('已取消', label);
      return;
    }
  }

  const commandId = commandIdFor(action);
  const result = await apiRun(commandId, paramsFor(action), execute);
  const label = actionLabels[action] ?? commandId;
  log(label, result);
  const jobId = jobIdFromPayload(result);
  const apiRunId = apiRunIdFromPayload(result);
  updateJobInputs(jobId, commandId);
  if (execute && (apiRunId || jobId)) {
    markActionButton(feedbackSource, 'running');
    setActionStatus(feedbackSource, 'running', `${label}已提交，正在追踪`, result);
    startReleasePolling(commandId, { apiRunId, jobId }, feedbackSource);
  } else {
    const kind = responseSucceeded(result) ? 'ok' : 'error';
    markActionButton(feedbackSource, kind);
    setActionStatus(feedbackSource, kind, `${label}完成`, result);
  }
}

async function runUiTask(title, task, onError = null, feedbackSource = null) {
  $all('button').forEach((button) => button.disabled = true);
  markActionButton(feedbackSource, 'running');
  setActionStatus(feedbackSource, 'running', `${title}执行中...`);
  try {
    await task();
  } catch (error) {
    if (onError !== null) {
      onError(error);
    }
    setApiState('error', '异常');
    markActionButton(feedbackSource, 'error');
    setActionStatus(feedbackSource, 'error', `${title}失败`, stackOf(error));
    log(`${title} 失败`, stackOf(error));
  } finally {
    $all('button').forEach((button) => button.disabled = false);
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }
}

function bindEvents() {
  $all('[data-view]').forEach((button) => {
    button.addEventListener('click', () => setView(button.dataset.view));
  });
  $all('#androidView .tab').forEach((button) => {
    button.addEventListener('click', () => setTab('android', button.dataset.tab));
  });
  $all('#wechatView .tab').forEach((button) => {
    button.addEventListener('click', () => setTab('wechat', button.dataset.tab));
  });
  $all('[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.action;
      runUiTask(actionLabels[action] ?? commandIdFor(action), () => handleAction(action, button), null, button);
    });
  });
  $('#refreshButton').addEventListener('click', () => runUiTask('刷新状态', refreshStatus));
  $('#settingsButton').addEventListener('click', openSettings);
  $('#openSettings').addEventListener('click', openSettings);
  $('#clearLog').addEventListener('click', () => {
    $('#logOutput').textContent = '等待操作。';
  });
  $('#settingsForm').addEventListener('submit', (event) => {
    event.preventDefault();
    persistSettings();
  });
  $('#saveSettings').addEventListener('click', () => {
    persistSettings();
  });
  $('#testConnection').addEventListener('click', () => {
    runUiTask('测试连接', testConnection, (error) => setSettingsStatus('error', stackOf(error)));
  });
}

function boot() {
  bindEvents();
  settingsToForm();
  setView('overview');
  setTab('android', state.tab.android);
  setTab('wechat', state.tab.wechat);
  setApiState(effectiveApiBaseUrl() ? 'ok' : 'muted', effectiveApiBaseUrl() ? '已配置' : '未连接');
  if (window.lucide) {
    window.lucide.createIcons();
  } else {
    window.addEventListener('load', () => window.lucide?.createIcons());
  }
}

window.addEventListener('error', (event) => {
  log('页面错误', event.error?.stack ?? event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  log('未处理异常', stackOf(event.reason));
});

boot();

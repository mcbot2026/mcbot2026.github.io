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
  delete status.dataset.copyText;
  delete status.dataset.displayText;
  status.removeAttribute('title');
}

function setActionSummary(source, title, summaryText) {
  const status = actionStatusFromSource(source);
  if (!status) {
    return;
  }
  const time = new Date().toLocaleTimeString();
  const displayText = `[${time}] ${title}\n${summaryText}\n\n点击这里复制总结，可粘贴到企业微信。`;
  status.className = 'action-status ok copyable';
  status.textContent = displayText;
  status.dataset.copyText = summaryText;
  status.dataset.displayText = displayText;
  status.title = '点击复制总结';
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

function valueOrMissing(value) {
  return short(value, '缺失');
}

function shortSha(value) {
  return typeof value === 'string' && value.length > 8 ? value.slice(0, 8) : valueOrMissing(value);
}

function formatBytes(value) {
  if (!Number.isFinite(value)) {
    return '缺失';
  }
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function line(label, value) {
  return `- ${label}：${valueOrMissing(value)}`;
}

function jsonFromPayload(payload) {
  return payload?.result?.json ?? payload?.json ?? payload;
}

function summaryFromPayload(payload) {
  const json = jsonFromPayload(payload);
  return json?.summary ?? json;
}

function releaseSummaryTitle(summary) {
  if (summary?.releaseType === 'base') {
    if (summary.status === 'active-base') {
      return 'Base 包发布完成';
    }
    if (summary.status === 'uploaded') {
      return 'Base APK 上传完成';
    }
    if (summary.status === 'built') {
      return 'Base 构建完成';
    }
  }
  if (summary?.releaseType === 'patch') {
    if (summary.status === 'patch-recorded') {
      return '热更发布完成';
    }
    if (summary.status === 'patch-verified') {
      return '热更资源发布完成';
    }
    if (summary.status === 'built') {
      return 'Patch 构建完成';
    }
    if (summary.status === 'checked') {
      return '热更兼容性检测完成';
    }
  }
  if (summary?.releaseType === 'wechat-development' && summary.status === 'exported') {
    return '微信开发包导出完成';
  }
  if (summary?.releaseType === 'wechat-resource-upload' && summary.status === 'resources-verified') {
    return '微信开发包资源上传完成';
  }
  if (summary?.releaseType === 'wechat-dev-upload' && summary.status === 'wechat-dev-uploaded') {
    return '微信开发版本上传完成';
  }
  if (summary?.releaseType === 'wechat-preview' && summary.status === 'wechat-preview-ready') {
    return '微信预览二维码已生成';
  }
  return null;
}

function commitSubject(commit) {
  return commit?.pullRequestLabel
    ? `${commit.subject} (${commit.pullRequestLabel})`
    : commit?.subject;
}

function appendChangeSummary(lines, summary) {
  const changes = summary?.versionDiff?.summary;
  if (!Array.isArray(changes) || changes.length === 0) {
    return;
  }
  lines.push('', '本次包含改动：');
  for (const item of changes) {
    const text = String(item).trim();
    if (text.length > 0) {
      lines.push(text.startsWith('- ') ? text : `- ${text}`);
    }
  }
}

function releaseSummaryText(payload) {
  const json = jsonFromPayload(payload);
  const summary = summaryFromPayload(payload);
  const title = releaseSummaryTitle(summary);
  if (!title || summary?.ok !== true) {
    return null;
  }

  const manifest = summary.releaseManifest ?? {};
  const release = summary.release ?? {};
  const activeBase = summary.activeBase ?? summary.progress?.activeBase ?? {};
  const summaryPath = summary.summaryPath ?? json?.files?.summary?.path;
  const projectCommit = summary.projectCommit ?? activeBase.projectCommit ?? release.projectCommit ?? summary.versionDiff?.toCommit;
  const branch = summary.branch ?? activeBase.projectBranch ?? release.projectBranch;
  const projectSha = summary.projectSha ?? activeBase.projectSha ?? release.projectSha;
  const lines = [`## ${title}`];

  if (summary.releaseType === 'base') {
    lines.push(
      line('AppVersion', activeBase.appVersion ?? release.appVersion),
      line('发布分支', `${valueOrMissing(branch)}@${shortSha(projectSha)}`),
      line('提交内容', commitSubject(projectCommit)),
      line('任务ID', summary.jobId),
      line('ActiveBase', activeBase.baseReleaseId ?? release.releaseId),
      line('下载 APK', summary.apkDownloadUrl ?? activeBase.apkDownloadUrl),
      line('大小', formatBytes(summary.apkBytes)),
      line('SHA256', summary.apkSha256),
      line('用时', summary.buildDuration?.text),
    );
    appendChangeSummary(lines, summary);
  } else if (summary.releaseType === 'patch') {
    lines.push(
      line('发布分支', `${valueOrMissing(branch)}@${shortSha(projectSha)}`),
      line('提交内容', commitSubject(projectCommit)),
      line('任务ID', summary.jobId),
      line('ActiveBase', activeBase.baseReleaseId ?? release.baseReleaseId),
      line('PatchLevel', release.patchLevel),
      line('PatchCode', release.patchCode ?? activeBase.patchCode),
      line('远端目录', release.remoteRoot ?? activeBase.remoteRoot),
      line('用时', summary.buildDuration?.text),
    );
  } else if (summary.releaseType === 'wechat-development') {
    lines.push(
      line('导出分支', `${valueOrMissing(branch)}@${shortSha(projectSha)}`),
      line('任务ID', summary.jobId),
      line('AppVersion', manifest.appVersion),
      line('PatchCode', manifest.patchCode),
      line('Data CDN', manifest.dataCdn),
      line('主包大小', formatBytes(summary.artifactSummary?.mainPackageBytes)),
      line('小游戏工程', summary.paths?.minigamePath),
      line('用时', summary.buildDuration?.text),
    );
  } else if (summary.releaseType === 'wechat-resource-upload') {
    lines.push(
      line('来源导出任务', summary.sourceExportJobId),
      line('任务ID', summary.jobId),
      line('AppVersion', manifest.appVersion),
      line('PatchCode', manifest.patchCode),
      line('Data CDN', manifest.dataCdn),
      line('远端目录', summary.remoteRoot),
      line('公网校验', Array.isArray(summary.wechatResourceVerifyEvidence?.files) ? `${summary.wechatResourceVerifyEvidence.files.length} 个文件` : null),
      line('用时', summary.buildDuration?.text),
    );
  } else {
    lines.push(
      line('任务ID', summary.jobId),
      line('来源资源任务', summary.sourceResourceJobId),
      line('来源导出任务', summary.sourceExportJobId),
      line('AppVersion', manifest.appVersion),
      line('PatchCode', manifest.patchCode),
      line('Data CDN', manifest.dataCdn),
      line('二维码', summary.qrcodePath),
      line('用时', summary.buildDuration?.text),
    );
  }

  lines.push('', line('详细记录', summaryPath));
  return lines.join('\n');
}

function setActionResult(source, kind, title, value) {
  const summaryText = kind === 'ok' ? releaseSummaryText(value) : null;
  if (summaryText) {
    setActionSummary(source, title, summaryText);
    return;
  }
  setActionStatus(source, kind, title, value);
}

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.append(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) {
    throw new Error('复制失败：document.execCommand(\"copy\") returned false.');
  }
  return Promise.resolve();
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
    const resultPayload = job ?? compactJob ?? { apiRunId: apiRun?.metadata?.apiRunId ?? state.poll.apiRunId };
    markActionButton(state.poll.actionButton, kind);
    setActionResult(state.poll.statusElement, kind, '发布追踪结束', resultPayload);
    clearPolling();
    setApiState('ok', '已连接');
    log('发布追踪结束', resultPayload);
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
    setActionResult(feedbackSource, kind, '查询最近任务完成', result);
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
    setActionResult(feedbackSource, kind, `${label}完成`, result);
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
  $all('.action-status').forEach((status) => {
    status.addEventListener('click', () => {
      const text = status.dataset.copyText;
      if (!text) {
        return;
      }
      copyText(text).then(() => {
        status.textContent = `${status.dataset.displayText}\n\n已复制，可粘贴到企业微信。`;
        log('复制发布总结', text);
      });
    });
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

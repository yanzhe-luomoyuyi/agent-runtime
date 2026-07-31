const goalEl = document.getElementById('goal');
const workspaceEl = document.getElementById('workspace');
const runBtn = document.getElementById('runBtn');
const resetBtn = document.getElementById('resetBtn');
const useSandboxBtn = document.getElementById('useSandboxBtn');
const runHint = document.getElementById('runHint');
const workspaceHint = document.getElementById('workspaceHint');
const eventLog = document.getElementById('eventLog');
const keyPill = document.getElementById('keyPill');
const modelPill = document.getElementById('modelPill');
const budgetPill = document.getElementById('budgetPill');
const viewDiffs = document.getElementById('view-diffs');
const viewErrors = document.getElementById('view-errors');
const viewContext = document.getElementById('view-context');
const traceContent = document.getElementById('traceContent');
const compareContent = document.getElementById('compareContent');
const viewAnswer = document.getElementById('view-answer');
/** Live error list for the Errors tab (also rebuilt from traces on done/load). */
let runErrors = [];
/** Live token buffers for SSE model_token / thinking_token (final markdown on `done`). */
let streamAnswerBuf = '';
let streamThinkingBuf = '';
let streamAnswerActive = false;
const sessionSelect = document.getElementById('sessionSelect');
const sessionHint = document.getElementById('sessionHint');
const renameSessionBtn = document.getElementById('renameSessionBtn');
const loadSessionTraceBtn = document.getElementById('loadSessionTraceBtn');
const compareBaseline = document.getElementById('compareBaseline');
const compareCandidate = document.getElementById('compareCandidate');
const compareSessionsBtn = document.getElementById('compareSessionsBtn');
const renameDialog = document.getElementById('renameDialog');
const renameTitle = document.getElementById('renameTitle');
const hitlWritesEl = document.getElementById('hitlWrites');
const longTermMemoryEl = document.getElementById('longTermMemory');
const loopModeEl = document.getElementById('loopMode');
const loopModeHint = document.getElementById('loopModeHint');
const planTab = document.getElementById('planTab');
const feedbackTab = document.getElementById('feedbackTab');
const viewPlan = document.getElementById('view-plan');
const viewFeedback = document.getElementById('view-feedback');
const crashTurnEl = document.getElementById('crashTurn');
const controlBar = document.getElementById('controlBar');
const controlLabel = document.getElementById('controlLabel');
const pauseBtn = document.getElementById('pauseBtn');
const continueBtn = document.getElementById('continueBtn');
const steerBtn = document.getElementById('steerBtn');
const abortBtn = document.getElementById('abortBtn');
const resumeDurableBtn = document.getElementById('resumeDurableBtn');
const pauseBanner = document.getElementById('pauseBanner');
const crashBanner = document.getElementById('crashBanner');
const abortBanner = document.getElementById('abortBanner');
const crashResumeBtn = document.getElementById('crashResumeBtn');
const approvalPanel = document.getElementById('approvalPanel');
const approvalBody = document.getElementById('approvalBody');
const approveYesBtn = document.getElementById('approveYesBtn');
const approveNoBtn = document.getElementById('approveNoBtn');
const runsList = document.getElementById('runsList');
const sessionsList = document.getElementById('sessionsList');
const steerDialog = document.getElementById('steerDialog');
const steerInject = document.getElementById('steerInject');
const steerGoal = document.getElementById('steerGoal');

let defaultWorkspace = '';
let defaultGoal = '';
let currentRunId = null;
let currentSessionId = null;
/** Crashed run left in status=running — durable resume target. */
let resumableRunId = null;
let pendingApproval = null;
let driving = false;
let hasApiKey = false;
/** Cached session manifests for rename / compare dropdowns. */
let cachedSessions = [];
let renameTargetId = null;

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    if (tab.hidden) return;
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`view-${tab.dataset.tab}`).classList.add('active');
  });
});

function syncLoopModeUi() {
  const mode = loopModeEl.value;
  planTab.hidden = mode !== 'planner';
  feedbackTab.hidden = mode !== 'reflection';
  loopModeHint.textContent =
    mode === 'planner'
      ? 'Planner: make a plan, then execute step-by-step (batch; no live token stream).'
      : mode === 'reflection'
        ? 'Reflection: attempt → critique → revise (batch; no live token stream).'
        : 'Default single loop with live token streaming.';
  // If a hidden tab was active, fall back to Diffs.
  if ((mode !== 'planner' && planTab.classList.contains('active')) ||
      (mode !== 'reflection' && feedbackTab.classList.contains('active'))) {
    document.querySelector('.tab[data-tab="diffs"]').click();
  }
}

loopModeEl.addEventListener('change', syncLoopModeUi);

function isSandboxPath(path) {
  return Boolean(defaultWorkspace) && path === defaultWorkspace;
}

function syncResetVisibility() {
  const onSandbox = isSandboxPath(workspaceEl.value.trim());
  resetBtn.hidden = !onSandbox;
  workspaceHint.textContent = onSandbox
    ? 'Using the built-in buggy fixture (safe to reset).'
    : 'Using a custom repo — agent can read/write under this path only.';
}

function setDriving(on) {
  driving = on;
  runBtn.disabled = !hasApiKey || on;
  controlBar.hidden = !on && !currentRunId && !resumableRunId;
  pauseBtn.disabled = !on;
  continueBtn.disabled = !on;
  steerBtn.disabled = !on;
  abortBtn.disabled = !on;
  if (!on) {
    pauseBanner.hidden = true;
    approvalPanel.hidden = true;
    pendingApproval = null;
  }
  syncResumeUi();
}

function syncControlLabel() {
  const id = resumableRunId || currentRunId;
  controlLabel.textContent = id ? `Run ${id}` : 'Run controls';
}

/** Show durable-resume controls when a crashed (still-running) runId is known. */
function syncResumeUi() {
  const show = Boolean(resumableRunId) && !driving;
  resumeDurableBtn.hidden = !show;
  crashBanner.hidden = !show;
  if (show) {
    controlBar.hidden = false;
    currentRunId = resumableRunId;
  }
  syncControlLabel();
}

function clearTerminalBanners() {
  crashBanner.hidden = true;
  abortBanner.hidden = true;
  pauseBanner.hidden = true;
}

async function refreshStatus() {
  const res = await fetch('/api/status');
  const data = await res.json();
  defaultWorkspace = data.defaultWorkspace;
  defaultGoal = data.defaultGoal || '';
  hasApiKey = Boolean(data.hasApiKey);
  if (!workspaceEl.value.trim()) workspaceEl.value = data.workspace || defaultWorkspace;
  keyPill.textContent = data.hasApiKey ? 'API key ready' : 'API key missing';
  keyPill.className = `pill ${data.hasApiKey ? 'ok' : 'bad'}`;
  modelPill.textContent = data.modelId ? `model ${data.modelId}` : 'model —';
  budgetPill.textContent =
    data.maxPromptTokens != null
      ? `max prompt ${Number(data.maxPromptTokens).toLocaleString()} tok`
      : 'max prompt —';
  if (!goalEl.value.trim() && defaultGoal && isSandboxPath(workspaceEl.value.trim())) {
    goalEl.value = defaultGoal;
  }
  hitlWritesEl.checked = data.autoApproveWrites === false;
  longTermMemoryEl.checked = data.longTermMemory === true;
  if (data.loopMode === 'agent' || data.loopMode === 'planner' || data.loopMode === 'reflection') {
    loopModeEl.value = data.loopMode;
  }
  syncLoopModeUi();
  runBtn.disabled = !data.hasApiKey || data.busy || driving;
  runHint.textContent = data.busy || driving
    ? 'Run in progress…'
    : data.hasApiKey
      ? ''
      : 'Add DEEPSEEK_API_KEY to coding-agent/.env then restart UI';
  syncResetVisibility();
}

async function refreshSessions() {
  const res = await fetch('/api/sessions');
  if (!res.ok) return;
  const data = await res.json();
  const sessions = data.sessions || [];
  cachedSessions = sessions;
  const selected = sessionSelect.value;
  sessionSelect.innerHTML = '<option value="">New session</option>';
  for (const s of sessions) {
    const opt = document.createElement('option');
    opt.value = s.sessionId;
    opt.textContent = `${s.title || s.sessionId} (${s.runIds?.length || 0})`;
    sessionSelect.appendChild(opt);
  }
  if (selected && [...sessionSelect.options].some((o) => o.value === selected)) {
    sessionSelect.value = selected;
  } else if (currentSessionId) {
    sessionSelect.value = currentSessionId;
  }
  syncSessionActions();
  fillCompareSelects(sessions);

  sessionsList.innerHTML = sessions.length
    ? sessions
        .slice(0, 12)
        .map(
          (s) =>
            `<li>
              <button type="button" class="linkish" data-session="${escapeHtml(s.sessionId)}" data-action="select" title="Load this session's answer &amp; traces (also sets continue target)">${escapeHtml(s.title || s.sessionId)}</button>
              <span class="meta">${s.runIds?.length || 0} runs</span>
              <span class="list-actions">
                <button type="button" class="linkish compact" data-session="${escapeHtml(s.sessionId)}" data-action="traces" title="Load session traces">traces</button>
                <button type="button" class="linkish compact" data-session="${escapeHtml(s.sessionId)}" data-action="rename" data-title="${escapeHtml(s.title || '')}" title="Rename session">rename</button>
              </span>
            </li>`,
        )
        .join('')
    : '<li class="empty-li">No sessions yet</li>';
  sessionsList.querySelectorAll('[data-session]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.session;
      const action = btn.dataset.action || 'select';
      if (action === 'rename') {
        openRenameDialog(id, btn.dataset.title || '');
        return;
      }
      if (action === 'traces') {
        selectSession(id, { focusTab: 'trace' }).catch((e) => logLine(String(e), 'err'));
        return;
      }
      selectSession(id).catch((e) => logLine(String(e), 'err'));
    });
  });
}

/** Bind continue target and hydrate Answer / Trace from persisted session runs. */
async function selectSession(sessionId, { focusTab = 'auto' } = {}) {
  sessionSelect.value = sessionId || '';
  currentSessionId = sessionId || null;
  syncSessionActions();
  if (!sessionId) {
    sessionHint.textContent = 'Each run is bound to a session for multi-turn continue.';
    clearResultViews();
    return;
  }
  const s = cachedSessions.find((x) => x.sessionId === sessionId);
  sessionHint.textContent = `Continuing session ${s?.title || sessionId}`;
  await loadSessionTraces(sessionId, { focusTab });
}

function clearResultViews() {
  streamAnswerBuf = '';
  streamThinkingBuf = '';
  streamAnswerActive = false;
  runErrors = [];
  viewAnswer.innerHTML = '<p class="empty">The agent’s final answer lands here.</p>';
  viewDiffs.innerHTML = '<p class="empty">File diffs appear when the agent edits the workspace.</p>';
  viewErrors.innerHTML = '<p class="empty">Tool, model, policy, and run errors appear here.</p>';
  viewContext.innerHTML =
    '<p class="empty">Assemble / compact before·after transcripts appear after a run (or when you load a harness trace).</p>';
  traceContent.innerHTML =
    '<p class="empty">Runtime + harness metrics appear after a run. Load a session via Traces, or open a run from Recent runs.</p>';
  if (compareContent) {
    compareContent.innerHTML = '<p class="empty">Pick two sessions and click Compare.</p>';
  }
}

function ensureStreamPanels() {
  if (streamAnswerActive && document.getElementById('streamAnswer')) return;
  streamAnswerActive = true;
  if (!streamAnswerBuf) streamAnswerBuf = '';
  if (!streamThinkingBuf) streamThinkingBuf = '';
  viewAnswer.innerHTML = `
    <details class="thinking-block" id="thinkingBlock" open hidden>
      <summary>Thinking</summary>
      <pre class="stream-thinking" id="streamThinking"></pre>
    </details>
    <pre class="stream-answer" id="streamAnswer"></pre>
  `;
  const tab = document.querySelector('.tab[data-tab="answer"]');
  if (tab) tab.click();
  syncThinkingVisibility();
}

function syncThinkingVisibility() {
  const block = document.getElementById('thinkingBlock');
  if (!block) return;
  block.hidden = !streamThinkingBuf;
}

function appendThinkingToken(token) {
  ensureStreamPanels();
  streamThinkingBuf += token;
  const el = document.getElementById('streamThinking');
  if (el) el.textContent = streamThinkingBuf;
  syncThinkingVisibility();
}

function appendAnswerToken(token) {
  ensureStreamPanels();
  streamAnswerBuf += token;
  const el = document.getElementById('streamAnswer');
  if (el) el.textContent = streamAnswerBuf;
}

function renderAnswerPanel(answer, thinking) {
  const parts = [];
  if (thinking && String(thinking).trim()) {
    parts.push(`<details class="thinking-block" open>
      <summary>Thinking</summary>
      <pre class="stream-thinking">${escapeHtml(thinking)}</pre>
    </details>`);
  }
  if (answer) {
    parts.push(renderMarkdownLite(answer));
  } else {
    parts.push('<p class="empty">No final answer.</p>');
  }
  viewAnswer.innerHTML = parts.join('');
}

function syncSessionActions() {
  const has = Boolean(sessionSelect.value);
  renameSessionBtn.disabled = !has;
  loadSessionTraceBtn.disabled = !has;
}

function fillCompareSelects(sessions) {
  const fill = (el, placeholder) => {
    const prev = el.value;
    el.innerHTML = `<option value="">${placeholder}</option>`;
    for (const s of sessions) {
      const opt = document.createElement('option');
      opt.value = s.sessionId;
      opt.textContent = `${s.title || s.sessionId} (${s.runIds?.length || 0})`;
      el.appendChild(opt);
    }
    if (prev && [...el.options].some((o) => o.value === prev)) el.value = prev;
  };
  fill(compareBaseline, 'Baseline…');
  fill(compareCandidate, 'Candidate…');
}

function openRenameDialog(sessionId, title) {
  renameTargetId = sessionId;
  renameTitle.value = title || '';
  renameDialog.showModal();
}

async function renameSession(sessionId, title) {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    logLine(data.error || 'rename failed', 'err');
    return;
  }
  logLine(`renamed session → ${data.manifest?.title || title}`, 'ok');
  if (currentSessionId === sessionId) {
    sessionHint.textContent = `Session ${data.manifest?.title || title}`;
  }
  await refreshSessions();
}

async function loadSessionTraces(sessionId, { focusTab = 'auto' } = {}) {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/traces`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    logLine(data.error || 'load session traces failed', 'err');
    return;
  }
  renderSessionTraceBundle(data);
  hydrateSessionPanels(data, { focusTab });
  logLine(`loaded session ${sessionId} (${data.runCount || 0} runs)`);
}

/** Fill Answer / Errors / Context (and clear live-only Diffs) from a session trace bundle. */
function hydrateSessionPanels(bundle, { focusTab = 'auto' } = {}) {
  const runs = bundle.runs || [];
  const lastWithAnswer =
    [...runs].reverse().find((r) => typeof r.answer === 'string' && r.answer.trim()) ||
    runs[runs.length - 1];

  viewAnswer.innerHTML = lastWithAnswer?.answer
    ? renderMarkdownLite(lastWithAnswer.answer)
    : '<p class="empty">No final answer in this session.</p>';

  // Diffs come from the live workspace / run snapshot — not session history.
  viewDiffs.innerHTML =
    '<p class="empty">Historical sessions do not restore file diffs — diffs come from the live run snapshot.</p>';

  const lastRun = runs[runs.length - 1];
  const errors = collectErrorsFromTraces(lastRun?.runtimeTrace, lastRun?.harnessTrace, {
    runError: lastRun?.error,
    runId: lastRun?.runId,
  });
  runErrors = errors;
  renderErrors(errors);
  renderContext(lastRun?.harnessTrace);

  let tab = focusTab;
  if (tab === 'auto') {
    tab = lastWithAnswer?.answer ? 'answer' : 'trace';
  }
  document.querySelector(`.tab[data-tab="${tab}"]`)?.click();
}

async function loadRunTrace(runId) {
  const tr = await fetch(`/api/runs/${encodeURIComponent(runId)}/trace`);
  if (!tr.ok) {
    logLine(`trace failed for ${runId}`, 'err');
    return;
  }
  const payload = await tr.json();
  currentRunId = runId;
  renderTrace(payload.runtimeTrace, payload.harnessTrace, { runId });
  const errors = collectErrorsFromTraces(payload.runtimeTrace, payload.harnessTrace, { runId });
  runErrors = errors;
  renderErrors(errors);
  renderContext(payload.harnessTrace);
  document.querySelector('.tab[data-tab="trace"]').click();
  logLine(`loaded trace ${runId}`);
}

async function compareSelectedSessions() {
  const baselineSessionId = compareBaseline.value.trim();
  const candidateSessionId = compareCandidate.value.trim();
  if (!baselineSessionId || !candidateSessionId) {
    logLine('pick two sessions to compare', 'warn');
    return;
  }
  const res = await fetch('/api/sessions/compare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baselineSessionId, candidateSessionId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    logLine(data.error || 'compare failed', 'err');
    return;
  }
  renderSessionCompare(data);
  document.querySelector('.tab[data-tab="compare"]').click();
  logLine(`compared ${baselineSessionId} vs ${candidateSessionId}`);
}

async function refreshRuns() {
  const res = await fetch('/api/runs');
  if (!res.ok) return;
  const data = await res.json();
  const runs = (data.runs || []).slice().reverse().slice(0, 12);
  runsList.innerHTML = runs.length
    ? runs
        .map((r) => {
          const short = escapeHtml((r.issue || r.runId || '').slice(0, 48));
          const resumable = r.status === 'running';
          return `<li>
            <button type="button" class="linkish" data-run="${escapeHtml(r.runId)}" data-action="trace" title="Load runtime trace for this run">${short || r.runId}</button>
            <span class="meta">${escapeHtml(r.status)}</span>
            ${
              resumable
                ? `<button type="button" class="ghost compact" data-run="${escapeHtml(r.runId)}" data-action="resume" title="Durable resume this interrupted run">Resume</button>`
                : ''
            }
          </li>`;
        })
        .join('')
    : '<li class="empty-li">No runs yet</li>';
  // Drop crash-resume target only when disk says the run is no longer running.
  if (resumableRunId) {
    const found = runs.find((r) => r.runId === resumableRunId);
    if (found && found.status !== 'running') {
      resumableRunId = null;
    }
    syncResumeUi();
  }
  runsList.querySelectorAll('[data-run]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const runId = btn.dataset.run;
      if (btn.dataset.action === 'resume') {
        await resumeRun(runId);
        return;
      }
      await loadRunTrace(runId);
      await loadRunExtras(runId);
    });
  });
}

function logLine(text, cls = '') {
  const div = document.createElement('div');
  div.className = `ev ${cls}`;
  div.textContent = text;
  eventLog.prepend(div);
}

function renderInlineMd(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_]+)_(?!_)/g, '$1<em>$2</em>')
    .replace(
      /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
}

function renderMarkdownLite(md) {
  if (md == null || String(md) === '') return '<div class="markdown"></div>';
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let para = [];

  function flushPara() {
    if (!para.length) return;
    const body = renderInlineMd(escapeHtml(para.join('\n'))).replace(/\n/g, '<br>');
    out.push(`<p>${body}</p>`);
    para = [];
  }

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      flushPara();
      const lang = fence[1];
      i += 1;
      const code = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1;
      const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      out.push(`<pre class="md-pre"><code${langAttr}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushPara();
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushPara();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInlineMd(escapeHtml(heading[2]))}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      out.push('<hr>');
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushPara();
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      const body = renderInlineMd(escapeHtml(quote.join('\n'))).replace(/\n/g, '<br>');
      out.push(`<blockquote>${body}</blockquote>`);
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      flushPara();
      out.push('<ul>');
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        out.push(`<li>${renderInlineMd(escapeHtml(lines[i].replace(/^[-*+]\s+/, '')))}</li>`);
        i += 1;
      }
      out.push('</ul>');
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      flushPara();
      out.push('<ol>');
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        out.push(`<li>${renderInlineMd(escapeHtml(lines[i].replace(/^\d+\.\s+/, '')))}</li>`);
        i += 1;
      }
      out.push('</ol>');
      continue;
    }

    para.push(line);
    i += 1;
  }
  flushPara();
  return `<div class="markdown">${out.join('')}</div>`;
}

function renderDiffs(diffs) {
  if (!diffs?.length) {
    viewDiffs.innerHTML = '<p class="empty">No file changes detected.</p>';
    return;
  }
  viewDiffs.innerHTML = diffs
    .map((d) => {
      // Only changed lines + headers — skip unchanged context (` ` prefix).
      const lines = (d.unified || '')
        .split('\n')
        .filter((line) => {
          if (!line) return false;
          if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) return true;
          if (line.startsWith('+') || line.startsWith('-')) return true;
          return false;
        })
        .map((line) => {
          let cls = 'meta';
          if (line.startsWith('+') && !line.startsWith('+++')) cls = 'add';
          else if (line.startsWith('-') && !line.startsWith('---')) cls = 'del';
          return `<span class="ln ${cls}">${escapeHtml(line)}</span>`;
        })
        .join('');
      return `<div class="file-card">
        <div class="file-head"><span>${escapeHtml(d.path)}</span><span class="badge">${escapeHtml(d.status)}</span></div>
        <pre class="diff">${lines || '<span class="ln meta">(no changed lines)</span>'}</pre>
      </div>`;
    })
    .join('');
}

function renderPlan(plan) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    viewPlan.innerHTML = '<p class="empty">No plan recorded for this run.</p>';
    return;
  }
  const statuses = Array.isArray(plan.statuses) ? plan.statuses : [];
  const items = plan.steps
    .map((step, i) => {
      const s = statuses[i] || 'pending';
      const mark =
        s === 'completed' ? '✓' : s === 'failed' ? '✗' : s === 'in_progress' ? '→' : '○';
      return `<li class="plan-step ${escapeHtml(s)}"><span class="plan-mark">${mark}</span> <span class="plan-text">${escapeHtml(String(step))}</span> <span class="meta">${escapeHtml(s)}</span></li>`;
    })
    .join('');
  viewPlan.innerHTML = `<ol class="plan-list">${items}</ol>`;
}

function renderFeedback(critiques) {
  if (!Array.isArray(critiques) || critiques.length === 0) {
    viewFeedback.innerHTML = '<p class="empty">No reflection feedback for this run.</p>';
    return;
  }
  viewFeedback.innerHTML = critiques
    .map((c, i) => {
      const ok = c && c.satisfactory === true;
      const parts = [
        `<div class="feedback-card ${ok ? 'ok' : 'fail'}">`,
        `<h3>Round ${i + 1} · ${ok ? 'satisfactory' : 'needs revision'}</h3>`,
        `<p>${escapeHtml((c && c.feedback) || '(no summary)')}</p>`,
      ];
      if (c?.rootCause) {
        parts.push(`<p><strong>Root cause</strong> — ${escapeHtml(c.rootCause)}</p>`);
      }
      if (c?.correctionStrategy) {
        parts.push(`<p><strong>Correction</strong> — ${escapeHtml(c.correctionStrategy)}</p>`);
      }
      if (Array.isArray(c?.whatWorked) && c.whatWorked.length) {
        parts.push(
          `<p><strong>Keep</strong></p><ul>${c.whatWorked.map((w) => `<li>${escapeHtml(String(w))}</li>`).join('')}</ul>`,
        );
      }
      parts.push('</div>');
      return parts.join('');
    })
    .join('');
}

async function loadRunExtras(runId) {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/status`);
  if (!res.ok) return;
  const data = await res.json().catch(() => ({}));
  if (data.plan) {
    loopModeEl.value = 'planner';
    syncLoopModeUi();
    renderPlan(data.plan);
  } else {
    renderPlan(null);
  }
  if (Array.isArray(data.critiques) && data.critiques.length) {
    loopModeEl.value = 'reflection';
    syncLoopModeUi();
    renderFeedback(data.critiques);
  } else if (!data.plan) {
    renderFeedback(null);
  }
  if (data.answer) {
    renderAnswerPanel(data.answer, data.thinking || '');
  }
}

function pushError(entry) {
  runErrors.push({
    at: entry.at || new Date().toISOString(),
    source: entry.source || 'run',
    turn: entry.turn,
    message: entry.message || '',
    detail: entry.detail,
  });
  renderErrors(runErrors);
}

function collectErrorsFromTraces(runtimeTrace, harnessTrace, opts = {}) {
  const out = [];
  if (opts.runError) {
    out.push({
      at: '',
      source: 'run',
      message: String(opts.runError),
      detail: opts.runId ? `runId ${opts.runId}` : undefined,
    });
  }
  for (const turn of harnessTrace?.turns || []) {
    const m = turn.model || {};
    if (m.ok === false && m.error) {
      out.push({
        at: '',
        source: 'model',
        turn: turn.turn,
        message: m.error,
      });
    }
    for (const tc of turn.tools || []) {
      if (!tc.ok) {
        out.push({
          at: '',
          source: 'tool',
          turn: turn.turn,
          message: `${tc.tool}: ${tc.error || 'failed'}`,
          detail: tc.args != null ? JSON.stringify(tc.args).slice(0, 500) : undefined,
        });
      }
    }
  }
  for (const s of runtimeTrace?.spans || []) {
    if (!s.error) continue;
    out.push({
      at: '',
      source: 'span',
      message: `${s.kind || 'span'} ${s.name || ''}: ${s.error}`,
    });
  }
  const denials = runtimeTrace?.totals?.policyDenials;
  if (denials > 0) {
    out.push({
      at: '',
      source: 'policy',
      message: `${denials} policy denial(s) recorded in runtime totals`,
    });
  }
  return out;
}

function renderErrors(errors) {
  if (!viewErrors) return;
  if (!errors?.length) {
    viewErrors.innerHTML = '<p class="empty">No errors for this run.</p>';
    return;
  }
  viewErrors.innerHTML = `<div class="error-list">${errors
    .map((e) => {
      const turn = e.turn != null ? ` · turn ${escapeHtml(String(e.turn))}` : '';
      return `<div class="error-card">
        <div class="error-head">
          <span class="badge">${escapeHtml(e.source || 'error')}</span>
          <span class="meta">${escapeHtml(e.at || '')}${turn}</span>
        </div>
        <pre class="error-msg">${escapeHtml(e.message || '')}</pre>
        ${e.detail ? `<pre class="error-detail">${escapeHtml(e.detail)}</pre>` : ''}
      </div>`;
    })
    .join('')}</div>`;
}

function formatContextMessage(m) {
  const bits = [m.role || '?'];
  if (m.name) bits.push(m.name);
  if (m.kind) bits.push(`kind=${m.kind}`);
  if (m.toolCallId) bits.push(`toolCallId=${m.toolCallId}`);
  if (m.toolCalls?.length) {
    bits.push(`tools=${m.toolCalls.map((t) => t.name).join(',')}`);
  }
  const head = bits.join(' · ');
  const body = m.content != null ? m.content : '(no content)';
  return `<div class="ctx-msg">
    <div class="ctx-msg-head">${escapeHtml(head)}</div>
    <pre class="ctx-msg-body">${escapeHtml(body)}</pre>
  </div>`;
}

function renderMessageList(messages, label) {
  if (!messages?.length) {
    return `<div class="ctx-panel"><h4>${escapeHtml(label)}</h4><p class="empty">Empty</p></div>`;
  }
  return `<div class="ctx-panel">
    <h4>${escapeHtml(label)} <span class="meta">(${messages.length})</span></h4>
    <div class="ctx-msgs">${messages.map(formatContextMessage).join('')}</div>
  </div>`;
}

function renderContextDecision(kind, turn, decision) {
  if (!decision) return '';
  const changed =
    (kind === 'assemble' && decision.outcome === 'assembled') ||
    (kind === 'compact' && decision.outcome === 'compacted');
  const summary =
    kind === 'assemble'
      ? `${decision.outcome} · in ${decision.inputTokens} → out ${decision.outputTokens}/${decision.availableBudget}` +
        ` · kept ${decision.keptMessages} · summarized ${decision.summarizedMessages}` +
        (decision.hardCapTrimmed ? ' · hard-cap' : '') +
        ` · ${(decision.reasons || []).join(', ') || '—'}`
      : `${decision.outcome}/${decision.reason} · in ${decision.inputTokens} → out ${decision.outputTokens}` +
        ` · summarized ${decision.summarizedMessages}` +
        (decision.key ? ` · key ${decision.key}` : '');

  const panels = changed
    ? `<div class="ctx-before-after">
        ${renderMessageList(decision.beforeMessages, 'Before')}
        ${renderMessageList(decision.afterMessages, 'After')}
      </div>`
    : `<p class="fine">No transcript change (${escapeHtml(decision.outcome)}).</p>`;

  return `<div class="ctx-card">
    <div class="ctx-card-head">
      <strong>Turn ${turn}</strong>
      <span class="badge">${escapeHtml(kind)}</span>
    </div>
    <div class="ctx-card-summary">${escapeHtml(summary)}</div>
    ${panels}
  </div>`;
}

function renderContext(harnessTrace) {
  if (!viewContext) return;
  const turns = harnessTrace?.turns || [];
  const cards = [];
  let compactNoop = 0;
  let assemblePassthrough = 0;
  for (const turn of turns) {
    const compact = turn.context?.compact;
    const assemble = turn.context?.assemble;
    if (compact) {
      if (compact.outcome === 'compacted') {
        cards.push(renderContextDecision('compact', turn.turn, compact));
      } else {
        compactNoop++;
      }
    }
    if (assemble) {
      if (assemble.outcome === 'assembled') {
        cards.push(renderContextDecision('assemble', turn.turn, assemble));
      } else {
        assemblePassthrough++;
      }
    }
  }
  if (!cards.length) {
    const bits = [];
    if (assemblePassthrough) bits.push(`${assemblePassthrough} assemble passthrough`);
    if (compactNoop) bits.push(`${compactNoop} compact noop`);
    viewContext.innerHTML = bits.length
      ? `<p class="empty">No assemble / compact changes this run (${escapeHtml(bits.join(', '))}).</p>`
      : '<p class="empty">No assemble / compact decisions recorded for this run.</p>';
    return;
  }
  const footer =
    compactNoop || assemblePassthrough
      ? `<p class="fine">Also: ${assemblePassthrough} assemble passthrough · ${compactNoop} compact noop (unchanged — not expanded).</p>`
      : '';
  viewContext.innerHTML = `<div class="ctx-list">${cards.join('')}</div>${footer}`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtUsd(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `$${Number(n).toFixed(6)}`;
}

function fmtMs(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(2)}s`;
  return `${Math.round(n)}ms`;
}

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${(Number(n) * 100).toFixed(0)}%`;
}

function resolveWriteFileMs(totals) {
  return totals?.writeFileMs ?? 0;
}

function resolveDurableWrites(totals) {
  return totals?.durableWrites ?? 0;
}

function metricCard(label, value, hint = '', extraClass = '') {
  const cls = ['metric', extraClass].filter(Boolean).join(' ');
  return `<div class="${cls}">
    <div class="metric-label">${escapeHtml(label)}</div>
    <div class="metric-value">${escapeHtml(String(value))}</div>
    ${hint ? `<div class="metric-hint">${escapeHtml(hint)}</div>` : ''}
  </div>`;
}

function summarizeContextDecisions(turns) {
  const stats = {
    assembleRecorded: 0,
    assembleAssembled: 0,
    assemblePassthrough: 0,
    hardCapTrimmed: 0,
    summarizedByAssemble: 0,
    compactRecorded: 0,
    compactCompacted: 0,
    compactNoop: 0,
    summarizedByCompact: 0,
    compactReasons: {},
  };
  for (const turn of turns || []) {
    const a = turn.context?.assemble;
    if (a) {
      stats.assembleRecorded++;
      if (a.outcome === 'assembled') stats.assembleAssembled++;
      if (a.outcome === 'passthrough') stats.assemblePassthrough++;
      if (a.hardCapTrimmed) stats.hardCapTrimmed++;
      stats.summarizedByAssemble += a.summarizedMessages || 0;
    }
    const c = turn.context?.compact;
    if (c) {
      stats.compactRecorded++;
      if (c.outcome === 'compacted') stats.compactCompacted++;
      if (c.outcome === 'noop') stats.compactNoop++;
      stats.summarizedByCompact += c.summarizedMessages || 0;
      const reason = c.reason || 'unknown';
      stats.compactReasons[reason] = (stats.compactReasons[reason] || 0) + 1;
    }
  }
  return stats;
}

function formatReasonCounts(reasons) {
  const entries = Object.entries(reasons || {});
  if (!entries.length) return '';
  return entries.map(([k, n]) => `${k}×${n}`).join(', ');
}

function renderTrace(runtimeTrace, harnessTrace, opts = {}) {
  if (!runtimeTrace && !harnessTrace) {
    traceContent.innerHTML = '<p class="empty">No trace data for this run.</p>';
    return;
  }

  const t = runtimeTrace?.totals || {};
  const h = harnessTrace || {};
  const ctx = summarizeContextDecisions(h.turns);
  const writeFileMs = resolveWriteFileMs(t);
  const durableWrites = resolveDurableWrites(t);
  const parts = [];
  const runId = opts.runId || currentRunId || null;

  if (runId) {
    parts.push(`<div class="trace-section">
      <h3>Run ID</h3>
      <p class="run-id mono">${escapeHtml(runId)}</p>
    </div>`);
  }
  if (opts.heading) {
    parts.push(`<div class="trace-section"><h3>${escapeHtml(opts.heading)}</h3></div>`);
  }

  parts.push(`<div class="trace-section">
    <h3>Overview</h3>
    <div class="metrics">
      ${metricCard('Wall time', fmtMs(t.wallMs ?? h.runDurationMs))}
      ${metricCard('Model time', fmtMs(t.modelMs))}
      ${metricCard('Tool time', fmtMs(t.toolMs))}
      ${metricCard(
        'event log write',
        durableWrites ? `${fmtMs(writeFileMs)} (${durableWrites})` : fmtMs(writeFileMs),
        'Time spent flushing the durable event log to disk',
        'metric-write-file',
      )}
      ${metricCard('Cost', fmtUsd(t.costUsd ?? h.estimatedCostUsd))}
      ${metricCard('Prompt tokens', t.promptTokens ?? h.totalPromptTokens ?? 0)}
      ${metricCard('Completion tokens', t.completionTokens ?? h.totalCompletionTokens ?? 0)}
      ${metricCard('Model calls', t.modelCalls ?? h.totalTurns ?? 0)}
      ${metricCard('Tool calls', `${t.toolCalls ?? h.totalToolCalls ?? 0} (${t.failedToolCalls ?? h.toolFail ?? 0} fail)`)}
      ${metricCard(
        'Assemble',
        ctx.assembleRecorded
          ? `${ctx.assembleAssembled} assembled / ${ctx.assemblePassthrough} passthrough`
          : '—',
        ctx.assembleRecorded
          ? `Harness · ${ctx.summarizedByAssemble} msgs summarized · hard-cap trim ${ctx.hardCapTrimmed}`
          : 'Harness context decisions',
      )}
      ${metricCard(
        'Compact',
        ctx.compactRecorded
          ? `${ctx.compactCompacted} compacted / ${ctx.compactNoop} noop`
          : '—',
        ctx.compactRecorded
          ? `Harness · ${ctx.summarizedByCompact} msgs folded · ${formatReasonCounts(ctx.compactReasons) || '—'}`
          : 'Harness context decisions',
      )}
    </div>
  </div>`);

  parts.push(`<div class="trace-section">
    <h3>Cache &amp; replay</h3>
    <div class="metrics">
      ${metricCard(
        'Provider cache hits',
        `${t.cachedPromptTokens ?? h.totalCachedPromptTokens ?? 0} tok`,
        'Subset of prompt tokens billed at cache-hit rate (DeepSeek prompt_cache_hit_tokens). Totals above still include these.',
      )}
      ${metricCard(
        'Calls with cache hit',
        `${t.cachedModelCalls ?? 0}/${t.modelCalls ?? 0}`,
        'Model calls where provider reported cachedPromptTokens > 0',
      )}
      ${metricCard('Cache saved', fmtUsd(t.costSavedUsd), 'Est. USD vs billing all prompt tokens at miss rate')}
      ${metricCard('Replay hits', `${t.replayedCalls ?? 0} (${fmtPct(t.replayHitRate)})`)}
      ${metricCard('Policy denials', t.policyDenials ?? 0)}
      ${metricCard('Model retries', h.totalRetries ?? 0, 'Harness retry counter')}
    </div>
  </div>`);

  if (runtimeTrace?.spans?.length) {
    const maxMs = Math.max(...runtimeTrace.spans.map((s) => s.durationMs || 0), 1);
    const rows = runtimeTrace.spans
      .map((s) => {
        const width = Math.max(2, Math.round((100 * (s.durationMs || 0)) / maxMs));
        const attrs = s.attributes || {};
        const bits = [];
        if (attrs['gen_ai.usage.prompt_tokens'] != null) {
          bits.push(`${attrs['gen_ai.usage.prompt_tokens']}+${attrs['gen_ai.usage.completion_tokens'] ?? 0} tok`);
        }
        if (attrs['agent.cost_usd'] != null) bits.push(fmtUsd(attrs['agent.cost_usd']));
        if (attrs['gen_ai.usage.cached_prompt_tokens']) {
          bits.push(`cache ${attrs['gen_ai.usage.cached_prompt_tokens']}`);
        }
        if (s.error) bits.push('error');
        const pad = '&nbsp;'.repeat(Math.min(s.depth || 0, 4) * 2);
        return `<div class="span-row ${s.error ? 'err' : ''} ${s.kind}">
          <div class="span-name">${pad}<span class="kind">${escapeHtml(s.kind)}</span> ${escapeHtml(s.name)}</div>
          <div class="span-bar-wrap"><div class="span-bar" style="width:${width}%"></div></div>
          <div class="span-meta">${fmtMs(s.durationMs)} · +${fmtMs(s.startMs)}${bits.length ? ' · ' + bits.map(escapeHtml).join(' · ') : ''}</div>
        </div>`;
      })
      .join('');
    parts.push(`<div class="trace-section">
      <h3>Runtime timeline</h3>
      <div class="span-list">${rows}</div>
    </div>`);
  }

  if (h.turns?.length) {
    const turnRows = h.turns
      .map((turn) => {
        const m = turn.model || {};
        const u = m.usage || {};
        const tools = (turn.tools || [])
          .map((tc) => `<span class="chip ${tc.ok ? 'ok' : 'err'}">${escapeHtml(tc.tool)} ${fmtMs(tc.durationMs)}</span>`)
          .join(' ');
        const compact = turn.context?.compact
          ? `<div class="turn-note">compact: ${escapeHtml(turn.context.compact.outcome)} (${escapeHtml(turn.context.compact.reason)})</div>`
          : '';
        const assemble = turn.context?.assemble
          ? `<div class="turn-note">assemble: ${escapeHtml(turn.context.assemble.outcome)} · ${escapeHtml((turn.context.assemble.reasons || []).join(', ') || '—')}</div>`
          : '';
        return `<div class="turn-card">
          <div class="turn-head">
            <strong>Turn ${turn.turn}</strong>
            <span>${m.ok === false ? 'model error' : 'ok'} · ${fmtMs(m.durationMs)} · retries ${m.retries ?? 0}</span>
          </div>
          <div class="turn-body">
            <div>${u.promptTokens ?? '—'}+${u.completionTokens ?? '—'} tok · cached ${u.cachedPromptTokens ?? 0} · ${fmtUsd(u.costUsd)}</div>
            ${tools ? `<div class="turn-tools">${tools}</div>` : ''}
            ${assemble}
            ${compact}
            ${m.error ? `<div class="turn-note err">${escapeHtml(m.error)}</div>` : ''}
          </div>
        </div>`;
      })
      .join('');
    parts.push(`<div class="trace-section">
      <h3>Harness turns</h3>
      <div class="turn-list">${turnRows}</div>
    </div>`);
  }

  traceContent.innerHTML = parts.join('');
}

function renderSessionTraceBundle(bundle) {
  const t = bundle.runtimeTotals || {};
  const h = bundle.harnessAggregate || {};
  const writeFileMs = resolveWriteFileMs(t);
  const durableWrites =
    t.durableWrites != null
      ? t.durableWrites
      : (bundle.runs || []).reduce(
          (sum, r) => sum + resolveDurableWrites(r.runtimeTrace?.totals),
          0,
        );
  const parts = [];
  parts.push(`<div class="trace-section">
    <h3>Session ${escapeHtml(bundle.title || bundle.sessionId)}</h3>
    <p class="fine">${escapeHtml(bundle.sessionId)} · ${bundle.runCount || 0} runs · updated ${escapeHtml(bundle.updatedAt || '')}</p>
    <div class="metrics">
      ${metricCard('Wall time', fmtMs(t.wallMs ?? h.runDurationMs))}
      ${metricCard('Model time', fmtMs(t.modelMs))}
      ${metricCard('Tool time', fmtMs(t.toolMs))}
      ${metricCard(
        'event log write',
        durableWrites ? `${fmtMs(writeFileMs)} (${durableWrites})` : fmtMs(writeFileMs),
        'Summed event-log flush time across session runs',
        'metric-write-file',
      )}
      ${metricCard('Cost', fmtUsd(t.costUsd ?? h.estimatedCostUsd))}
      ${metricCard('Prompt tokens', t.promptTokens ?? h.totalPromptTokens ?? 0)}
      ${metricCard('Completion tokens', t.completionTokens ?? h.totalCompletionTokens ?? 0)}
      ${metricCard('Model calls', t.modelCalls ?? h.totalTurns ?? 0)}
      ${metricCard('Tool calls', `${t.toolCalls ?? h.totalToolCalls ?? 0} (${t.failedToolCalls ?? h.toolFail ?? 0} fail)`)}
      ${metricCard('Harness turns', h.totalTurns ?? '—')}
      ${metricCard('Harness retries', h.totalRetries ?? '—')}
    </div>
  </div>`);

  const runs = bundle.runs || [];
  if (runs.length) {
    const rows = runs
      .map((r) => {
        const hasHarness = r.harnessTrace ? 'harness' : 'runtime-only';
        return `<li>
          <button type="button" class="linkish" data-run-trace="${escapeHtml(r.runId)}" title="Open this run's trace">${escapeHtml(r.runId)}</button>
          <span class="meta">${escapeHtml(r.status)} · ${hasHarness}</span>
        </li>`;
      })
      .join('');
    parts.push(`<div class="trace-section">
      <h3>Runs in session</h3>
      <ul class="session-run-list">${rows}</ul>
    </div>`);
  } else {
    parts.push('<p class="empty">This session has no runs yet.</p>');
  }

  traceContent.innerHTML = parts.join('');
  traceContent.querySelectorAll('[data-run-trace]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const runId = btn.dataset.runTrace;
      const run = runs.find((r) => r.runId === runId);
      if (run?.answer) {
        viewAnswer.innerHTML = renderMarkdownLite(run.answer);
      }
      if (run?.runtimeTrace || run?.harnessTrace) {
        currentRunId = runId;
        renderTrace(run.runtimeTrace, run.harnessTrace, { runId });
        const errors = collectErrorsFromTraces(run.runtimeTrace, run.harnessTrace, {
          runError: run.error,
          runId,
        });
        runErrors = errors;
        renderErrors(errors);
        renderContext(run.harnessTrace);
        document.querySelector('.tab[data-tab="trace"]').click();
        logLine(`loaded run ${runId} from session`);
        return;
      }
      loadRunTrace(runId).catch((e) => logLine(String(e), 'err'));
    });
  });
}

function renderSessionCompare(cmp) {
  const a = cmp.baseline || {};
  const b = cmp.candidate || {};
  const rows = (cmp.deltas || [])
    .map((d) => {
      let pctCls = '';
      let pctText = '—';
      if (d.pct != null && !Number.isNaN(d.pct)) {
        pctCls = d.pct > 0 ? 'up' : d.pct < 0 ? 'down' : '';
        pctText = `${d.pct > 0 ? '+' : ''}${d.pct.toFixed(1)}%`;
      }
      const fmt = (n) =>
        /cost|usd/i.test(d.metric) ? fmtUsd(n) : /ms|duration|wall/i.test(d.metric) ? fmtMs(n) : String(n);
      return `<tr>
        <td>${escapeHtml(d.label)}</td>
        <td class="num">${escapeHtml(fmt(d.baseline))}</td>
        <td class="num">${escapeHtml(fmt(d.candidate))}</td>
        <td class="num ${pctCls}">${escapeHtml(pctText)}</td>
      </tr>`;
    })
    .join('');

  const parts = [];
  parts.push(`<div class="trace-section">
    <h3>Session compare</h3>
    <p class="fine">${escapeHtml(a.title || a.sessionId)} → ${escapeHtml(b.title || b.sessionId)}</p>
    <table class="compare-table">
      <thead><tr><th>Metric</th><th>Baseline</th><th>Candidate</th><th>Δ</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">No comparable metrics</td></tr>'}</tbody>
    </table>
  </div>`);

  if (cmp.harnessReport) {
    parts.push(`<div class="trace-section">
      <h3>Harness report</h3>
      <pre class="compare-report">${escapeHtml(cmp.harnessReport)}</pre>
    </div>`);
  }

  compareContent.innerHTML = parts.join('');
}

async function readSse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      const lines = part.split('\n');
      let event = 'message';
      let data = '';
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      handleEvent(event, JSON.parse(data));
    }
  }
}

async function runAgent() {
  const goal = goalEl.value.trim();
  const workspace = workspaceEl.value.trim();
  if (!goal) return;
  if (!workspace) {
    runHint.textContent = 'Repository path is required';
    return;
  }

  const sessionId = sessionSelect.value.trim() || undefined;
  const crashAfterTurn = Number(crashTurnEl.value);
  const body = {
    goal,
    workspace,
    hitlWrites: hitlWritesEl.checked,
    longTermMemory: longTermMemoryEl.checked,
    loopMode: loopModeEl.value,
    newSession: !sessionId,
  };
  if (sessionId) body.sessionId = sessionId;
  if (crashAfterTurn > 0) body.crashAfterTurn = crashAfterTurn;

  const url = sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}/continue` : '/api/run';

  setDriving(true);
  clearTerminalBanners();
  resumableRunId = null;
  resumeDurableBtn.hidden = true;
  runHint.textContent = 'Running…';
  eventLog.innerHTML = '';
  streamAnswerBuf = '';
  streamThinkingBuf = '';
  streamAnswerActive = false;
  viewAnswer.innerHTML = '<p class="empty">Streaming…</p>';
  logLine(`workspace ${workspace}`);
  logLine(sessionId ? `continue session ${sessionId}` : 'new session…');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    logLine(err.error || 'request failed', 'err');
    setDriving(false);
    runHint.textContent = '';
    return;
  }

  await readSse(res);
  setDriving(false);
  runHint.textContent = '';
  await Promise.all([refreshStatus(), refreshSessions(), refreshRuns()]);
}

async function resumeRun(runId) {
  const workspace = workspaceEl.value.trim();
  if (!workspace) {
    runHint.textContent = 'Repository path is required';
    return;
  }
  setDriving(true);
  clearTerminalBanners();
  resumableRunId = null;
  resumeDurableBtn.hidden = true;
  currentRunId = runId;
  syncControlLabel();
  runHint.textContent = 'Resuming…';
  eventLog.innerHTML = '';
  streamAnswerBuf = '';
  streamThinkingBuf = '';
  streamAnswerActive = false;
  viewAnswer.innerHTML = '<p class="empty">Streaming…</p>';
  logLine(`resume ${runId}`);

  // Do not re-inject crashAfterTurn on resume unless the user sets it again after a crash.
  const crashAfterTurn = Number(crashTurnEl.value);
  const body = {
    workspace,
    hitlWrites: hitlWritesEl.checked,
    longTermMemory: longTermMemoryEl.checked,
    loopMode: loopModeEl.value,
  };
  if (crashAfterTurn > 0) body.crashAfterTurn = crashAfterTurn;

  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    logLine(err.error || 'resume failed', 'err');
    // Keep the run resumable so the user can retry.
    resumableRunId = runId;
    setDriving(false);
    runHint.textContent = '';
    syncResumeUi();
    return;
  }

  await readSse(res);
  setDriving(false);
  runHint.textContent = '';
  await Promise.all([refreshStatus(), refreshSessions(), refreshRuns()]);
}

async function postControl(path, body = {}) {
  if (!currentRunId) return;
  const res = await fetch(`/api/runs/${encodeURIComponent(currentRunId)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) logLine(data.error || `control ${path} failed`, 'err');
  return data;
}

function handleEvent(event, data) {
  if (event === 'status') logLine(`status ${data.phase}${data.mode ? ` (${data.mode})` : ''}`);
  if (event === 'session') {
    currentSessionId = data.sessionId;
    sessionSelect.value = data.sessionId;
    syncSessionActions();
    sessionHint.textContent = data.title
      ? `Session ${data.title}`
      : `Session ${data.sessionId}`;
    logLine(`session ${data.sessionId}${data.title ? ` (${data.title})` : ''}`);
  }
  if (event === 'run') {
    currentRunId = data.runId;
    runErrors = [];
    renderErrors(runErrors);
    viewContext.innerHTML =
      '<p class="empty">Assemble / compact before·after transcripts appear after a run (or when you load a harness trace).</p>';
    syncControlLabel();
    controlBar.hidden = false;
    logLine(`run ${data.runId}`);
  }
  if (event === 'tool') {
    if (data.status === 'start') logLine(`→ ${data.tool}`);
    if (data.status === 'ok') logLine(`✓ ${data.tool}`, 'ok');
    if (data.status === 'error') {
      logLine(`✗ ${data.tool}: ${data.error}`, 'err');
      pushError({ source: 'tool', message: `${data.tool}: ${data.error || 'failed'}` });
    }
  }
  if (event === 'model') {
    const cost = data.costUsd != null ? ` ${fmtUsd(data.costUsd)}` : '';
    const lat = data.latencyMs != null ? ` ${fmtMs(data.latencyMs)}` : '';
    const cached = data.cachedPromptTokens ? ` cache ${data.cachedPromptTokens}` : '';
    logLine(
      `model ${data.callId} ${data.promptTokens ?? '?'}+${data.completionTokens ?? '?'} tok${lat}${cost}${cached}`,
      'model',
    );
  }
  if (event === 'model_token') {
    appendAnswerToken(data.token || '');
  }
  if (event === 'thinking_token') {
    appendThinkingToken(data.token || '');
  }
  if (event === 'policy') {
    logLine(`policy deny ${data.scope}:${data.target} — ${data.reason}`, 'err');
    pushError({
      source: 'policy',
      message: `deny ${data.scope}:${data.target} — ${data.reason}`,
    });
  }
  if (event === 'paused') {
    pauseBanner.hidden = false;
    logLine(`paused at turn ${data.turn}`, 'warn');
  }
  if (event === 'intervention') {
    pauseBanner.hidden = true;
    logLine(`intervention ${data.action}${data.reason ? `: ${data.reason}` : ''}`);
    if (data.action === 'abort') {
      // Abort completes the run — not durable-resumable.
      resumableRunId = null;
      abortBanner.hidden = false;
      crashBanner.hidden = true;
      resumeDurableBtn.hidden = true;
    }
  }
  if (event === 'needs_input' && data.kind === 'approval') {
    pendingApproval = data;
    approvalPanel.hidden = false;
    approvalBody.textContent = `${data.tool} (callId=${data.callId})\n${JSON.stringify(data.args, null, 2).slice(0, 2000)}`;
    logLine(`needs approval: ${data.tool}`, 'warn');
  }
  if (event === 'crashed') {
    currentRunId = data.runId || currentRunId;
    resumableRunId = currentRunId;
    // Clear crash-after so a follow-up Resume does not immediately re-crash.
    crashTurnEl.value = '';
    abortBanner.hidden = true;
    logLine(`crashed ${data.runId}: ${data.message} — use Resume`, 'err');
    pushError({
      source: 'crash',
      message: data.message || 'run crashed',
      detail: data.runId ? `runId ${data.runId}` : undefined,
    });
    syncResumeUi();
  }
  if (event === 'error') {
    logLine(data.message, 'err');
    pushError({ source: 'error', message: data.message || 'unknown error' });
  }
  if (event === 'done') {
    streamAnswerActive = false;
    pauseBanner.hidden = true;
    approvalPanel.hidden = true;
    crashBanner.hidden = true;
    resumeDurableBtn.hidden = true;
    resumableRunId = null;
    if (data.sessionId) {
      currentSessionId = data.sessionId;
      sessionSelect.value = data.sessionId;
    }
    if (data.runId) currentRunId = data.runId;
    const aborted = data.status !== 'completed' || (data.error && /abort/i.test(String(data.error)));
    if (aborted && data.status !== 'completed') {
      abortBanner.hidden = false;
    }
    // Harness abort still completes the durable run successfully with an abort answer.
    if (data.status === 'completed' && data.answer && /abort|stopped/i.test(String(data.answer))) {
      abortBanner.hidden = false;
    }
    logLine(`done (${data.status})`, data.status === 'completed' ? 'ok' : 'err');
    renderDiffs(data.diffs || []);
    renderTrace(data.runtimeTrace, data.harnessTrace, { runId: data.runId || currentRunId });
    renderContext(data.harnessTrace);
    const fromTrace = collectErrorsFromTraces(data.runtimeTrace, data.harnessTrace, {
      runError: data.error,
      runId: data.runId || currentRunId,
    });
    // Prefer the richer trace-derived list when present; keep live-only entries otherwise.
    runErrors = fromTrace.length ? fromTrace : runErrors;
    if (data.error && !runErrors.some((e) => e.message === String(data.error))) {
      runErrors = [
        {
          at: '',
          source: 'run',
          message: String(data.error),
          detail: data.runId ? `runId ${data.runId}` : undefined,
        },
        ...runErrors,
      ];
    }
    renderErrors(runErrors);
    if (data.plan) {
      loopModeEl.value = 'planner';
      syncLoopModeUi();
      renderPlan(data.plan);
    } else {
      renderPlan(null);
    }
    if (Array.isArray(data.critiques) && data.critiques.length) {
      loopModeEl.value = 'reflection';
      syncLoopModeUi();
      renderFeedback(data.critiques);
    } else if (!data.plan) {
      renderFeedback(null);
    }
    const thinking = data.thinking || streamThinkingBuf || '';
    viewAnswer.innerHTML = ''; // clear before renderAnswerPanel
    if (data.answer || thinking) {
      renderAnswerPanel(data.answer, thinking);
    } else {
      viewAnswer.innerHTML = `<p class="empty">${escapeHtml(data.error || 'No final answer.')}</p>`;
    }
    if (data.plan) {
      document.querySelector('.tab[data-tab="plan"]').click();
    } else if (Array.isArray(data.critiques) && data.critiques.length) {
      document.querySelector('.tab[data-tab="feedback"]').click();
    } else if ((data.diffs || []).length) {
      document.querySelector('.tab[data-tab="diffs"]').click();
    } else if (runErrors.length) {
      document.querySelector('.tab[data-tab="errors"]').click();
    } else if (data.answer || thinking) {
      document.querySelector('.tab[data-tab="answer"]').click();
    } else if (data.runtimeTrace || data.harnessTrace) {
      document.querySelector('.tab[data-tab="trace"]').click();
    }
  }
}

useSandboxBtn.addEventListener('click', () => {
  workspaceEl.value = defaultWorkspace;
  if (defaultGoal) goalEl.value = defaultGoal;
  syncResetVisibility();
});

workspaceEl.addEventListener('change', syncResetVisibility);
workspaceEl.addEventListener('input', syncResetVisibility);

document.getElementById('refreshSessionsBtn').addEventListener('click', () => {
  refreshSessions().catch(console.error);
});

sessionSelect.addEventListener('change', () => {
  const id = sessionSelect.value || null;
  selectSession(id).catch((e) => logLine(String(e), 'err'));
});

renameSessionBtn.addEventListener('click', () => {
  const id = sessionSelect.value;
  if (!id) return;
  const s = cachedSessions.find((x) => x.sessionId === id);
  openRenameDialog(id, s?.title || '');
});

loadSessionTraceBtn.addEventListener('click', () => {
  const id = sessionSelect.value;
  if (!id) return;
  loadSessionTraces(id, { focusTab: 'trace' }).catch((e) => logLine(String(e), 'err'));
});

compareSessionsBtn.addEventListener('click', () => {
  compareSelectedSessions().catch((e) => logLine(String(e), 'err'));
});

renameDialog.addEventListener('close', () => {
  if (renameDialog.returnValue !== 'ok' || !renameTargetId) return;
  const title = renameTitle.value.trim();
  const id = renameTargetId;
  renameTargetId = null;
  if (!title) {
    logLine('session name cannot be empty', 'err');
    return;
  }
  renameSession(id, title).catch((e) => logLine(String(e), 'err'));
});

resetBtn.addEventListener('click', async () => {
  const res = await fetch('/api/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: workspaceEl.value.trim() }),
  });
  const data = await res.json();
  if (!res.ok) {
    logLine(data.error || 'reset failed', 'err');
    return;
  }
  if (data.ok) {
    logLine('sandbox reset', 'ok');
    viewDiffs.innerHTML = '<p class="empty">File diffs appear when the agent edits the workspace.</p>';
    runErrors = [];
    viewErrors.innerHTML = '<p class="empty">Tool, model, policy, and run errors appear here.</p>';
    viewContext.innerHTML =
      '<p class="empty">Assemble / compact before·after transcripts appear after a run (or when you load a harness trace).</p>';
    traceContent.innerHTML =
      '<p class="empty">Runtime + harness metrics appear after a run. Load a session via Traces, or open a run from Recent runs.</p>';
    if (compareContent) {
      compareContent.innerHTML = '<p class="empty">Pick two sessions and click Compare.</p>';
    }
  }
});

runBtn.addEventListener('click', () => {
  runAgent().catch((e) => {
    logLine(String(e), 'err');
    setDriving(false);
  });
});

pauseBtn.addEventListener('click', () => postControl('/pause'));
continueBtn.addEventListener('click', () => {
  pauseBanner.hidden = true;
  postControl('/continue');
});
abortBtn.addEventListener('click', () => postControl('/abort', { reason: 'ui abort' }));
steerBtn.addEventListener('click', () => {
  steerInject.value = '';
  steerGoal.value = '';
  steerDialog.showModal();
});
steerDialog.addEventListener('close', () => {
  if (steerDialog.returnValue !== 'ok') return;
  pauseBanner.hidden = true;
  postControl('/steer', {
    inject: steerInject.value.trim() || undefined,
    goal: steerGoal.value.trim() || undefined,
    reason: 'ui steer',
  });
});

async function decideApproval(approved) {
  if (!pendingApproval || !currentRunId) return;
  const callId = pendingApproval.callId;
  approvalPanel.hidden = true;
  pendingApproval = null;
  await postControl('/approve', { callId, approved });
  logLine(approved ? `approved ${callId}` : `denied ${callId}`, approved ? 'ok' : 'err');
}

approveYesBtn.addEventListener('click', () => decideApproval(true));
approveNoBtn.addEventListener('click', () => decideApproval(false));

crashResumeBtn.addEventListener('click', () => {
  if (currentRunId) resumeRun(currentRunId).catch((e) => logLine(String(e), 'err'));
});
resumeDurableBtn.addEventListener('click', () => {
  if (currentRunId) resumeRun(currentRunId).catch((e) => logLine(String(e), 'err'));
});

Promise.all([refreshStatus(), refreshSessions(), refreshRuns()]).catch(console.error);

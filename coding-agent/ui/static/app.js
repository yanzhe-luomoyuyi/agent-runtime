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
const viewAnalysis = document.getElementById('view-analysis');
const viewDiffs = document.getElementById('view-diffs');
const viewTrace = document.getElementById('view-trace');
const viewAnswer = document.getElementById('view-answer');

let defaultWorkspace = '';
let defaultGoal = '';

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`view-${tab.dataset.tab}`).classList.add('active');
  });
});

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

async function refreshStatus() {
  const res = await fetch('/api/status');
  const data = await res.json();
  defaultWorkspace = data.defaultWorkspace;
  defaultGoal = data.defaultGoal || '';
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
  runBtn.disabled = !data.hasApiKey || data.busy;
  runHint.textContent = data.busy
    ? 'Run in progress…'
    : data.hasApiKey
      ? ''
      : 'Add DEEPSEEK_API_KEY to coding-agent/.env then restart UI';
  syncResetVisibility();
}

function logLine(text, cls = '') {
  const div = document.createElement('div');
  div.className = `ev ${cls}`;
  div.textContent = text;
  eventLog.prepend(div);
}

function renderMarkdownLite(md) {
  const esc = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = esc
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  return `<div class="markdown">${html}</div>`;
}

function renderDiffs(diffs) {
  if (!diffs?.length) {
    viewDiffs.innerHTML = '<p class="empty">No file changes detected.</p>';
    return;
  }
  viewDiffs.innerHTML = diffs
    .map((d) => {
      const lines = (d.unified || '')
        .split('\n')
        .map((line) => {
          let cls = 'ctx';
          if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) cls = 'meta';
          else if (line.startsWith('+')) cls = 'add';
          else if (line.startsWith('-')) cls = 'del';
          return `<span class="ln ${cls}">${escapeHtml(line)}</span>`;
        })
        .join('');
      return `<div class="file-card">
        <div class="file-head"><span>${escapeHtml(d.path)}</span><span class="badge">${escapeHtml(d.status)}</span></div>
        <pre class="diff">${lines}</pre>
      </div>`;
    })
    .join('');
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

function metricCard(label, value, hint = '') {
  return `<div class="metric">
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

function renderTrace(runtimeTrace, harnessTrace) {
  if (!runtimeTrace && !harnessTrace) {
    viewTrace.innerHTML = '<p class="empty">No trace data for this run.</p>';
    return;
  }

  const t = runtimeTrace?.totals || {};
  const h = harnessTrace || {};
  const ctx = summarizeContextDecisions(h.turns);
  const parts = [];

  parts.push(`<div class="trace-section">
    <h3>Overview</h3>
    <div class="metrics">
      ${metricCard('Wall time', fmtMs(t.wallMs ?? h.runDurationMs))}
      ${metricCard('Model time', fmtMs(t.modelMs))}
      ${metricCard('Tool time', fmtMs(t.toolMs))}
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
        'Content cache hits',
        `${t.cachedModelCalls ?? 0}/${t.modelCalls ?? 0}`,
        'Runtime CachingModelProvider (callModel only)',
      )}
      ${metricCard('Cache saved', fmtUsd(t.costSavedUsd))}
      ${metricCard(
        'Provider cached prompt',
        h.totalCachedPromptTokens ?? 0,
        'Harness: provider KV / prompt-cache tokens',
      )}
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
        if (attrs['agent.cached']) bits.push('cached');
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

  viewTrace.innerHTML = parts.join('');
}

async function runAgent() {
  const goal = goalEl.value.trim();
  const workspace = workspaceEl.value.trim();
  if (!goal) return;
  if (!workspace) {
    runHint.textContent = 'Repository path is required';
    return;
  }
  runBtn.disabled = true;
  runHint.textContent = 'Running…';
  eventLog.innerHTML = '';
  logLine(`workspace ${workspace}`);
  logLine('starting…');

  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal, workspace }),
  });

  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    logLine(err.error || 'request failed', 'err');
    runBtn.disabled = false;
    runHint.textContent = '';
    return;
  }

  // If server returned JSON error with SSE content-type mishap, handle below via events.
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

  runBtn.disabled = false;
  runHint.textContent = '';
  await refreshStatus();
}

function handleEvent(event, data) {
  if (event === 'run') logLine(`run ${data.runId}`);
  if (event === 'tool') {
    if (data.status === 'start') logLine(`→ ${data.tool}`);
    if (data.status === 'ok') logLine(`✓ ${data.tool}`, 'ok');
    if (data.status === 'error') logLine(`✗ ${data.tool}: ${data.error}`, 'err');
  }
  if (event === 'model') {
    const cost = data.costUsd != null ? ` ${fmtUsd(data.costUsd)}` : '';
    const lat = data.latencyMs != null ? ` ${fmtMs(data.latencyMs)}` : '';
    const cache = data.cached ? ' cached' : '';
    logLine(
      `model ${data.callId} ${data.promptTokens ?? '?'}+${data.completionTokens ?? '?'} tok${lat}${cost}${cache}`,
      'model',
    );
  }
  if (event === 'policy') logLine(`policy deny ${data.scope}:${data.target} — ${data.reason}`, 'err');
  if (event === 'error') logLine(data.message, 'err');
  if (event === 'done') {
    logLine(`done (${data.status})`, data.status === 'completed' ? 'ok' : 'err');
    if (data.analysis) {
      viewAnalysis.innerHTML = renderMarkdownLite(data.analysis);
    } else {
      viewAnalysis.innerHTML =
        '<p class="empty">No ANALYSIS.md (normal for Q&A — see Answer). Written only when fixing code or when you ask for a doc.</p>';
    }
    renderDiffs(data.diffs || []);
    renderTrace(data.runtimeTrace, data.harnessTrace);
    viewAnswer.innerHTML = data.answer
      ? `<div class="markdown">${escapeHtml(data.answer)}</div>`
      : `<p class="empty">${escapeHtml(data.error || 'No final answer.')}</p>`;
    if (data.analysis) {
      document.querySelector('.tab[data-tab="analysis"]').click();
    } else if ((data.diffs || []).length) {
      document.querySelector('.tab[data-tab="diffs"]').click();
    } else if (data.answer) {
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
    viewAnalysis.innerHTML = '<p class="empty">Sandbox reset. Run again to regenerate analysis.</p>';
    viewDiffs.innerHTML = '<p class="empty">File diffs appear when the agent edits the workspace.</p>';
    viewTrace.innerHTML =
      '<p class="empty">Runtime + harness metrics appear after a run (cost, duration, cache, retries).</p>';
  }
});

runBtn.addEventListener('click', () => {
  runAgent().catch((e) => {
    logLine(String(e), 'err');
    runBtn.disabled = false;
  });
});

refreshStatus().catch(console.error);

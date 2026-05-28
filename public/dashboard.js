let autoRefresh = true, timer, filters = {};
let currentTab = 'logs';

// ─── Auto-bounce on 401 ───────────────────────────────────────────────────
// /admin/* and /api/* require an admin user_session. If we get 401, the
// session expired or was revoked — bounce to the login page.
(function installFetchAuthInterceptor() {
  const _fetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const res = await _fetch(input, init);
    if (res.status === 401 && url && (url.startsWith('/api/') || url.startsWith('/admin/'))) {
      window.location.replace('/?next=' + encodeURIComponent(window.location.pathname));
    }
    return res;
  };
})();


// Infinite scroll state
let logsData = [];         // all rows loaded so far
let logsOffset = 0;        // current offset
const LOGS_PAGE = 100;     // rows per page (kept small; live refresh reloads page 0 every 2s)
let logsLoading = false;
let logsExhausted = false;

// Sort state
let sortCol = null;
let sortDir = 'asc';       // 'asc' | 'desc'

// ---- Tab switching ----
function switchMainTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.top-tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-content').forEach(el => {
    el.classList.toggle('active', el.id === 'tab-' + tab);
  });
  if (tab === 'settings') { loadTokenData(); }
  if (tab === 'keys') { v2LoadKeys(); }
  if (tab === 'usage') { loadOverview(); loadCharts(); }
  if (tab === 'models') { loadModels(); }
  if (tab === 'audit') { loadAudit(); }
}

function toggleAuto() {
  autoRefresh = !autoRefresh;
  const btn = document.getElementById('btn-auto');
  const dot = document.getElementById('live-dot');
  btn.textContent = autoRefresh ? 'Live' : 'Paused';
  btn.classList.toggle('on', autoRefresh);
  dot.style.animationPlayState = autoRefresh ? 'running' : 'paused';
  dot.style.opacity = autoRefresh ? '1' : '0.25';
  if (autoRefresh) startTimer(); else clearInterval(timer);
}

function startTimer() { clearInterval(timer); timer = setInterval(refresh, 2000); }

function applyFilter() {
  filters.from = document.getElementById('f-from').value || undefined;
  filters.to = document.getElementById('f-to').value || undefined;
  filters.model = document.getElementById('f-model').value || undefined;
  filters.token_name = document.getElementById('f-token').value || undefined;
  fullRefresh();
}

function clearFilter() {
  filters = {};
  document.getElementById('f-from').value = '';
  document.getElementById('f-to').value = '';
  document.getElementById('f-model').value = '';
  document.getElementById('f-token').value = '';
  fullRefresh();
}

function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function extractReasoning(reqBodyStr) {
  if (!reqBodyStr) return null;
  let b;
  try { b = JSON.parse(reqBodyStr); } catch { return null; }
  const effort = b.reasoning_effort ?? b.reasoning?.effort;
  if (effort) return { kind: 'effort', value: String(effort) };
  if (b.thinking) {
    if (b.thinking.type === 'disabled') return null;
    if (b.thinking.type === 'adaptive') return { kind: 'thinking', value: 'adaptive' };
    if (b.thinking.type === 'enabled') {
      const bt = b.thinking.budget_tokens;
      return { kind: 'thinking', value: bt ? `${(bt/1000).toFixed(0)}k` : 'on' };
    }
    return { kind: 'thinking', value: String(b.thinking.type) };
  }
  return null;
}

function reasoningCell(l) {
  const r = l.reasoning ?? extractReasoning(l.request_body);
  if (!r) return '<td></td>';
  let cls;
  if (r.kind === 'effort') {
    cls = `effort-${r.value.toLowerCase()}`;
  } else if (r.value === 'adaptive') {
    cls = 'thinking-adaptive';
  } else if (r.value === 'on') {
    cls = 'thinking-on';
  } else {
    cls = 'thinking-budget';
  }
  return `<td><span class="badge-reasoning ${cls}">${esc(r.value)}</span></td>`;
}

async function refresh() {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from.replace('T', ' '));
  if (filters.to) params.set('to', filters.to.replace('T', ' '));
  if (filters.model) params.set('model', filters.model);
  if (filters.token_name) params.set('token_name', filters.token_name);
  params.set('limit', '200');

  const errorsOnly = document.getElementById('show-errors').checked;
  if (errorsOnly) params.set('errors_only', '1');
  const r = await fetch('/api/logs?' + params);
  const { logs: data, stats, modelStats } = await r.json();

  document.getElementById('s-total').textContent = fmt(stats.total);
  document.getElementById('s-ok').textContent = fmt(stats.ok);
  document.getElementById('s-err').textContent = fmt(stats.err);
  document.getElementById('s-tokens').textContent = fmt(stats.tokens);
  document.getElementById('s-avg').textContent = (stats.avgMs || 0) + 'ms';

  // model pills removed (redundant)
  const ms = document.getElementById('model-stats');
  if (ms) ms.innerHTML = '';

  // model filter
  const sel = document.getElementById('f-model');
  const cur = sel.value;
  if (modelStats?.length) {
    sel.innerHTML = '<option value="">All models</option>' +
      modelStats.map(m => `<option value="${esc(m.model)}"${cur === m.model ? ' selected' : ''}>${esc(m.model)}</option>`).join('');
  }

  const showBody = document.getElementById('show-body').checked;
  const tbody = document.getElementById('log-body');

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="10">
      <div class="empty-wrap">
        <div class="empty-ring"></div>
        <div class="empty-text">No requests yet</div>
        <div class="empty-sub">Requests to /v1/messages will appear here</div>
      </div>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = data.map((l, i) => {
    const sc = l.status < 400 ? 'ok' : 'err';
    const badge = l.stream
      ? '<span class="badge b-stream">SSE</span>'
      : '<span class="badge b-sync">Sync</span>';
    const tok = (l.input_tokens || l.output_tokens)
      ? `${fmt(l.input_tokens)}<span style="color:var(--text-4);margin:0 2px">&rarr;</span>${fmt(l.output_tokens)}`
      : '<span style="color:var(--text-4)">-</span>';
    const preview = l.error || l.preview || '';
    const previewClass = l.error ? 'c-error' : 'c-preview';

    let rows = `<tr onclick="openDetail(${l.id})">
      <td class="c-ts">${l.ts || ''}</td>
      <td class="c-token">${esc(l.token_name || '-')}</td>
      <td class="c-token">${userCell(l)}</td>
      <td class="c-model">${esc(l.model || '-')}</td>
      ${reasoningCell(l)}
      <td><span class="c-status ${sc}">${l.status}</span></td>
      <td class="c-dur">${l.duration_ms ? l.duration_ms + 'ms' : '-'}</td>
      <td class="c-tok">${tok}</td>
      <td>${badge}</td>
      <td class="${previewClass}">${esc(preview)}</td>
    </tr>`;
    return rows;
  }).join('');
}

// renderLogsTable: render logsData into the tbody (isFirst = replace, else append)
function renderLogsTable(isFirst) {
  const tbody = document.getElementById('log-body');

  if (isFirst && !logsData.length) {
    tbody.innerHTML = `<tr><td colspan="10">
      <div class="empty-wrap">
        <div class="empty-ring"></div>
        <div class="empty-text">No requests yet</div>
        <div class="empty-sub">Requests to /v1/messages will appear here</div>
      </div>
    </td></tr>`;
    return;
  }

  const rows = getSortedData(logsData);
  const html = rows.map(l => rowHTML(l)).join('');
  tbody.innerHTML = html;

  // Load more button
  const existing = document.getElementById('load-more-row');
  if (existing) existing.remove();
  if (!logsExhausted) {
    const btn = document.createElement('div');
    btn.id = 'load-more-row';
    btn.className = 'load-more-btn';
    btn.textContent = `Load More (${logsData.length} loaded)`;
    btn.onclick = () => loadLogsPage(false);
    document.getElementById('tbl-container').appendChild(btn);
  }
}

function rowHTML(l) {
  const sc = l.status < 400 ? 'ok' : 'err';
  const badge = l.stream
    ? '<span class="badge b-stream">SSE</span>'
    : '<span class="badge b-sync">Sync</span>';
  const tok = (l.input_tokens || l.output_tokens)
    ? `${fmt(l.input_tokens)}<span style="color:var(--text-4);margin:0 2px">&rarr;</span>${fmt(l.output_tokens)}`
    : '<span style="color:var(--text-4)">-</span>';
  const preview = l.error || l.preview || '';
  const previewClass = l.error ? 'c-error' : 'c-preview';
  return `<tr onclick="openDetail(${l.id})">
    <td class="c-ts">${l.ts || ''}</td>
    <td class="c-token">${esc(l.token_name || '-')}</td>
    <td class="c-token">${userCell(l)}</td>
    <td class="c-model">${esc(l.model || '-')}</td>
    ${reasoningCell(l)}
    <td><span class="c-status ${sc}">${l.status}</span></td>
    <td class="c-dur">${l.duration_ms ? l.duration_ms + 'ms' : '-'}</td>
    <td class="c-tok">${tok}</td>
    <td>${badge}</td>
    <td class="${previewClass}">${esc(preview)}</td>
  </tr>`;
}

function userCell(l) {
  const nick = l.wx_nickname;
  const avatar = l.wx_avatar_url;
  const fallback = l.api_key_name || '-';
  if (nick || avatar) {
    const img = avatar ? `<img src="${esc(avatar)}" referrerpolicy="no-referrer" style="width:18px;height:18px;border-radius:50%;vertical-align:middle;margin-right:4px;object-fit:cover">` : '';
    return `${img}<span style="vertical-align:middle">${esc(nick || fallback)}</span>`;
  }
  return esc(fallback);
}

// ---- Sort ----
function getSortedData(data) {
  if (!sortCol) return data;
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...data].sort((a, b) => {
    let av = sortCol === 'tokens' ? ((a.input_tokens || 0) + (a.output_tokens || 0)) : a[sortCol];
    let bv = sortCol === 'tokens' ? ((b.input_tokens || 0) + (b.output_tokens || 0)) : b[sortCol];
    if (av == null) av = '';
    if (bv == null) bv = '';
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}

function sortTable(col) {
  if (sortCol === col) {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    sortCol = col;
    sortDir = 'asc';
  }
  // Update sort arrow indicators
  document.querySelectorAll('.sort-arrow').forEach(el => {
    el.textContent = '';
    el.classList.remove('sa-asc', 'sa-desc');
  });
  const arrow = document.querySelector(`.sort-arrow[data-col="${col}"]`);
  if (arrow) {
    arrow.textContent = sortDir === 'asc' ? ' ▲' : ' ▼';
    arrow.classList.add(sortDir === 'asc' ? 'sa-asc' : 'sa-desc');
  }
  renderLogsTable(true);
}

async function refresh() {
  // Live incremental poll: if we already have data, only fetch rows with id > max,
  // prepend them, and bump counters locally. No aggregate queries on the server.
  if (logsData.length > 0 && !logsLoading) {
    const sinceId = logsData[0]?.id || 0;
    const params = new URLSearchParams();
    if (filters.from) params.set('from', filters.from.replace('T', ' '));
    if (filters.to) params.set('to', filters.to.replace('T', ' '));
    if (filters.model) params.set('model', filters.model);
    if (filters.token_name) params.set('token_name', filters.token_name);
    if (document.getElementById('show-errors').checked) params.set('errors_only', '1');
    params.set('since_id', String(sinceId));
    params.set('limit', '500');
    try {
      const r = await fetch('/api/logs?' + params);
      const { logs: newRows } = await r.json();
      if (newRows && newRows.length) {
        // newRows ordered by id DESC → prepend
        logsData = newRows.concat(logsData);
        // Bump stat counters locally
        let addTotal = 0, addOk = 0, addErr = 0, addTokens = 0;
        for (const l of newRows) {
          addTotal++;
          if (l.status < 400) addOk++; else addErr++;
          addTokens += (l.input_tokens || 0) + (l.output_tokens || 0);
        }
        bumpStat('s-total', addTotal);
        bumpStat('s-ok', addOk);
        bumpStat('s-err', addErr);
        bumpStat('s-tokens', addTokens);
        renderLogsTable(true);
      }
    } catch (e) { /* swallow */ }
    return;
  }
  // No data yet → full load
  await fullRefresh();
}

async function fullRefresh() {
  logsOffset = 0;
  logsData = [];
  logsExhausted = false;
  await loadLogsPage(true);
}

// Read numeric stat (handles K/M format), add delta, write back formatted.
const _statRaw = { 's-total': 0, 's-ok': 0, 's-err': 0, 's-tokens': 0 };
function bumpStat(id, delta) {
  if (!delta) return;
  _statRaw[id] = (_statRaw[id] || 0) + delta;
  document.getElementById(id).textContent = fmt(_statRaw[id]);
}

async function loadLogsPage(isFirst) {
  if (logsLoading || logsExhausted) return;
  logsLoading = true;

  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from.replace('T', ' '));
  if (filters.to) params.set('to', filters.to.replace('T', ' '));
  if (filters.model) params.set('model', filters.model);
  if (filters.token_name) params.set('token_name', filters.token_name);
  if (document.getElementById('show-errors').checked) params.set('errors_only', '1');
  params.set('limit', String(LOGS_PAGE));
  params.set('offset', String(logsOffset));

  try {
    const r = await fetch('/api/logs?' + params);
    const { logs: data, stats, modelStats } = await r.json();

    if (isFirst) {
      _statRaw['s-total'] = stats.total || 0;
      _statRaw['s-ok'] = stats.ok || 0;
      _statRaw['s-err'] = stats.err || 0;
      _statRaw['s-tokens'] = stats.tokens || 0;
      document.getElementById('s-total').textContent = fmt(stats.total);
      document.getElementById('s-ok').textContent = fmt(stats.ok);
      document.getElementById('s-err').textContent = fmt(stats.err);
      document.getElementById('s-tokens').textContent = fmt(stats.tokens);
      document.getElementById('s-avg').textContent = (stats.avgMs || 0) + 'ms';

      // model pills removed (redundant)
      const ms = document.getElementById('model-stats');
      if (ms) ms.innerHTML = '';

      // model filter
      const sel = document.getElementById('f-model');
      const cur = sel.value;
      if (modelStats?.length) {
        sel.innerHTML = '<option value="">All models</option>' +
          modelStats.map(m => `<option value="${esc(m.model)}"${cur === m.model ? ' selected' : ''}>${esc(m.model)}</option>`).join('');
      }
    }

    if (data.length < LOGS_PAGE) logsExhausted = true;
    logsOffset += data.length;
    logsData = isFirst ? data : logsData.concat(data);

    renderLogsTable(isFirst);
  } finally {
    logsLoading = false;
  }
}



// --- Detail Drawer ---
let drawerCache = {};

async function openDetail(id) {
  const overlay = document.getElementById('drawer-overlay');
  overlay.classList.add('open');
  document.getElementById('drawer-title').textContent = `Request #${id}`;

  let detail = drawerCache[id];
  if (!detail) {
    const r = await fetch(`/api/logs/${id}`);
    detail = await r.json();
    drawerCache[id] = detail;
  }

  const tabs = document.getElementById('drawer-tabs');
  const body = document.getElementById('drawer-body');

  const hasReqBody = !!detail.request_body;
  const hasRespBody = !!detail.response_body;
  const hasError = !!detail.error;
  const isSSE = detail.stream;

  let tabList = ['overview'];
  if (hasReqBody) tabList.push('request');
  if (hasRespBody && isSSE) tabList.push('sse');
  if (hasRespBody && !isSSE) tabList.push('response');
  if (hasError) tabList.push('error');

  function renderTab(tab) {
    tabs.innerHTML = tabList.map(t =>
      `<div class="drawer-tab${t===tab?' active':''}" onclick="switchTab('${t}',${id})">${t}</div>`
    ).join('');

    if (tab === 'overview') {
      body.innerHTML = `
        <div class="drawer-meta">
          <span class="drawer-meta-k">Time</span><span class="drawer-meta-v">${esc(detail.ts)}</span>
          <span class="drawer-meta-k">Model</span><span class="drawer-meta-v">${esc(detail.model||'-')}</span>
          <span class="drawer-meta-k">Token</span><span class="drawer-meta-v">${esc(detail.token_name||'-')}</span>
          <span class="drawer-meta-k">Status</span><span class="drawer-meta-v">${detail.status}</span>
          <span class="drawer-meta-k">Duration</span><span class="drawer-meta-v">${detail.duration_ms}ms</span>
          <span class="drawer-meta-k">Type</span><span class="drawer-meta-v">${detail.stream?'SSE Stream':'Sync'}</span>
          <span class="drawer-meta-k">Input Tok</span><span class="drawer-meta-v">${fmt(detail.input_tokens||0)}</span>
          <span class="drawer-meta-k">Output Tok</span><span class="drawer-meta-v">${fmt(detail.output_tokens||0)}</span>
        </div>
        ${detail.error ? `<div class="detail-body has-error"><div class="detail-error-label">Error</div><pre>${esc(detail.error)}</pre></div>` : ''}
        ${detail.request_summary ? `<div class="detail-body"><div class="detail-req-label">Summary</div><pre>${esc(detail.request_summary)}</pre></div>` : ''}
      `;
    } else if (tab === 'request') {
      let formatted = detail.request_body;
      try { formatted = JSON.stringify(JSON.parse(formatted), null, 2); } catch {}
      body.innerHTML = `<pre>${esc(formatted)}</pre>`;
    } else if (tab === 'response') {
      let formatted = detail.response_body;
      try { formatted = JSON.stringify(JSON.parse(formatted), null, 2); } catch {}
      body.innerHTML = `<pre>${esc(formatted)}</pre>`;
    } else if (tab === 'sse') {
      body.innerHTML = renderSSE(detail.response_body);
    } else if (tab === 'error') {
      body.innerHTML = `<div class="detail-body has-error"><pre>${esc(detail.error)}</pre></div>`;
    }
  }

  window._currentDetail = { tabList, detail, renderTab };
  renderTab(tabList[0]);
}

function switchTab(tab, id) {
  if (window._currentDetail) window._currentDetail.renderTab(tab);
}

function closeDrawer(e) {
  if (e && e.target !== document.getElementById('drawer-overlay')) return;
  document.getElementById('drawer-overlay').classList.remove('open');
}

// ESC to close drawer or modal
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (document.getElementById('device-modal').classList.contains('open')) closeDeviceModal();
    else closeDrawer();
  }
});

function renderSSE(raw) {
  if (!raw) return '<span style="color:var(--text-4)">No SSE data</span>';
  const lines = raw.split('\n');
  let events = [];
  let currentEvent = null;

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      if (currentEvent) events.push(currentEvent);
      currentEvent = { type: line.slice(7).trim(), data: '' };
    } else if (line.startsWith('data: ')) {
      const dataStr = line.slice(6);
      if (!currentEvent) currentEvent = { type: 'data', data: '' };
      currentEvent.data += (currentEvent.data ? '\n' : '') + dataStr;
    } else if (line.trim() === '' && currentEvent) {
      events.push(currentEvent);
      currentEvent = null;
    }
  }
  if (currentEvent) events.push(currentEvent);

  if (!events.length) return `<pre>${esc(raw.slice(0, 5000))}</pre>`;

  let html = `<div style="margin-bottom:12px;color:var(--text-4);font-size:11px">${events.length} SSE events</div>`;

  let deltaBuffer = [];
  function flushDeltas() {
    if (!deltaBuffer.length) return '';
    const texts = deltaBuffer.map(d => {
      try {
        const j = JSON.parse(d);
        if (j.delta?.text) return j.delta.text;
        if (j.delta?.thinking) return j.delta.thinking;
        return d.slice(0, 120);
      } catch { return d.slice(0, 120); }
    });
    const count = deltaBuffer.length;
    deltaBuffer = [];
    const combined = texts.join('');
    return `<div class="sse-event evt-content_block_delta">
      <div class="sse-type">content_block_delta x ${count}</div>
      <div class="sse-data">${esc(combined.slice(0, 2000))}${combined.length > 2000 ? '...' : ''}</div>
    </div>`;
  }

  for (const evt of events) {
    if (evt.type === 'content_block_delta') {
      deltaBuffer.push(evt.data);
      continue;
    }
    html += flushDeltas();

    let prettyData = evt.data;
    try { prettyData = JSON.stringify(JSON.parse(evt.data), null, 2); } catch {}

    html += `<div class="sse-event evt-${esc(evt.type)}">
      <div class="sse-type">${esc(evt.type)}</div>
      <div class="sse-data">${esc(prettyData.slice(0, 3000))}</div>
    </div>`;
  }
  html += flushDeltas();
  return html;
}

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ---- Charts ----
const COLORS = {
  green: '#3dd68c', red: '#ef5f5f',
  accent: '#7170ff',
  grid: 'rgba(255,255,255,0.04)', label: '#5a5e66',
};
const MODEL_COLORS = ['#7170ff','#3dd68c','#f0b429','#a78bfa','#ef5f5f','#60a5fa','#f472b6'];

const tip = document.getElementById('chart-tip');
function showTip(e, html) {
  tip.innerHTML = html;
  tip.classList.add('open');
  const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
  const y = e.clientY - tip.offsetHeight - 8;
  tip.style.left = x + 'px';
  tip.style.top = (y < 4 ? e.clientY + 16 : y) + 'px';
}
function hideTip() { tip.classList.remove('open'); }

let hourlyHits = [], cachedHourly = [];

function drawHourlyChart(data) {
  cachedHourly = data;
  const canvas = document.getElementById('chart-hourly');
  const scroll = document.getElementById('chart-scroll');
  if (!data.length || !scroll.getBoundingClientRect().width) return;

  const BAR_W = 18;
  const GAP = 3;
  const slotW = BAR_W + GAP;
  const totalW = data.length * slotW + 40;
  const h = 110;
  const dateH = 20;
  const pad = { t: dateH + 2, b: 16 };
  const ch = h - pad.t - pad.b;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = totalW * dpr;
  canvas.height = h * dpr;
  canvas.style.width = totalW + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const maxVal = Math.max(...data.map(d => d.total), 1);
  hourlyHits = [];
  ctx.clearRect(0, 0, totalW, h);

  const daySpans = [];
  let curDay = '', spanStart = 0;
  data.forEach((d, i) => {
    const day = d.slot.slice(0, 10);
    if (day !== curDay) {
      if (curDay) daySpans.push({ day: curDay, x1: spanStart * slotW, x2: i * slotW });
      curDay = day; spanStart = i;
    }
  });
  if (curDay) daySpans.push({ day: curDay, x1: spanStart * slotW, x2: data.length * slotW });

  const dayColors = ['rgba(255,255,255,0.02)', 'rgba(255,255,255,0.04)'];
  daySpans.forEach((span, si) => {
    ctx.fillStyle = dayColors[si % 2];
    ctx.fillRect(span.x1, 0, span.x2 - span.x1, h);

    const weekday = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(span.day + 'T12:00:00').getDay()];
    const label = `${span.day.slice(5)}  ${weekday}`;
    const cx = (span.x1 + span.x2) / 2;
    ctx.font = '600 11px Inter, system-ui';
    ctx.fillStyle = '#7170ff';
    ctx.textAlign = 'center';
    ctx.fillText(label, cx, 14);

    if (si > 0) {
      ctx.strokeStyle = 'rgba(113,112,255,0.2)'; ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(span.x1, 0); ctx.lineTo(span.x1, h); ctx.stroke();
      ctx.setLineDash([]);
    }
  });

  for (let i = 0; i <= 2; i++) {
    const y = pad.t + ch * (1 - i / 2);
    ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(totalW, y); ctx.stroke();
  }

  data.forEach((d, i) => {
    const x = i * slotW + slotW / 2;
    const okH = Math.max((d.ok / maxVal) * ch, d.ok ? 1 : 0);
    const errH = Math.max((d.err / maxVal) * ch, d.err ? 1 : 0);
    const totalH = okH + errH;
    const barY = pad.t + ch - totalH;

    ctx.fillStyle = COLORS.green;
    ctx.beginPath(); ctx.roundRect(x - BAR_W / 2, barY + errH, BAR_W, okH, [0, 0, 2, 2]); ctx.fill();

    if (errH > 0) {
      ctx.fillStyle = COLORS.red;
      ctx.beginPath(); ctx.roundRect(x - BAR_W / 2, barY, BAR_W, errH, [2, 2, 0, 0]); ctx.fill();
    }

    const hour = d.slot.slice(11, 13);
    if (parseInt(hour) % 3 === 0) {
      ctx.font = '9px Inter, system-ui'; ctx.textAlign = 'center';
      ctx.fillStyle = COLORS.label;
      ctx.fillText(hour + ':00', x, h - 3);
    }

    hourlyHits.push({ x: i * slotW, x2: (i + 1) * slotW, d });
  });

  scroll.scrollLeft = totalW;
}

// drag to scroll
(function() {
  const el = document.getElementById('chart-scroll');
  let isDrag = false, startX = 0, startScroll = 0;
  el.addEventListener('mousedown', e => {
    isDrag = true; startX = e.pageX; startScroll = el.scrollLeft;
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!isDrag) return;
    el.scrollLeft = startScroll - (e.pageX - startX);
  });
  document.addEventListener('mouseup', () => { isDrag = false; });
})();

// hover
document.getElementById('chart-hourly').addEventListener('mousemove', function(e) {
  const scroll = document.getElementById('chart-scroll');
  const rect = this.getBoundingClientRect();
  const mx = e.clientX - rect.left + scroll.scrollLeft;
  const hit = hourlyHits.find(h => mx >= h.x && mx <= h.x2);
  if (hit) {
    const day = hit.d.slot.slice(0, 10);
    const hour = hit.d.slot.slice(11, 13);
    showTip(e, `<div class="tip-label">${day} ${hour}:00</div>
      <div class="tip-row"><span class="tip-dot" style="background:${COLORS.green}"></span>Success <span class="tip-val">${hit.d.ok.toLocaleString()}</span></div>
      <div class="tip-row"><span class="tip-dot" style="background:${COLORS.red}"></span>Failed <span class="tip-val">${hit.d.err.toLocaleString()}</span></div>
      <div class="tip-row" style="color:var(--text-3)">Tokens <span class="tip-val">${fmt(hit.d.tokens)}</span></div>`);
  } else hideTip();
});
document.getElementById('chart-hourly').addEventListener('mouseleave', hideTip);

function drawModelShare(data) {
  const el = document.getElementById('chart-models');
  if (!el) return;
  if (!data.length) { el.innerHTML = '<span style="color:var(--text-4);font-size:11px">No data</span>'; return; }

  el.innerHTML = data.slice(0, 5).map((m, i) => {
    const color = MODEL_COLORS[i % MODEL_COLORS.length];
    return `<div class="share-item">
      <div class="share-row">
        <span class="share-name">${esc(m.model || 'unknown')}</span>
        <span class="share-pct">${m.pct}% (${fmt(m.count)})</span>
      </div>
      <div class="share-track">
        <div class="share-fill" style="width:${m.pct}%;background:${color}"></div>
      </div>
    </div>`;
  }).join('');
}

function drawNamedShare(data, elId, nameKey) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!data.length) { el.innerHTML = '<span style="color:var(--text-4);font-size:11px">No data</span>'; return; }
  el.innerHTML = data.slice(0, 7).map((m, i) => {
    const color = MODEL_COLORS[i % MODEL_COLORS.length];
    const tokens = m.tokens ? ` &middot; ${fmt(m.tokens)} tok` : '';
    return `<div class="share-item">
      <div class="share-row">
        <span class="share-name">${esc(m[nameKey] || m.name || 'unknown')}</span>
        <span class="share-pct">${m.pct}% (${fmt(m.count)}${tokens})</span>
      </div>
      <div class="share-track">
        <div class="share-fill" style="width:${m.pct}%;background:${color}"></div>
      </div>
    </div>`;
  }).join('');
}

let chartLoaded = false;
async function loadCharts() {
  try {
    const r = await fetch('/api/stats/charts');
    const { hourly, modelShare, apiKeyShare, tokenShare } = await r.json();

    if (hourly.length) {
      const map = new Map(hourly.map(h => [h.slot, h]));
      const firstDay = hourly[0].slot.slice(0, 10);
      const lastDay = hourly[hourly.length - 1].slot.slice(0, 10);
      const filled = [];
      const d = new Date(firstDay + 'T00:00:00');
      const end = new Date(lastDay + 'T23:00:00');
      while (d <= end) {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const slot = `${yyyy}-${mm}-${dd} ${hh}`;
        filled.push(map.get(slot) || { slot, total: 0, ok: 0, err: 0, tokens: 0 });
        d.setHours(d.getHours() + 1);
      }
      drawHourlyChart(filled);
    } else {
      drawHourlyChart([]);
    }

    drawModelShare(modelShare);
    drawNamedShare(apiKeyShare, 'chart-apikeys', 'name');
    drawNamedShare(tokenShare, 'chart-tokens', 'name');
    chartLoaded = true;
  } catch (e) { console.warn('chart load failed', e); }
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (chartLoaded) loadCharts(); }, 200);
});

// ---- Token Management ----
let tokenData = [];

async function loadTokenData() {
  try {
    const r = await fetch('/api/tokens');
    tokenData = await r.json();
    renderTokenSection();
    updateTokenFilter();
  } catch (e) { console.warn('token load failed', e); }
}

function tokenTypeClass(type) {
  return 'type-' + (type || 'unknown').replace(/_$/, '');
}

function renderTokenSection() {
  const activeInfo = document.getElementById('active-token-info');
  const list = document.getElementById('token-list');

  const active = tokenData.find(t => t.active);
  if (active) {
    activeInfo.innerHTML = `
      <div class="token-active-badge">
        <div class="token-active-dot"></div>
        ${esc(active.name)}
      </div>
      <div class="token-active-meta">
        <span><span class="label">User</span><span class="val">${esc(active.username || 'unknown')}</span></span>
        <span><span class="label">Type</span><span class="token-chip ${tokenTypeClass(active.type)}">${esc(active.type)}</span></span>
        <span><span class="label">Token</span><span class="val">${esc(active.masked)}</span></span>
      </div>
    `;
  } else {
    activeInfo.innerHTML = '<span style="color:var(--text-4)">No token configured</span>';
  }

  list.innerHTML = tokenData.map(t => {
    const tcls = tokenTypeClass(t.type);
    const safeName = esc(t.name).replace(/'/g, "\\'");
    return `<div class="token-list-item${t.active ? ' active' : ''}">
      <input type="radio" class="token-radio" name="active-token" ${t.active ? 'checked' : ''}
             onchange="activateToken('${safeName}')" ${t.isEnv ? 'disabled' : ''}>
      <div class="token-info">
        <span class="token-name">${esc(t.name)}</span>
        <span class="token-detail">
          <span class="token-chip ${tcls}">${esc(t.type)}</span>
          ${esc(t.masked)} ${t.username ? '&middot; ' + esc(t.username) : ''}
        </span>
      </div>
      <div class="token-actions">
        <button class="btn" onclick="testToken('${safeName}')" style="padding:3px 8px;font-size:10px">Test</button>
        ${!t.isEnv ? `<button class="btn" onclick="deleteToken('${safeName}')" style="padding:3px 8px;font-size:10px;color:var(--red)">Del</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function updateTokenFilter() {
  const sel = document.getElementById('f-token');
  const cur = sel.value;
  const names = [...new Set(tokenData.map(t => t.name))];
  sel.innerHTML = '<option value="">All tokens</option>' +
    names.map(n => `<option value="${esc(n)}"${cur === n ? ' selected' : ''}>${esc(n)}</option>`).join('');
}

async function activateToken(name) {
  try {
    await fetch(`/api/tokens/${encodeURIComponent(name)}/activate`, { method: 'PUT' });
    await loadTokenData();
  } catch (e) { alert('Failed to activate token: ' + e.message); }
}

async function addToken() {
  const nameEl = document.getElementById('add-token-name');
  const valEl = document.getElementById('add-token-value');
  const name = nameEl.value.trim();
  const token = valEl.value.trim();
  if (!name || !token) { alert('Name and token are required'); return; }
  try {
    const r = await fetch('/api/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, token })
    });
    const data = await r.json();
    if (!r.ok) { alert(data.error || 'Failed to add token'); return; }
    nameEl.value = '';
    valEl.value = '';
    await loadTokenData();
  } catch (e) { alert('Failed to add token: ' + e.message); }
}

async function deleteToken(name) {
  if (!confirm(`Delete token "${name}"?`)) return;
  try {
    await fetch(`/api/tokens/${encodeURIComponent(name)}`, { method: 'DELETE' });
    await loadTokenData();
  } catch (e) { alert('Failed to delete token: ' + e.message); }
}

async function testToken(name) {
  const btn = event.target;
  const orig = btn.textContent;
  btn.textContent = '...';
  btn.disabled = true;
  try {
    const r = await fetch(`/api/tokens/${encodeURIComponent(name)}/test`);
    const data = await r.json();
    alert(`Token: ${name}\nCopilot Exchange: ${data.success ? 'OK' : 'FAILED'}\nUsername: ${data.username || 'N/A'}\nEndpoint: ${data.endpointType}\nType: ${data.type}`);
    await loadTokenData();
  } catch (e) { alert('Test failed: ' + e.message); }
  btn.textContent = orig;
  btn.disabled = false;
}

// ── API Key Management moved to Keys tab (v2). See v2*Keys functions below. ──

// ── Device Login (GitHub OAuth Device Flow) ──
let deviceSessionId = null;
let devicePollTimer = null;

function openDeviceModal() {
  document.getElementById('device-token-name').value = '';
  document.getElementById('device-step-start').style.display = '';
  document.getElementById('device-step-code').style.display = 'none';
  document.getElementById('device-step-done').style.display = 'none';
  document.getElementById('device-modal').classList.add('open');
}

function closeDeviceModal() {
  document.getElementById('device-modal').classList.remove('open');
  if (devicePollTimer) { clearInterval(devicePollTimer); devicePollTimer = null; }
  deviceSessionId = null;
}

async function startDeviceLogin() {
  const tokenName = document.getElementById('device-token-name').value.trim();
  try {
    const r = await fetch('/api/device-login/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token_name: tokenName }),
    });
    const data = await r.json();
    if (!r.ok) { alert(data.error || 'Failed to start device login'); return; }
    deviceSessionId = data.session_id;
    document.getElementById('device-user-code').textContent = data.user_code;
    document.getElementById('device-verify-link').href = data.verification_uri;
    document.getElementById('device-step-start').style.display = 'none';
    document.getElementById('device-step-code').style.display = '';
    document.getElementById('device-status').innerHTML = '<div class="device-spinner"></div><span>Waiting for authorization...</span>';
    devicePollTimer = setInterval(pollDeviceLogin, 5000);
  } catch (e) { alert('Failed to start device login: ' + e.message); }
}

async function pollDeviceLogin() {
  if (!deviceSessionId) return;
  try {
    const r = await fetch('/api/device-login/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: deviceSessionId }),
    });
    const data = await r.json();
    if (data.status === 'pending') {
      if (data.interval && devicePollTimer) {
        clearInterval(devicePollTimer);
        devicePollTimer = setInterval(pollDeviceLogin, data.interval * 1000);
      }
      return;
    }
    if (data.status === 'complete') {
      clearInterval(devicePollTimer);
      devicePollTimer = null;
      document.getElementById('device-step-code').style.display = 'none';
      document.getElementById('device-step-done').style.display = '';
      document.getElementById('device-done-name').textContent = data.token_name;
      document.getElementById('device-done-user').textContent = data.username || 'unknown';
      await loadTokenData();
      provisionQuickstart(data.token_name);
      return;
    }
    if (data.status === 'expired') {
      clearInterval(devicePollTimer);
      devicePollTimer = null;
      document.getElementById('device-status').innerHTML = '<span style="color:var(--red)">Code expired. Please try again.</span>';
      return;
    }
    if (data.status === 'error') {
      clearInterval(devicePollTimer);
      devicePollTimer = null;
      document.getElementById('device-status').innerHTML = `<span style="color:var(--red)">Error: ${esc(data.error)}</span>`;
      return;
    }
  } catch (e) {
    console.warn('Device login poll error:', e);
  }
}

async function copyDeviceCode() {
  const code = document.getElementById('device-user-code').textContent;
  try {
    await navigator.clipboard.writeText(code);
    const btn = document.getElementById('device-copy-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy Code'; }, 2000);
  } catch { alert('Copy failed'); }
}

async function provisionQuickstart(tokenName) {
  const loading = document.getElementById('device-quickstart-loading');
  const body = document.getElementById('device-quickstart-body');
  const err = document.getElementById('device-quickstart-err');
  loading.style.display = '';
  body.style.display = 'none';
  err.style.display = 'none';
  try {
    const r = await fetch('/admin/quickstart-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token_name: tokenName }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    const claudeCmd = `export ANTHROPIC_BASE_URL=${data.base_url} ANTHROPIC_AUTH_TOKEN=${data.key}\nclaude`;
    const openaiCmd = `export OPENAI_BASE_URL=${data.base_url}/v1 OPENAI_API_KEY=${data.key}`;
    document.getElementById('device-qs-key').textContent = data.key;
    document.getElementById('device-qs-claude').textContent = claudeCmd;
    document.getElementById('device-qs-openai').textContent = openaiCmd;
    const snippets = { key: data.key, claude: claudeCmd, openai: openaiCmd };
    document.querySelectorAll('#device-quickstart-body [data-qs-copy]').forEach(btn => {
      btn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(snippets[btn.dataset.qsCopy]);
          const toast = document.getElementById('device-qs-toast');
          toast.style.display = '';
          setTimeout(() => { toast.style.display = 'none'; }, 1500);
        } catch { alert('Copy failed'); }
      };
    });
    loading.style.display = 'none';
    body.style.display = '';
  } catch (e) {
    loading.style.display = 'none';
    err.textContent = 'Failed to provision key: ' + e.message;
    err.style.display = '';
  }
}

// ---- Init ----
refresh();
loadTokenData();
startTimer();
// reload charts when visible, and periodically
setInterval(() => { if (currentTab === 'usage') { loadOverview(); loadCharts(); } }, 30000);

// ── Mobile Touch Enhancements ──
function initMobileOptimizations() {
  // Detect if device supports touch
  const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  if (isTouchDevice) {
    document.body.classList.add('touch-device');

    // Add touch feedback for buttons
    document.addEventListener('touchstart', function(e) {
      if (e.target.classList.contains('btn') || e.target.classList.contains('top-tab')) {
        e.target.classList.add('touch-active');
      }
    });

    document.addEventListener('touchend', function(e) {
      if (e.target.classList.contains('btn') || e.target.classList.contains('top-tab')) {
        setTimeout(() => {
          e.target.classList.remove('touch-active');
        }, 150);
      }
    });
  }

  // Improve table horizontal scrolling
  const tableContainer = document.querySelector('.tbl-container');
  if (tableContainer) {
    let startX, scrollLeft;

    tableContainer.addEventListener('touchstart', function(e) {
      startX = e.touches[0].pageX - tableContainer.offsetLeft;
      scrollLeft = tableContainer.scrollLeft;
    });

    tableContainer.addEventListener('touchmove', function(e) {
      e.preventDefault();
      const x = e.touches[0].pageX - tableContainer.offsetLeft;
      const walk = (x - startX) * 2;
      tableContainer.scrollLeft = scrollLeft - walk;
    });

    // Check if table needs scroll indicator
    if (tableContainer.scrollWidth > tableContainer.clientWidth) {
      tableContainer.classList.add('scrollable');
    }
  }

  // Enhance mobile tab navigation
  const tabContainer = document.querySelector('.top-tabs');
  if (tabContainer && window.innerWidth <= 768) {
    // Enable smooth scrolling for tabs
    tabContainer.style.scrollBehavior = 'smooth';

    // Auto-scroll to active tab
    const activeTab = tabContainer.querySelector('.top-tab.active');
    if (activeTab) {
      activeTab.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center'
      });
    }
  }

  // Improve mobile form inputs
  const inputs = document.querySelectorAll('input[type="datetime-local"], input[type="number"], input[type="text"], select');
  inputs.forEach(input => {
    // Prevent zoom on iOS when focusing inputs
    if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
      input.style.fontSize = '16px';
    }

    // Add touch-friendly focus indicators
    input.addEventListener('focus', function() {
      this.parentElement.classList.add('input-focused');
    });

    input.addEventListener('blur', function() {
      this.parentElement.classList.remove('input-focused');
    });
  });

  // Mobile-optimized modal handling
  const modals = document.querySelectorAll('.modal-overlay');
  modals.forEach(modal => {
    modal.addEventListener('touchmove', function(e) {
      // Prevent body scroll when modal is open
      e.preventDefault();
    }, { passive: false });
  });

  // Enhance drawer behavior on mobile
  const drawer = document.querySelector('.drawer');
  if (drawer && window.innerWidth <= 768) {
    // Add swipe-to-close gesture
    let startY, startX;

    drawer.addEventListener('touchstart', function(e) {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    });

    drawer.addEventListener('touchmove', function(e) {
      if (!startX || !startY) return;

      const currentX = e.touches[0].clientX;
      const currentY = e.touches[0].clientY;
      const diffX = startX - currentX;
      const diffY = startY - currentY;

      // Horizontal swipe right to close
      if (Math.abs(diffX) > Math.abs(diffY) && diffX < -50) {
        closeDrawer();
      }
    });
  }
}

// ── Enhanced Mobile Chart Interactions ──
function enhanceChartTouch() {
  const chartScroll = document.querySelector('.chart-scroll');
  if (chartScroll && window.innerWidth <= 768) {
    let isScrolling = false;

    chartScroll.addEventListener('touchstart', function() {
      isScrolling = true;
    });

    chartScroll.addEventListener('touchend', function() {
      setTimeout(() => {
        isScrolling = false;
      }, 150);
    });

    // Improve chart tooltip behavior on touch
    const canvas = chartScroll.querySelector('canvas');
    if (canvas) {
      canvas.addEventListener('touchend', function(e) {
        if (!isScrolling) {
          // Show chart details on tap
          const rect = canvas.getBoundingClientRect();
          const x = e.changedTouches[0].clientX - rect.left;
          const y = e.changedTouches[0].clientY - rect.top;

          // Trigger tooltip at touch position
          if (window.showChartTooltip) {
            window.showChartTooltip(x, y);
          }
        }
      });
    }
  }
}

// ── Responsive Breakpoint Handling ──
function handleBreakpointChanges() {
  const mediaQuery = window.matchMedia('(max-width: 768px)');

  function handleBreakpoint(e) {
    const isMobile = e.matches;

    // Adjust table sticky header position

    // Re-initialize mobile features
    if (isMobile) {
      enhanceChartTouch();

      // Ensure active tab is visible
      const activeTab = document.querySelector('.top-tab.active');
      const tabContainer = document.querySelector('.top-tabs');
      if (activeTab && tabContainer) {
        setTimeout(() => {
          activeTab.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
            inline: 'center'
          });
        }, 100);
      }
    }
  }

  mediaQuery.addListener(handleBreakpoint);
  handleBreakpoint(mediaQuery);
}

// ── Initialize all mobile optimizations ──
document.addEventListener('DOMContentLoaded', function() {
  initMobileOptimizations();
  handleBreakpointChanges();
});

// Re-run mobile optimizations when tab content changes
const originalSwitchMainTab = switchMainTab;
switchMainTab = function(tab) {
  originalSwitchMainTab(tab);

  // Re-initialize mobile features for new tab content
  setTimeout(() => {
    initMobileOptimizations();
    if (window.innerWidth <= 768) {
      enhanceChartTouch();
    }
  }, 100);
};

// ─── v2 Keys tab (Stage 4: full-featured) ───────────────────────────────────
let v2Keys = [];
let v2SortCol = 'created_at';
let v2SortDir = 'desc';
let v2ExpandedHash = null;

async function v2LoadKeys() {
  const tbody = document.getElementById('keys-body');
  if (!tbody) return;
  try {
    const r = await fetch('/admin/keys', { credentials: 'include' });
    if (!r.ok) { tbody.innerHTML = `<tr><td colspan="11" style="color:var(--c-red);text-align:center">load failed: HTTP ${r.status}</td></tr>`; return; }
    const { keys } = await r.json();
    v2Keys = keys || [];
    v2RenderKeys();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="11" style="color:var(--c-red);text-align:center">${escapeHTML(e.message)}</td></tr>`;
  }
}

function escapeHTML(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

async function v2CreateKey() {
  // Legacy noop — Stage 4 uses v2SubmitCreateModal via the modal.
  v2OpenCreateModal();
}

function v2CopyNewKey() {
  const v = document.getElementById('v2-new-key-value').textContent;
  navigator.clipboard.writeText(v).then(() => { /* ok */ }, () => alert('copy failed'));
}

async function v2Topup(hash, name) { v2OpenTopupModal(hash, name); }

async function v2EditQuota(hash) { v2OpenQuotaModal(hash); }

async function v2ResetFree(hash) {
  if (!confirm('Reset free_used to 0?')) return;
  const r = await fetch(`/admin/keys/${hash}/reset-free`, { method: 'POST', credentials: 'include' });
  if (!r.ok) { alert('reset failed: HTTP ' + r.status); return; }
  v2LoadKeys();
}

async function v2Disable(hash) {
  if (!confirm('Disable this key? It will be rejected on subsequent requests.')) return;
  const r = await fetch(`/admin/keys/${hash}`, { method: 'DELETE', credentials: 'include' });
  if (!r.ok) { alert('disable failed: HTTP ' + r.status); return; }
  v2LoadKeys();
}

async function v2GrantPlan(hash, name) {
  const ans = prompt(`开通包月套餐给 "${name}"，输入天数 (默认 30):`, '30');
  if (ans === null) return;
  const days = Number(ans);
  if (!Number.isFinite(days) || days <= 0) { alert('invalid days'); return; }
  const r = await fetch(`/admin/keys/${hash}/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ plan_type: 'monthly_29', days }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { alert('grant failed: ' + (j.error || r.status)); return; }
  alert(`✓ 已开通 ${days} 天包月套餐`);
  v2LoadKeys();
}

async function v2CancelPlan(hash, name) {
  if (!confirm(`确认取消 "${name}" 的包月套餐？将立即降级为免费档。`)) return;
  const r = await fetch(`/admin/keys/${hash}/plan/cancel`, { method: 'POST', credentials: 'include' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { alert('cancel failed: ' + (j.error || r.status)); return; }
  alert('✓ 已取消包月套餐');
  v2LoadKeys();
}

function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function escapeAttr(s) { return String(s ?? '').replace(/'/g, '&#39;').replace(/"/g, '&quot;'); }

function v2SortKeys(col) {
  if (v2SortCol === col) v2SortDir = v2SortDir === 'asc' ? 'desc' : 'asc';
  else { v2SortCol = col; v2SortDir = 'asc'; }
  v2RenderKeys();
}

function v2RenderKeys() {
  const tbody = document.getElementById('keys-body');
  if (!tbody) return;
  const search = (document.getElementById('k-search')?.value || '').trim().toLowerCase();
  const fStatus = document.getElementById('k-status')?.value || '';
  const fRole = document.getElementById('k-role')?.value || '';
  const fUnlim = document.getElementById('k-unlim')?.value || '';

  let rows = v2Keys.filter(k => {
    if (search && !(k.name || '').toLowerCase().includes(search)) return false;
    if (fStatus && k.status !== fStatus) return false;
    if (fRole && k.role !== fRole) return false;
    if (fUnlim && String(k.unlimited ? 1 : 0) !== fUnlim) return false;
    return true;
  });

  rows.sort((a, b) => {
    let av = a[v2SortCol], bv = b[v2SortCol];
    if (av == null) av = '';
    if (bv == null) bv = '';
    if (typeof av === 'number' && typeof bv === 'number') return v2SortDir === 'asc' ? av - bv : bv - av;
    av = String(av); bv = String(bv);
    return v2SortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  document.querySelectorAll('#keys-tbl .sort-arrow').forEach(el => {
    el.textContent = el.dataset.col === v2SortCol ? (v2SortDir === 'asc' ? '▲' : '▼') : '';
  });

  setText('k-total', v2Keys.length);
  setText('k-active', v2Keys.filter(k => k.status === 'active').length);
  setText('k-unlimited', v2Keys.filter(k => k.unlimited).length);
  setText('k-disabled', v2Keys.filter(k => k.status !== 'active').length);
  setText('k-balance', fmt(v2Keys.reduce((s, k) => s + (k.balance_tokens || 0), 0)));

  if (!rows.length) { tbody.textContent = ''; const tr = document.createElement('tr'); tr.innerHTML = '<td colspan="11" style="text-align:center;color:var(--text-4);padding:20px">no keys match the filter</td>'; tbody.appendChild(tr); return; }

  const html = rows.map(k => {
    const free = k.unlimited ? '<span style="color:var(--accent-bright)">∞</span>' : `${fmt(k.free_used)} / ${fmt(k.free_quota)}`;
    const statusColor = k.status === 'active' ? 'var(--c-green)' : 'var(--c-red)';
    const expanded = v2ExpandedHash === k.key_hash;
    const nowSec = Math.floor(Date.now() / 1000);
    const planActive = k.plan_type && k.plan_type !== 'free' && Number(k.plan_expires_at || 0) > nowSec;
    let planCell;
    if (planActive) {
      const remainDays = Math.max(0, Math.ceil((Number(k.plan_expires_at) - nowSec) / 86400));
      planCell = `<span style="color:var(--accent-bright)">包月畅用</span><div style="font-size:10px;color:var(--text-4)">剩余 ${remainDays} 天</div>`;
    } else {
      planCell = `<span style="color:var(--text-4)">免费</span>`;
    }
    const planBtn = planActive
      ? `<button class="btn" onclick="v2CancelPlan('${k.key_hash}','${escapeAttr(k.name)}')"><i data-lucide="alarm-clock" class="lucide-icon"></i> 取消月卡</button>`
      : `<button class="btn" onclick="v2GrantPlan('${k.key_hash}','${escapeAttr(k.name)}')"><i data-lucide="gift" class="lucide-icon"></i> 开通月卡</button>`;
    const main = `<tr class="keys-row" data-hash="${k.key_hash}" style="cursor:pointer" onclick="v2ToggleExpand('${k.key_hash}', event)">
        <td>${k.wx && (k.wx.nickname || k.wx.avatar_url) ? `${k.wx.avatar_url ? `<img src="${escapeAttr(k.wx.avatar_url)}" referrerpolicy="no-referrer" style="width:18px;height:18px;border-radius:50%;vertical-align:middle;margin-right:4px;object-fit:cover">` : ''}<span style="vertical-align:middle">${escapeHTML(k.wx.nickname || k.name || '-')}</span><div style="font-size:10px;color:var(--text-4);margin-top:2px">${escapeHTML(k.name || '-')}</div>` : escapeHTML(k.name || '-')}${k.note ? `<div style="font-size:10px;color:var(--text-4)">${escapeHTML(k.note)}</div>` : ''}</td>
        <td><code style="font-size:11px">${escapeHTML(k.key_prefix || '')}…</code></td>
        <td>${k.role}</td>
        <td><span style="color:${statusColor}">${k.status}</span></td>
        <td>${k.unlimited ? 'yes' : 'no'}</td>
        <td>${free}</td>
        <td>${fmt(k.balance_tokens || 0)}</td>
        <td>${planCell}</td>
        <td style="font-size:11px;color:var(--text-4)">${escapeHTML(k.last_used_at || '-')}</td>
        <td style="font-size:11px;color:var(--text-4)">${escapeHTML((k.created_at || '').slice(0, 16))}</td>
        <td style="white-space:nowrap" onclick="event.stopPropagation()">
          <button class="btn" onclick="v2OpenTopupModal('${k.key_hash}','${escapeAttr(k.name)}')">Topup</button>
          ${k.status === 'active' ? `<button class="btn" onclick="v2Disable('${k.key_hash}')">Disable</button>` : `<button class="btn on" onclick="v2Enable('${k.key_hash}')">Enable</button>`}
          <button class="btn" title="Manage" onclick="v2OpenManageModal('${k.key_hash}')"><i data-lucide="settings" class="lucide-icon"></i></button>
        </td>
      </tr>`;
    if (!expanded) return main;
    return main + `<tr class="keys-expand"><td colspan="11" id="ledger-${k.key_hash}" style="padding:10px 14px;background:rgba(255,255,255,.02)">Loading ledger…</td></tr>`;
  }).join('');
  tbody.innerHTML = html;

  if (v2ExpandedHash) v2LoadLedger(v2ExpandedHash);
  if (window.lucide) lucide.createIcons();
}

function v2ToggleExpand(hash, ev) {
  if (ev && ev.target && ev.target.tagName === 'BUTTON') return;
  v2ExpandedHash = (v2ExpandedHash === hash) ? null : hash;
  v2RenderKeys();
}

async function v2LoadLedger(hash) {
  const cell = document.getElementById('ledger-' + hash);
  if (!cell) return;
  try {
    const r = await fetch(`/admin/keys/${hash}/ledger?limit=20`, { credentials: 'include' });
    if (!r.ok) { cell.textContent = `ledger HTTP ${r.status}`; return; }
    const { ledger } = await r.json();
    if (!ledger || !ledger.length) { cell.textContent = 'no ledger entries'; return; }
    cell.innerHTML = `<div style="font-size:11px;color:var(--text-4);margin-bottom:6px">Last ${ledger.length} ledger entries</div>
      <table class="tbl" style="font-size:11px">
        <thead><tr><th>Time</th><th>Model</th><th>Input</th><th>Output</th><th>Cost</th><th>Source</th></tr></thead>
        <tbody>${ledger.map(l => `<tr><td>${escapeHTML(l.ts || '')}</td><td>${escapeHTML(l.model || '-')}</td><td>${fmt(l.input_tokens || 0)}</td><td>${fmt(l.output_tokens || 0)}</td><td>${fmt(l.cost_tokens || 0)}</td><td>${escapeHTML(l.source || '-')}</td></tr>`).join('')}</tbody>
      </table>`;
  } catch (e) { cell.textContent = 'error: ' + e.message; }
}

// ── Modals (Stage 4) ───────────────────────────────────────────────────────
function v2OpenCreateModal() {
  document.getElementById('v2c-name').value = '';
  document.getElementById('v2c-role').value = 'user';
  document.getElementById('v2c-free').value = 10000;
  document.getElementById('v2c-balance').value = 0;
  document.getElementById('v2c-unlimited').value = '0';
  document.getElementById('v2c-models').value = '';
  document.getElementById('v2c-note').value = '';
  document.getElementById('v2-create-modal').classList.add('open');
}
function v2CloseCreateModal() { document.getElementById('v2-create-modal').classList.remove('open'); }

async function v2SubmitCreateModal() {
  const name = document.getElementById('v2c-name').value.trim();
  if (!name) { alert('name required'); return; }
  const modelsRaw = document.getElementById('v2c-models').value.trim();
  const allowed_models = modelsRaw ? modelsRaw.split(',').map(s => s.trim()).filter(Boolean) : null;
  const body = {
    name,
    role: document.getElementById('v2c-role').value,
    free_quota: Number(document.getElementById('v2c-free').value) || 0,
    balance_tokens: Number(document.getElementById('v2c-balance').value) || 0,
    unlimited: document.getElementById('v2c-unlimited').value === '1',
    allowed_models,
    note: document.getElementById('v2c-note').value.trim() || null,
  };
  const r = await fetch('/admin/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { alert('create failed: ' + (j.error || r.status)); return; }
  v2CloseCreateModal();
  document.getElementById('v2-new-key-value').textContent = j.key;
  document.getElementById('v2-new-key-banner').style.display = 'block';
  v2LoadKeys();
}

function v2OpenQuotaModal(hash) {
  const k = v2Keys.find(x => x.key_hash === hash);
  if (!k) return;
  document.getElementById('v2q-hash').value = hash;
  document.getElementById('v2q-free').value = k.free_quota || 0;
  document.getElementById('v2q-models').value = (k.allowed_models || []).join(', ');
  document.getElementById('v2q-note').value = k.note || '';
  document.getElementById('v2-quota-modal').classList.add('open');
}
function v2CloseQuotaModal() { document.getElementById('v2-quota-modal').classList.remove('open'); }

async function v2SubmitQuotaModal() {
  const hash = document.getElementById('v2q-hash').value;
  const modelsRaw = document.getElementById('v2q-models').value.trim();
  const body = {
    free_quota: Number(document.getElementById('v2q-free').value) || 0,
    allowed_models: modelsRaw ? modelsRaw.split(',').map(s => s.trim()).filter(Boolean) : null,
    note: document.getElementById('v2q-note').value.trim() || null,
  };
  const r = await fetch(`/admin/keys/${hash}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
  if (!r.ok) { alert('save failed: HTTP ' + r.status); return; }
  v2CloseQuotaModal();
  v2LoadKeys();
}

function v2OpenTopupModal(hash, name) {
  document.getElementById('v2t-hash').value = hash;
  document.getElementById('v2t-name').textContent = name;
  document.getElementById('v2t-tokens').value = 10000;
  document.getElementById('v2-topup-modal').classList.add('open');
}
function v2CloseTopupModal() { document.getElementById('v2-topup-modal').classList.remove('open'); }

async function v2SubmitTopupModal() {
  const hash = document.getElementById('v2t-hash').value;
  const tokens = Number(document.getElementById('v2t-tokens').value);
  if (!Number.isFinite(tokens) || tokens <= 0) { alert('invalid amount'); return; }
  const r = await fetch(`/admin/keys/${hash}/topup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ tokens }) });
  if (!r.ok) { alert('topup failed: HTTP ' + r.status); return; }
  v2CloseTopupModal();
  v2LoadKeys();
}

async function v2ToggleUnlimited(hash, current) {
  const next = current ? 0 : 1;
  const r = await fetch(`/admin/keys/${hash}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ unlimited: next }) });
  if (!r.ok) { alert('toggle failed: HTTP ' + r.status); return; }
  v2LoadKeys();
}

async function v2Enable(hash) {
  const r = await fetch(`/admin/keys/${hash}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ status: 'active' }) });
  if (!r.ok) { alert('enable failed: HTTP ' + r.status); return; }
  v2LoadKeys();
}

// ── Manage Key Modal ──────────────────────────────────────────────────────
function v2OpenManageModal(hash) {
  const k = v2Keys.find(x => x.key_hash === hash);
  if (!k) return;
  document.getElementById('v2m-hash').value = hash;
  document.getElementById('v2m-prefix').textContent = (k.key_prefix || '') + '…';
  document.getElementById('v2m-name').value = k.name || '';
  document.getElementById('v2m-note').value = k.note || '';
  document.getElementById('v2m-role').value = k.role || 'user';
  v2mRefreshDynamic(k);
  document.getElementById('v2-manage-modal').classList.add('open');
}
function v2CloseManageModal() { document.getElementById('v2-manage-modal').classList.remove('open'); }

function v2mRefreshDynamic(k) {
  const freeTxt = k.unlimited
    ? '∞ (unlimited)'
    : `${fmt(k.free_used || 0)} / ${fmt(k.free_quota || 0)}`;
  document.getElementById('v2m-free-display').textContent = freeTxt;

  document.getElementById('v2m-unlim-display').textContent = k.unlimited ? 'YES — bypasses quota' : 'no';
  const ub = document.getElementById('v2m-unlim-btn');
  ub.textContent = k.unlimited ? 'Disable Unlim' : 'Enable Unlim';

  const nowSec = Math.floor(Date.now() / 1000);
  const planActive = k.plan_type && k.plan_type !== 'free' && Number(k.plan_expires_at || 0) > nowSec;
  const pd = document.getElementById('v2m-plan-display');
  const pb = document.getElementById('v2m-plan-btn');
  pd.textContent = '';
  if (planActive) {
    const remainDays = Math.max(0, Math.ceil((Number(k.plan_expires_at) - nowSec) / 86400));
    const span = document.createElement('span');
    span.style.color = 'var(--accent-bright)';
    span.textContent = '包月畅用';
    pd.appendChild(span);
    pd.appendChild(document.createTextNode(` · 剩余 ${remainDays} 天`));
    pb.innerHTML = '<i data-lucide="alarm-clock" class="lucide-icon"></i> 取消月卡';
    pb.dataset.action = 'cancel';
  } else {
    pd.textContent = '免费档';
    pb.innerHTML = '<i data-lucide="gift" class="lucide-icon"></i> 开通月卡';
    pb.dataset.action = 'grant';
  }
  if (window.lucide) lucide.createIcons();
}

async function v2mReloadCurrent() {
  const hash = document.getElementById('v2m-hash').value;
  if (!hash) return;
  await v2LoadKeys();
  const k = v2Keys.find(x => x.key_hash === hash);
  if (k) v2mRefreshDynamic(k);
}

async function v2mResetFree() {
  const hash = document.getElementById('v2m-hash').value;
  if (!confirm('Reset free_used to 0?')) return;
  const r = await fetch(`/admin/keys/${hash}/reset-free`, { method: 'POST', credentials: 'include' });
  if (!r.ok) { alert('reset failed: HTTP ' + r.status); return; }
  await v2mReloadCurrent();
}

async function v2mToggleUnlim() {
  const hash = document.getElementById('v2m-hash').value;
  const k = v2Keys.find(x => x.key_hash === hash);
  if (!k) return;
  const next = k.unlimited ? 0 : 1;
  const r = await fetch(`/admin/keys/${hash}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ unlimited: next }) });
  if (!r.ok) { alert('toggle failed: HTTP ' + r.status); return; }
  await v2mReloadCurrent();
}

async function v2mPlanAction() {
  const hash = document.getElementById('v2m-hash').value;
  const k = v2Keys.find(x => x.key_hash === hash);
  if (!k) return;
  const action = document.getElementById('v2m-plan-btn').dataset.action;
  if (action === 'cancel') {
    if (!confirm(`确认取消 "${k.name}" 的包月套餐？将立即降级为免费档。`)) return;
    const r = await fetch(`/admin/keys/${hash}/plan/cancel`, { method: 'POST', credentials: 'include' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { alert('cancel failed: ' + (j.error || r.status)); return; }
  } else {
    const ans = prompt(`开通包月套餐给 "${k.name}"，输入天数 (默认 30):`, '30');
    if (ans === null) return;
    const days = Number(ans);
    if (!Number.isFinite(days) || days <= 0) { alert('invalid days'); return; }
    const r = await fetch(`/admin/keys/${hash}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ plan_type: 'monthly_29', days }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { alert('grant failed: ' + (j.error || r.status)); return; }
  }
  await v2mReloadCurrent();
}

async function v2mHardDelete() {
  const hash = document.getElementById('v2m-hash').value;
  const k = v2Keys.find(x => x.key_hash === hash);
  if (!k) return;
  if (!confirm(`PERMANENTLY delete key "${k.name}"?\n\nThis removes the key row and its usage ledger. Cannot be undone.`)) return;
  const typed = prompt(`Type the key name to confirm deletion:`);
  if (typed !== k.name) { alert('name did not match; aborted'); return; }
  const r = await fetch(`/admin/keys/${hash}?hard=1`, { method: 'DELETE', credentials: 'include' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { alert('delete failed: ' + (j.error || r.status)); return; }
  v2CloseManageModal();
  v2LoadKeys();
}

async function v2SubmitManageModal() {
  const hash = document.getElementById('v2m-hash').value;
  const k = v2Keys.find(x => x.key_hash === hash);
  if (!k) return;
  const name = document.getElementById('v2m-name').value.trim();
  if (!name) { alert('name required'); return; }
  const note = document.getElementById('v2m-note').value.trim();
  const role = document.getElementById('v2m-role').value;
  const patch = {};
  if (name !== (k.name || '')) patch.name = name;
  if (note !== (k.note || '')) patch.note = note || null;
  if (role !== k.role) patch.role = role;
  if (!Object.keys(patch).length) { v2CloseManageModal(); return; }
  const r = await fetch(`/admin/keys/${hash}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(patch) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { alert('save failed: ' + (j.error || r.status)); return; }
  v2CloseManageModal();
  v2LoadKeys();
}

// ─── Usage Overview tab ─────────────────────────────────────────────────────
function _ovRange() {
  const r = document.getElementById('ov-range').value;
  const showCustom = (r === 'custom');
  document.getElementById('ov-from').style.display = showCustom ? '' : 'none';
  document.getElementById('ov-to').style.display = showCustom ? '' : 'none';
  document.getElementById('ov-tilde').style.display = showCustom ? '' : 'none';
  if (showCustom) {
    return {
      from: (document.getElementById('ov-from').value || '').replace('T', ' ') || null,
      to: (document.getElementById('ov-to').value || '').replace('T', ' ') || null,
    };
  }
  const now = new Date();
  let from = null;
  if (r === 'today') from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  else if (r === '7d') { from = new Date(now); from.setDate(now.getDate() - 7); }
  else if (r === '30d') { from = new Date(now); from.setDate(now.getDate() - 30); }
  return { from: from ? from.toISOString().replace('T', ' ').slice(0, 19) : null, to: null };
}

async function loadOverview() {
  const { from, to } = _ovRange();
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  try {
    const r = await fetch('/admin/overview?' + qs.toString(), { credentials: 'include' });
    if (!r.ok) { alert('overview HTTP ' + r.status); return; }
    const j = await r.json();
    const t = j.totals || {};
    setText('ov-req', fmt(t.requests || 0));
    setText('ov-input', fmt(t.input_tokens || 0));
    setText('ov-output', fmt(t.output_tokens || 0));
    setText('ov-cost', fmt(t.cost || 0));

    const byKeyRows = (j.byKey || []).slice(0, 50).map(k => `<tr><td>${escapeHTML(k.name || '(unknown)')}</td><td>${fmt(k.requests)}</td><td>${fmt(k.input_tokens)}</td><td>${fmt(k.output_tokens)}</td><td>${fmt(k.cost)}</td></tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text-4)">no data</td></tr>';
    document.getElementById('ov-bykey').innerHTML = byKeyRows;

    const byModelRows = (j.byModel || []).map(m => `<tr><td>${escapeHTML(m.model || '-')}</td><td>${fmt(m.requests)}</td><td>${fmt(m.input_tokens)}</td><td>${fmt(m.output_tokens)}</td><td>${fmt(m.cost)}</td><td>${fmt(m.avg_cost)}</td></tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text-4)">no data</td></tr>';
    document.getElementById('ov-bymodel').innerHTML = byModelRows;

    const daily = j.daily || [];
    drawDailyCostChart(daily);
    if (window.lucide) lucide.createIcons();
  } catch (e) { alert('overview failed: ' + e.message); }
}

function drawDailyCostChart(daily) {
  const canvas = document.getElementById('chart-daily-cost');
  if (!canvas) return;
  const cssW = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
  const cssH = 200;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  if (!daily.length) {
    ctx.font = '12px Inter, system-ui';
    ctx.fillStyle = COLORS.label;
    ctx.textAlign = 'center';
    ctx.fillText('no data', cssW / 2, cssH / 2);
    return;
  }

  const pad = { l: 44, r: 12, t: 14, b: 22 };
  const innerW = cssW - pad.l - pad.r;
  const innerH = cssH - pad.t - pad.b;
  const maxCost = Math.max(1, ...daily.map(d => Number(d.cost) || 0));
  const n = daily.length;
  const xAt = i => pad.l + (n === 1 ? innerW / 2 : (innerW * i) / (n - 1));
  const yAt = v => pad.t + innerH * (1 - v / maxCost);

  ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (innerH * i) / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(cssW - pad.r, y); ctx.stroke();
    ctx.font = '10px Inter, system-ui';
    ctx.fillStyle = COLORS.label;
    ctx.textAlign = 'right';
    ctx.fillText(fmt(Math.round(maxCost * (1 - i / 4))), pad.l - 6, y + 3);
  }

  ctx.strokeStyle = COLORS.accent; ctx.lineWidth = 2; ctx.beginPath();
  daily.forEach((d, i) => {
    const x = xAt(i), y = yAt(Number(d.cost) || 0);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + innerH);
  grad.addColorStop(0, 'rgba(113,112,255,0.25)');
  grad.addColorStop(1, 'rgba(113,112,255,0)');
  ctx.fillStyle = grad; ctx.beginPath();
  ctx.moveTo(xAt(0), pad.t + innerH);
  daily.forEach((d, i) => ctx.lineTo(xAt(i), yAt(Number(d.cost) || 0)));
  ctx.lineTo(xAt(n - 1), pad.t + innerH);
  ctx.closePath(); ctx.fill();

  ctx.fillStyle = COLORS.accent;
  daily.forEach((d, i) => {
    ctx.beginPath();
    ctx.arc(xAt(i), yAt(Number(d.cost) || 0), 2.5, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.font = '10px Inter, system-ui';
  ctx.fillStyle = COLORS.label;
  ctx.textAlign = 'center';
  const stride = Math.max(1, Math.ceil(n / 8));
  daily.forEach((d, i) => {
    if (i % stride !== 0 && i !== n - 1) return;
    ctx.fillText((d.day || '').slice(5), xAt(i), cssH - 6);
  });
}

// ─── Models tab ─────────────────────────────────────────────────────────────
function _toast(msg, kind) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = `position:fixed;top:20px;right:20px;padding:10px 14px;border-radius:6px;font-size:13px;z-index:9999;background:${kind==='err'?'#b22':'#1c5'};color:#fff;box-shadow:0 4px 12px rgba(0,0,0,.3)`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

function _setHTML(el, html) { el.innerHTML = html; }

async function loadModels() {
  const tbody = document.getElementById('models-body');
  if (!tbody) return;
  try {
    const r = await fetch('/admin/models', { credentials: 'include' });
    if (!r.ok) { _setHTML(tbody, `<tr><td colspan="8" style="color:var(--c-red);text-align:center">HTTP ${r.status}</td></tr>`); return; }
    const j = await r.json();
    const lastEl = document.getElementById('models-last-synced');
    if (lastEl) {
      lastEl.textContent = j.last_synced_at ? `Last synced: ${new Date(j.last_synced_at).toLocaleString()}` : 'Never synced';
    }
    const rows = j.models || [];
    if (!rows.length) {
      _setHTML(tbody, '<tr><td colspan="8" style="text-align:center;color:var(--text-4)">no models — click <i data-lucide="refresh-cw" class="lucide-icon"></i> to sync from upstream</td></tr>');
      return;
    }
    const def = j.default_pricing || { input_multiplier: 1, output_multiplier: 5 };
    const html = rows.map(m => {
      const safeId = m.id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const p = m.pricing || def;
      const previewBadge = m.preview ? '<span style="background:#d80;color:#fff;padding:1px 6px;border-radius:3px;font-size:10px">PREVIEW</span>' : '';
      const enabledChecked = m.enabled ? 'checked' : '';
      return `<tr>
        <td><code style="font-size:11px">${escapeHTML(m.id)}</code></td>
        <td>${escapeHTML(m.vendor || m.provider || '-')}</td>
        <td><input type="text" id="md-name-${safeId}" value="${escapeAttr(m.display_name || '')}" class="token-input" style="width:100%;min-width:180px"></td>
        <td>${previewBadge}</td>
        <td><label style="cursor:pointer"><input type="checkbox" id="md-en-${safeId}" ${enabledChecked} onchange="setModelEnabled('${escapeAttr(m.id)}', this.checked)"></label></td>
        <td><input type="number" id="md-in-${safeId}" value="${p.input_multiplier}" step="0.01" min="0" class="token-input" style="width:100px"></td>
        <td><input type="number" id="md-out-${safeId}" value="${p.output_multiplier}" step="0.01" min="0" class="token-input" style="width:100px"></td>
        <td style="white-space:nowrap">
          <button class="btn on" onclick="saveModelRow('${escapeAttr(m.id)}','${safeId}')">Save</button>
          <button class="btn" onclick="testModelRow('${escapeAttr(m.id)}','${safeId}')" id="md-test-${safeId}">Test</button>
          <span id="md-test-result-${safeId}" style="margin-left:6px;font-size:11px"></span>
          ${m.enabled ? '' : `<button class="btn" onclick="deleteModelRow('${escapeAttr(m.id)}')">Delete</button>`}
        </td>
      </tr>`;
    }).join('');
    _setHTML(tbody, html);
    if (window.lucide) lucide.createIcons();
  } catch (e) {
    _setHTML(tbody, `<tr><td colspan="8" style="color:var(--c-red);text-align:center">${escapeHTML(e.message)}</td></tr>`);
  }
}

async function syncModelsFromUpstream() {
  const btn = document.getElementById('models-sync-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader" class="lucide-icon"></i> 同步中…'; if (window.lucide) lucide.createIcons(); }
  try {
    const r = await fetch('/admin/models/sync', { method: 'POST', credentials: 'include' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      _toast(`同步失败: ${j.error || 'HTTP ' + r.status}`, 'err');
    } else {
      _toast(`✓ 新增 ${j.added} / 更新 ${j.updated} (共 ${j.total})`, 'ok');
      await loadModels();
    }
  } catch (e) {
    _toast(`同步失败: ${e.message}`, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="refresh-cw" class="lucide-icon"></i> 刷新模型列表'; if (window.lucide) lucide.createIcons(); }
  }
}

async function setModelEnabled(modelId, enabled) {
  const r = await fetch(`/admin/models/${encodeURIComponent(modelId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); _toast(`update failed: ${j.error || r.status}`, 'err'); loadModels(); return; }
  _toast(enabled ? `✓ enabled ${modelId}` : `✓ disabled ${modelId}`, 'ok');
  loadModels();
}

async function saveModelRow(modelId, safeId) {
  const display_name = document.getElementById(`md-name-${safeId}`).value.trim();
  const input_multiplier = Number(document.getElementById(`md-in-${safeId}`).value);
  const output_multiplier = Number(document.getElementById(`md-out-${safeId}`).value);
  const r = await fetch(`/admin/models/${encodeURIComponent(modelId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ display_name, input_multiplier, output_multiplier }),
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); _toast(`save failed: ${j.error || r.status}`, 'err'); return; }
  _toast(`✓ saved ${modelId}`, 'ok');
  loadModels();
}

async function testModelRow(modelId, safeId) {
  const btn = document.getElementById(`md-test-${safeId}`);
  const out = document.getElementById(`md-test-result-${safeId}`);
  if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader" class="lucide-icon"></i>'; if (window.lucide) lucide.createIcons(); }
  if (out) { out.textContent = ''; out.style.color = ''; }
  try {
    const r = await fetch(`/admin/models/${encodeURIComponent(modelId)}/test`, {
      method: 'POST', credentials: 'include',
    });
    const j = await r.json().catch(() => ({}));
    if (out) {
      if (j.ok) {
        out.style.color = 'var(--c-green, #2a8)';
        out.textContent = `✓ ${j.latency_ms}ms${j.sample ? ` — ${j.sample.replace(/\s+/g, ' ').slice(0, 40)}` : ''}`;
        out.title = j.sample || '';
      } else {
        out.style.color = 'var(--c-red, #d33)';
        const err = (j.error || `HTTP ${j.status || r.status}`).toString();
        out.textContent = `✗ ${err.slice(0, 60)}`;
        out.title = err;
      }
    }
  } catch (e) {
    if (out) { out.style.color = 'var(--c-red, #d33)'; out.textContent = `✗ ${e.message}`; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Test'; }
  }
}

async function deleteModelRow(modelId) {
  if (!confirm(`Delete "${modelId}"? Only disabled models can be deleted.`)) return;
  const r = await fetch(`/admin/models/${encodeURIComponent(modelId)}`, { method: 'DELETE', credentials: 'include' });
  if (!r.ok) { const j = await r.json().catch(() => ({})); _toast(`delete failed: ${j.error || r.status}`, 'err'); return; }
  _toast(`✓ deleted ${modelId}`, 'ok');
  loadModels();
}

// ─── Audit tab ──────────────────────────────────────────────────────────────
let auditData = [];
async function loadAudit() {
  const tbody = document.getElementById('audit-body');
  if (!tbody) return;
  try {
    const r = await fetch('/admin/audit?limit=500', { credentials: 'include' });
    if (!r.ok) { tbody.innerHTML = `<tr><td colspan="5" style="color:var(--c-red);text-align:center">HTTP ${r.status}</td></tr>`; return; }
    const { actions } = await r.json();
    auditData = actions || [];
    renderAudit();
  } catch (e) { tbody.innerHTML = `<tr><td colspan="5" style="color:var(--c-red);text-align:center">${escapeHTML(e.message)}</td></tr>`; }
}

function renderAudit() {
  const tbody = document.getElementById('audit-body');
  if (!tbody) return;
  const f = (document.getElementById('audit-filter')?.value || '').trim().toLowerCase();
  const rows = auditData.filter(a => {
    if (!f) return true;
    return [a.action, a.target, a.admin_name, a.payload].some(x => (x || '').toString().toLowerCase().includes(f));
  });
  setText('audit-count', `${rows.length} / ${auditData.length}`);
  tbody.innerHTML = rows.map(a => `<tr>
    <td style="font-size:11px">${escapeHTML(a.ts || '')}</td>
    <td>${escapeHTML(a.admin_name || '-')}</td>
    <td><code style="color:var(--accent-bright);font-size:11px">${escapeHTML(a.action || '')}</code></td>
    <td style="font-size:11px;font-family:monospace">${escapeHTML((a.target || '-').slice(0, 40))}${a.target && a.target.length > 40 ? '…' : ''}</td>
    <td style="font-size:11px;color:var(--text-3)"><code style="word-break:break-all">${escapeHTML(a.payload || '')}</code></td>
  </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text-4)">no audit entries</td></tr>';
}

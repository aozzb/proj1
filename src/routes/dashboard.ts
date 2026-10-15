import { Router } from 'express';

export const dashboardRouter = Router();

/**
 * GET /dashboard — a deliberately minimal single-page dashboard (vanilla JS, no
 * build step, no external libs). You paste an API key, it lists the app's
 * deliveries, lets you expand one to see its attempts, and replays dead/failed
 * ones. The dashboard is not the focus of the project; it just makes the status
 * API visible.
 */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Webhook Deliveries</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 1.5rem; max-width: 1000px; }
  h1 { font-size: 1.3rem; }
  .bar { display: flex; gap: .5rem; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; }
  input, select, button { padding: .4rem .5rem; font-size: .9rem; }
  input#key { flex: 1; min-width: 240px; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  th, td { border: 1px solid #8884; padding: .35rem .5rem; text-align: left; vertical-align: top; }
  th { background: #8881; }
  td.status { font-weight: 600; }
  .pending { color: #b58900; } .succeeded { color: #2a2; }
  .failed { color: #c33; } .dead { color: #a00; }
  button.replay { cursor: pointer; }
  pre { margin: .3rem 0; white-space: pre-wrap; word-break: break-word; font-size: .8rem; }
  .muted { opacity: .7; }
  .err { color: #c33; margin: .5rem 0; }
</style>
</head>
<body>
<h1>Webhook Deliveries</h1>
<div class="bar">
  <input id="key" type="password" placeholder="API key (whsk_...)" />
  <select id="status">
    <option value="">all</option>
    <option value="pending">pending</option>
    <option value="succeeded">succeeded</option>
    <option value="failed">failed</option>
    <option value="dead">dead</option>
  </select>
  <button id="load">Load</button>
  <span id="count" class="muted"></span>
</div>
<div id="error" class="err"></div>
<table>
  <thead><tr><th>status</th><th>attempts</th><th>last error</th><th>updated</th><th>id</th><th></th></tr></thead>
  <tbody id="rows"></tbody>
</table>

<script>
  const $ = (id) => document.getElementById(id);
  // Convenience only: remember the key in this browser. Never sent anywhere but this API.
  try { $('key').value = localStorage.getItem('wh_key') || ''; } catch (e) {}

  function headers() { return { 'authorization': 'Bearer ' + $('key').value.trim() }; }
  function esc(s) { return String(s ?? '').replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

  async function load() {
    $('error').textContent = '';
    try { localStorage.setItem('wh_key', $('key').value.trim()); } catch (e) {}
    const status = $('status').value;
    const url = '/deliveries' + (status ? '?status=' + encodeURIComponent(status) : '');
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) { $('error').textContent = 'Error ' + res.status + ' (check API key)'; return; }
    const { deliveries } = await res.json();
    $('count').textContent = deliveries.length + ' shown';
    $('rows').innerHTML = deliveries.map(rowHtml).join('');
  }

  function rowHtml(d) {
    const canReplay = d.status === 'dead' || d.status === 'failed';
    return '<tr>'
      + '<td class="status ' + d.status + '">' + d.status + '</td>'
      + '<td>' + d.attempts_count + '</td>'
      + '<td>' + esc(d.last_error || '') + '</td>'
      + '<td class="muted">' + esc(d.updated_at) + '</td>'
      + '<td><a href="#" data-id="' + d.id + '" class="details">' + d.id.slice(0, 8) + '…</a></td>'
      + '<td>' + (canReplay ? '<button class="replay" data-id="' + d.id + '">Replay</button>' : '') + '</td>'
      + '</tr>'
      + '<tr id="det-' + d.id + '"></tr>';
  }

  document.addEventListener('click', async (ev) => {
    const t = ev.target;
    if (t.classList.contains('replay')) {
      ev.preventDefault();
      t.disabled = true; t.textContent = '...';
      const res = await fetch('/deliveries/' + t.dataset.id + '/replay', { method: 'POST', headers: headers() });
      if (!res.ok) { $('error').textContent = 'Replay failed: ' + res.status; t.disabled = false; t.textContent = 'Replay'; return; }
      setTimeout(load, 800);
    }
    if (t.classList.contains('details')) {
      ev.preventDefault();
      const cell = $('det-' + t.dataset.id);
      if (cell.innerHTML) { cell.innerHTML = ''; return; }
      const res = await fetch('/deliveries/' + t.dataset.id, { headers: headers() });
      if (!res.ok) { $('error').textContent = 'Error ' + res.status; return; }
      const d = await res.json();
      const att = (d.attempts || []).map((a) =>
        '#' + a.attempt_number + ' code=' + (a.status_code ?? 'ERR')
        + ' ' + (a.latency_ms ?? '-') + 'ms ' + esc(a.error || a.response_snippet || '')).join('\\n');
      cell.innerHTML = '<td colspan="6"><pre>url: ' + esc(d.endpoint_url) + '  type: ' + esc(d.event_type)
        + '\\n' + (att || 'no attempts yet') + '</pre></td>';
    }
  });

  $('load').addEventListener('click', load);
  $('key').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
</script>
</body>
</html>`;

dashboardRouter.get('/dashboard', (_req, res) => {
  res.type('html').send(PAGE);
});

const fs = require('fs');
const path = require('path');

const dataFile = path.join(__dirname, 'scanner-results.json');
const outFile = path.join(__dirname, 'report.html');

if (!fs.existsSync(dataFile)) {
  console.error('scanner-results.json not found. Run scanner.js first.');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const dataJson = JSON.stringify(data);

const ts = new Date(data.timestamp);
const dateStr = ts.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const timeStr = ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });

const tradeCount = data.summary.trade_candidates;
const watchCount = data.summary.watch_candidates;
const totalCount = data.summary.total_candidates;
const multiCount = data.summary.multi_scan_hits;

const topSectors    = data.top_sectors || [];
const sectorRankings = data.sector_rankings || [];

const bearish = data.stocks.filter(s => s.verdict !== 'SKIP' && s.macd_status === 'BEARISH').length;
const actionable = data.stocks.filter(s => s.verdict !== 'SKIP').length;
const macdWarning = bearish > 0
  ? `<div class="warn-bar">&#9888; MACD Headwind: ${bearish} of ${actionable} actionable candidates show BEARISH MACD momentum</div>`
  : '';

function fmtPct(n) {
  if (n == null) return 'N/A';
  return (n >= 0 ? '+' : '') + Number(n).toFixed(1) + '%';
}

const selectedSet = new Set(topSectors.map(s => s.sector));

const sectorPillsHtml = sectorRankings.map(s => {
  const isSel = selectedSet.has(s.sector);
  const wCol  = s.perf_w  >= 0 ? '#3fb950' : '#f85149';
  const mCol  = s.perf_1m >= 0 ? '#3fb950' : '#f85149';
  return `<div class="sector-pill ${isSel ? 'selected' : 'not-selected'}">
    ${isSel ? '<span class="sp-selected-badge">FOCUS</span>' : ''}
    <div class="sp-rank">#${s.rank} ${isSel ? '&#9733; Selected' : ''}</div>
    <div class="sp-name">${s.sector}</div>
    <div class="sp-etf">${s.etf}</div>
    <div class="sp-perf">
      <span style="color:${wCol}">${fmtPct(s.perf_w)}W</span>
      <span style="color:${mCol}">${fmtPct(s.perf_1m)}M</span>
      ${s.rsi != null ? `<span style="color:var(--muted)">RSI ${Math.round(s.rsi)}</span>` : ''}
    </div>
  </div>`;
}).join('');

const sectorPanelHtml = sectorRankings.length > 0
  ? `<div class="sector-panel">
    <div class="sector-panel-title">&#127362; Sector Momentum — Top ${topSectors.length} Selected as Focus</div>
    <div class="sector-pills">${sectorPillsHtml}</div>
  </div>`
  : '';

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trading Scanner &mdash; ${dateStr}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface2: #21262d;
    --border: #30363d;
    --text: #e6edf3;
    --muted: #8b949e;
    --green: #3fb950;
    --red: #f85149;
    --yellow: #e3b341;
    --blue: #58a6ff;
    --purple: #bc8cff;
    --orange: #ffa657;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.5; }
  a { color: var(--blue); text-decoration: none; }
  a:hover { text-decoration: underline; }

  .header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 20px 28px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .header-left h1 { font-size: 20px; font-weight: 700; }
  .header-left .subtitle { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .header-stats { display: flex; gap: 16px; flex-wrap: wrap; }
  .stat-pill { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 16px; text-align: center; min-width: 68px; }
  .stat-pill .val { font-size: 24px; font-weight: 700; line-height: 1; }
  .stat-pill .lbl { font-size: 11px; color: var(--muted); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-pill.green .val { color: var(--green); }
  .stat-pill.yellow .val { color: var(--yellow); }
  .stat-pill.blue .val { color: var(--blue); }

  .warn-bar { background: rgba(248,81,73,0.1); border-bottom: 1px solid rgba(248,81,73,0.3); color: #f85149; padding: 10px 28px; font-size: 13px; }

  main { max-width: 1400px; margin: 0 auto; padding: 24px 20px; }

  .charts-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 28px; }
  .chart-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .chart-card h3 { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
  .chart-wrap { height: 160px; }

  .section-header { display: flex; align-items: center; gap: 12px; margin: 28px 0 14px; }
  .section-header h2 { font-size: 16px; font-weight: 700; }
  .badge { display: inline-flex; align-items: center; background: var(--surface2); border: 1px solid var(--border); border-radius: 20px; padding: 2px 10px; font-size: 12px; color: var(--muted); }
  .badge.green { background: rgba(63,185,80,0.1); border-color: rgba(63,185,80,0.3); color: var(--green); }
  .badge.yellow { background: rgba(227,179,65,0.1); border-color: rgba(227,179,65,0.3); color: var(--yellow); }

  .trade-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
  .trade-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; transition: transform 0.15s, box-shadow 0.15s; }
  .trade-card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
  .trade-card.TRADE { border-color: rgba(63,185,80,0.35); box-shadow: 0 0 0 1px rgba(63,185,80,0.08), inset 0 0 30px rgba(63,185,80,0.03); }
  .trade-card.WATCH { border-color: rgba(227,179,65,0.25); }

  .card-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 14px; }
  .ticker-row { display: flex; align-items: center; gap: 10px; }
  .ticker { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; color: var(--text); }
  .verdict-chip { font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 5px; letter-spacing: 0.5px; }
  .verdict-chip.TRADE { background: rgba(63,185,80,0.2); color: var(--green); border: 1px solid rgba(63,185,80,0.4); }
  .verdict-chip.WATCH { background: rgba(227,179,65,0.2); color: var(--yellow); border: 1px solid rgba(227,179,65,0.4); }

  .card-meta { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 14px; }
  .tag { display: inline-flex; align-items: center; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 500; }
  .tag.breakout   { background: rgba(63,185,80,0.15);  color: #3fb950; }
  .tag.early_trend{ background: rgba(188,140,255,0.15); color: #bc8cff; }
  .tag.pullback   { background: rgba(88,166,255,0.15);  color: #58a6ff; }
  .tag.oversold   { background: rgba(248,81,73,0.15);   color: #f85149; }
  .tag.sector     { background: var(--surface2); color: var(--muted); border: 1px solid var(--border); }
  .tag.bullish    { background: rgba(63,185,80,0.12);  color: var(--green); }
  .tag.bearish    { background: rgba(248,81,73,0.12);  color: var(--red); }
  .tag.rat-sb     { background: rgba(63,185,80,0.15);  color: var(--green); }
  .tag.rat-b      { background: rgba(88,166,255,0.15); color: var(--blue); }
  .tag.rat-h      { background: rgba(139,148,158,0.1); color: var(--muted); }
  .tag.rat-s      { background: rgba(248,81,73,0.15);  color: var(--red); }

  .levels { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 14px; }
  .level-box { background: var(--surface2); border-radius: 8px; padding: 8px 10px; }
  .level-box .lbl { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.4px; }
  .level-box .val { font-size: 16px; font-weight: 700; margin-top: 2px; }
  .lb-entry .val { color: var(--text); }
  .lb-stop  .val { color: var(--red); }
  .lb-tgt   .val { color: var(--green); }

  .rr-bar-wrap { margin-bottom: 14px; }
  .rr-labels { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-bottom: 4px; }
  .rr-bar { height: 6px; border-radius: 3px; display: flex; overflow: hidden; }
  .rr-risk   { background: var(--red); }
  .rr-reward { background: var(--green); }

  .metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 14px; }
  .metric { display: flex; justify-content: space-between; align-items: center; background: var(--surface2); border-radius: 6px; padding: 5px 8px; }
  .metric .k { font-size: 11px; color: var(--muted); }
  .metric .v { font-size: 12px; font-weight: 600; }

  .card-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .btn { display: inline-flex; align-items: center; gap: 5px; background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 500; color: var(--text); cursor: pointer; transition: background 0.1s; }
  .btn:hover { background: var(--border); }
  .btn.primary { background: rgba(63,185,80,0.15); border-color: rgba(63,185,80,0.35); color: var(--green); }
  .btn.primary:hover { background: rgba(63,185,80,0.25); }

  .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 100; align-items: center; justify-content: center; }
  .modal-overlay.open { display: flex; }
  .modal { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 24px; width: 360px; max-width: 95vw; }
  .modal h3 { font-size: 16px; font-weight: 700; margin-bottom: 4px; }
  .modal-sub { font-size: 12px; color: var(--muted); margin-bottom: 18px; }
  .modal label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; margin-top: 10px; }
  .modal input { width: 100%; background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; color: var(--text); font-size: 14px; }
  .modal input:focus { outline: 2px solid var(--blue); border-color: transparent; }
  .sizer-result { background: var(--surface2); border-radius: 8px; padding: 14px; margin-top: 16px; display: none; }
  .sizer-result.show { display: block; }
  .sizer-row { display: flex; justify-content: space-between; align-items: center; padding: 5px 0; border-bottom: 1px solid var(--border); }
  .sizer-row:last-child { border-bottom: none; }
  .sizer-row .sk { font-size: 12px; color: var(--muted); }
  .sizer-row .sv { font-size: 13px; font-weight: 700; }
  .modal-footer { display: flex; gap: 8px; margin-top: 16px; }
  .modal-footer .btn { flex: 1; justify-content: center; }

  .table-toolbar { display: flex; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; align-items: center; }
  .table-toolbar input, .table-toolbar select { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; color: var(--text); font-size: 13px; }
  .table-toolbar input { width: 200px; }
  .table-toolbar input:focus, .table-toolbar select:focus { outline: 2px solid var(--blue); border-color: transparent; }
  .table-wrap { overflow-x: auto; border-radius: 10px; border: 1px solid var(--border); }
  table { width: 100%; border-collapse: collapse; }
  thead th { background: var(--surface2); padding: 10px 12px; font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; text-align: left; white-space: nowrap; cursor: pointer; user-select: none; }
  thead th:hover { color: var(--text); }
  thead th.sorted { color: var(--blue); }
  tbody tr { border-top: 1px solid var(--border); transition: background 0.1s; }
  tbody tr:hover { background: var(--surface2); }
  tbody td { padding: 9px 12px; font-size: 13px; white-space: nowrap; }

  .skip-toggle { background: none; border: 1px solid var(--border); border-radius: 6px; padding: 6px 14px; color: var(--muted); font-size: 12px; cursor: pointer; margin-bottom: 12px; }
  .skip-toggle:hover { color: var(--text); border-color: var(--muted); }
  .skip-body { display: none; }
  .skip-body.open { display: block; }
  .ml-auto { margin-left: auto; }

  .sector-panel { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 20px; margin-bottom: 28px; }
  .sector-panel-title { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
  .sector-pills { display: flex; gap: 10px; flex-wrap: wrap; }
  .sector-pill { background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; min-width: 150px; position: relative; }
  .sector-pill.selected { border-color: rgba(63,185,80,0.4); background: rgba(63,185,80,0.05); }
  .sector-pill.not-selected { opacity: 0.55; }
  .sp-rank { font-size: 10px; color: var(--muted); font-weight: 600; letter-spacing: 0.3px; margin-bottom: 3px; }
  .sp-name { font-size: 13px; font-weight: 700; color: var(--text); }
  .sp-etf  { font-size: 10px; color: var(--muted); margin-top: 1px; }
  .sp-perf { display: flex; gap: 8px; margin-top: 6px; font-size: 12px; font-weight: 600; }
  .sp-selected-badge { position: absolute; top: 8px; right: 10px; font-size: 9px; font-weight: 700; color: var(--green); letter-spacing: 0.3px; }

  @media (max-width: 900px) {
    .charts-row { grid-template-columns: 1fr; }
    .trade-grid  { grid-template-columns: 1fr; }
    .header { padding: 16px; }
    main { padding: 16px; }
  }
<\/style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <h1>&#128200; Trading Scanner</h1>
    <div class="subtitle">${dateStr} &middot; ${timeStr} &middot; ${data.mode === 'live' ? 'Live Data' : 'Mock Data'}</div>
  </div>
  <div class="header-stats">
    <div class="stat-pill green"><div class="val">${tradeCount}</div><div class="lbl">Trade</div></div>
    <div class="stat-pill yellow"><div class="val">${watchCount}</div><div class="lbl">Watch</div></div>
    <div class="stat-pill blue"><div class="val">${totalCount}</div><div class="lbl">Scanned</div></div>
    <div class="stat-pill"><div class="val">${multiCount}</div><div class="lbl">Multi-Hit</div></div>
  </div>
</div>

${macdWarning}

<main>

  ${sectorPanelHtml}

  <div class="charts-row">
    <div class="chart-card">
      <h3>Results by Scan Type</h3>
      <div class="chart-wrap"><canvas id="scanChart"></canvas></div>
    </div>
    <div class="chart-card">
      <h3>Top Sectors</h3>
      <div class="chart-wrap"><canvas id="sectorChart"></canvas></div>
    </div>
    <div class="chart-card">
      <h3>Score Distribution</h3>
      <div class="chart-wrap"><canvas id="scoreChart"></canvas></div>
    </div>
  </div>

  <div class="section-header">
    <h2>&#128994; Trade Candidates</h2>
    <span class="badge green" id="trade-badge">${tradeCount}</span>
    <button class="btn ml-auto" onclick="exportCSV()">&#11015; Export CSV</button>
  </div>
  <div class="trade-grid" id="trade-grid"></div>

  <div class="section-header">
    <h2>&#128993; Watch List</h2>
    <span class="badge yellow" id="watch-badge">${watchCount}</span>
  </div>
  <div class="table-toolbar">
    <input type="text" id="wsearch" placeholder="Search ticker or sector&hellip;" oninput="renderWatch()">
    <select id="wsect" onchange="renderWatch()"><option value="">All Sectors</option></select>
    <select id="wrat" onchange="renderWatch()">
      <option value="">All Ratings</option>
      <option value="StrongBuy">Strong Buy</option>
      <option value="Buy">Buy</option>
      <option value="Hold">Hold</option>
      <option value="Sell">Sell</option>
    </select>
    <select id="wmacd" onchange="renderWatch()">
      <option value="">All MACD</option>
      <option value="BULLISH">Bullish MACD</option>
      <option value="BEARISH">Bearish MACD</option>
    </select>
  </div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th onclick="sortWatch('ticker')">Ticker <span id="arr-ticker">&#8597;</span></th>
          <th onclick="sortWatch('score')">Score <span id="arr-score">&#8595;</span></th>
          <th onclick="sortWatch('price')">Price <span id="arr-price">&#8597;</span></th>
          <th onclick="sortWatch('perf_w')">Wk% <span id="arr-perf_w">&#8597;</span></th>
          <th onclick="sortWatch('perf_1m')">Mo% <span id="arr-perf_1m">&#8597;</span></th>
          <th onclick="sortWatch('rsi')">RSI <span id="arr-rsi">&#8597;</span></th>
          <th onclick="sortWatch('rel_vol_10d')">Vol&#215; <span id="arr-rel_vol_10d">&#8597;</span></th>
          <th>Stop</th>
          <th>Target</th>
          <th onclick="sortWatch('_rr')">R:R <span id="arr-_rr">&#8597;</span></th>
          <th>MACD</th>
          <th>Rating</th>
          <th>Scans</th>
          <th>Sector</th>
        </tr>
      </thead>
      <tbody id="watch-tbody"></tbody>
    </table>
  </div>

  <div class="section-header" style="margin-top:28px">
    <h2 style="color:var(--muted)">&#9899; Skipped</h2>
    <span class="badge" id="skip-badge">0</span>
  </div>
  <button class="skip-toggle" id="skip-toggle-btn" onclick="toggleSkip()">Show Skipped Stocks</button>
  <div class="skip-body" id="skip-body">
    <div class="table-wrap">
      <table>
        <thead><tr><th>Ticker</th><th>Score</th><th>Price</th><th>Wk%</th><th>RSI</th><th>Vol&#215;</th><th>Rating</th><th>Sector</th></tr></thead>
        <tbody id="skip-tbody"></tbody>
      </table>
    </div>
  </div>

</main>

<div class="modal-overlay" id="modal-overlay" onclick="closeModal(event)">
  <div class="modal" onclick="event.stopPropagation()">
    <h3 id="modal-ticker">Position Sizer</h3>
    <div class="modal-sub" id="modal-sub"></div>
    <label>Portfolio Value ($)</label>
    <input type="number" id="portfolio-val" value="25000" oninput="calcSizer()">
    <label>Risk per Trade (%)</label>
    <input type="number" id="risk-pct" value="1" step="0.1" oninput="calcSizer()">
    <div class="sizer-result" id="sizer-result">
      <div class="sizer-row"><span class="sk">Shares to Buy</span><span class="sv" id="sz-shares">--</span></div>
      <div class="sizer-row"><span class="sk">Position Value</span><span class="sv" id="sz-pos">--</span></div>
      <div class="sizer-row"><span class="sk">Max Risk</span><span class="sv" id="sz-risk">--</span></div>
      <div class="sizer-row"><span class="sk">Potential Gain</span><span class="sv" id="sz-gain">--</span></div>
      <div class="sizer-row"><span class="sk">Risk:Reward</span><span class="sv" id="sz-rr">--</span></div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Close</button>
    </div>
  </div>
</div>

<script type="application/json" id="scanner-data">${dataJson}<\/script>

<script>
var D = JSON.parse(document.getElementById('scanner-data').textContent);
var stocks = D.stocks;
var scans  = D.scans;

var wSort = { col: 'score', dir: -1 };
var sizerStock = null;

var SCAN_LABELS = { breakout: 'Breakout', early_trend: 'Early Trend', pullback: 'Pullback', oversold: 'Oversold' };
var SCAN_CLS    = { breakout: 'breakout', early_trend: 'early_trend', pullback: 'pullback', oversold: 'oversold' };
var RAT_CLS     = { StrongBuy: 'rat-sb', Buy: 'rat-b', Hold: 'rat-h', Sell: 'rat-s' };
var RAT_LABEL   = { StrongBuy: 'Strong Buy', Buy: 'Buy', Hold: 'Hold', Sell: 'Sell' };

function fmt(n, d)   { return n == null ? 'N/A' : Number(n).toFixed(d != null ? d : 2); }
function fmtPc(n)    { return n == null ? 'N/A' : '$' + Number(n).toFixed(2); }
function fmtPct(n)   { if (n == null) return 'N/A'; return (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%'; }
function fmtM(n)     { if (n == null) return 'N/A'; if (n >= 1e9) return '$' + (n/1e9).toFixed(1) + 'B'; return '$' + (n/1e6).toFixed(0) + 'M'; }

function calcRR(s) {
  if (!s.price || !s.stop_price || !s.t1_target) return null;
  var risk = s.price - s.stop_price;
  if (risk <= 0) return null;
  return (s.t1_target - s.price) / risk;
}

function scoreColor(score) {
  if (score >= 12) return '#3fb950';
  if (score >= 8)  return '#e3b341';
  return '#8b949e';
}

function scoreRing(score) {
  var max = 21, r = 18;
  var circ = 2 * Math.PI * r;
  var pct  = Math.min(score / max, 1);
  var dash = circ.toFixed(1);
  var off  = (circ * (1 - pct)).toFixed(1);
  var col  = scoreColor(score);
  return '<svg viewBox="0 0 44 44" width="44" height="44">'
    + '<circle cx="22" cy="22" r="' + r + '" fill="none" stroke="#21262d" stroke-width="3"/>'
    + '<circle cx="22" cy="22" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="3"'
    + ' stroke-dasharray="' + dash + '" stroke-dashoffset="' + off + '"'
    + ' stroke-linecap="round" style="transform:rotate(-90deg);transform-origin:center"/>'
    + '<text x="22" y="22" text-anchor="middle" dominant-baseline="central"'
    + ' fill="' + col + '" font-size="11" font-weight="700">' + score + '<\/text>'
    + '<\/svg>';
}

function tradeCard(s) {
  var rr   = calcRR(s);
  var risk = s.price - s.stop_price;
  var rew  = s.t1_target - s.price;
  var tot  = risk + rew;
  var rPct = tot > 0 ? (risk / tot * 100).toFixed(1) : '50';
  var wPct = tot > 0 ? (rew  / tot * 100).toFixed(1) : '50';

  var scanTags = s.found_in.map(function(id) {
    return '<span class="tag ' + SCAN_CLS[id] + '">' + SCAN_LABELS[id] + '<\/span>';
  }).join('');

  var ratTag = s.analyst_rating
    ? '<span class="tag ' + (RAT_CLS[s.analyst_rating] || 'rat-h') + '">' + (RAT_LABEL[s.analyst_rating] || s.analyst_rating) + '<\/span>'
    : '';

  var macdTag = '<span class="tag ' + (s.macd_status === 'BULLISH' ? 'bullish' : 'bearish') + '">MACD ' + s.macd_status + '<\/span>';

  var secLabel = s.sector || '';
  if (s.sector_rank != null) secLabel += ' #' + s.sector_rank;
  var secTag = s.sector ? '<span class="tag sector">' + secLabel + '<\/span>' : '';

  var rrLabel = rr ? rr.toFixed(2) + ':1 R:R' : 'R:R N/A';
  var wkColor = s.perf_w >= 0 ? 'var(--green)' : 'var(--red)';
  var moColor = s.perf_1m >= 0 ? 'var(--green)' : 'var(--red)';

  return '<div class="trade-card ' + s.verdict + '">'
    + '<div class="card-top">'
    +   '<div class="ticker-row">'
    +     '<a href="https://www.tradingview.com/chart/?symbol=' + s.ticker + '" target="_blank" rel="noopener" class="ticker">' + s.ticker + '<\/a>'
    +     '<span class="verdict-chip ' + s.verdict + '">' + s.verdict + '<\/span>'
    +   '<\/div>'
    +   scoreRing(s.score)
    + '<\/div>'
    + '<div class="card-meta">' + scanTags + ' ' + ratTag + ' ' + macdTag + '<\/div>'
    + '<div class="levels">'
    +   '<div class="level-box lb-entry"><div class="lbl">Entry<\/div><div class="val">' + fmtPc(s.price) + '<\/div><\/div>'
    +   '<div class="level-box lb-stop"><div class="lbl">Stop<\/div><div class="val">' + fmtPc(s.stop_price) + '<\/div><\/div>'
    +   '<div class="level-box lb-tgt"><div class="lbl">Target<\/div><div class="val">' + fmtPc(s.t1_target) + '<\/div><\/div>'
    + '<\/div>'
    + '<div class="rr-bar-wrap">'
    +   '<div class="rr-labels">'
    +     '<span style="color:var(--red)">Risk ' + fmtPc(s.stop_price) + '<\/span>'
    +     '<span style="font-weight:700">' + rrLabel + '<\/span>'
    +     '<span style="color:var(--green)">Target ' + fmtPc(s.t1_target) + '<\/span>'
    +   '<\/div>'
    +   '<div class="rr-bar"><div class="rr-risk" style="width:' + rPct + '%"><\/div><div class="rr-reward" style="width:' + wPct + '%"><\/div><\/div>'
    + '<\/div>'
    + '<div class="metrics">'
    +   '<div class="metric"><span class="k">RSI<\/span><span class="v">' + fmt(s.rsi, 1) + '<\/span><\/div>'
    +   '<div class="metric"><span class="k">Vol&times;<\/span><span class="v">' + fmt(s.rel_vol_10d, 1) + 'x<\/span><\/div>'
    +   '<div class="metric"><span class="k">Week Perf<\/span><span class="v" style="color:' + wkColor + '">' + fmtPct(s.perf_w) + '<\/span><\/div>'
    +   '<div class="metric"><span class="k">Month Perf<\/span><span class="v" style="color:' + moColor + '">' + fmtPct(s.perf_1m) + '<\/span><\/div>'
    +   '<div class="metric"><span class="k">SMA50<\/span><span class="v">' + fmtPc(s.sma50) + '<\/span><\/div>'
    +   '<div class="metric"><span class="k">Mkt Cap<\/span><span class="v">' + fmtM(s.market_cap) + '<\/span><\/div>'
    + '<\/div>'
    + '<div class="card-actions">'
    +   '<button class="btn primary" data-t="' + s.ticker + '" onclick="openSizer(this.dataset.t)">&#128208; Size Position<\/button>'
    +   '<a href="https://www.tradingview.com/chart/?symbol=' + s.ticker + '" target="_blank" rel="noopener"><button class="btn">&#128202; Chart<\/button><\/a>'
    +   secTag
    + '<\/div>'
    + '<\/div>';
}

function watchRow(s) {
  var rr     = calcRR(s);
  var wkCol  = s.perf_w  >= 0 ? 'var(--green)' : 'var(--red)';
  var moCol  = s.perf_1m >= 0 ? 'var(--green)' : 'var(--red)';
  var macdCl = s.macd_status === 'BULLISH' ? 'var(--green)' : 'var(--red)';
  var scanTags = s.found_in.map(function(id) {
    return '<span class="tag ' + SCAN_CLS[id] + '" style="font-size:10px;padding:1px 5px;">' + SCAN_LABELS[id] + '<\/span>';
  }).join(' ');
  return '<tr>'
    + '<td><a href="https://www.tradingview.com/chart/?symbol=' + s.ticker + '" target="_blank" rel="noopener" style="font-weight:700">' + s.ticker + '<\/a><\/td>'
    + '<td><span style="font-weight:700;color:' + scoreColor(s.score) + '">' + s.score + '<\/span><\/td>'
    + '<td>' + fmtPc(s.price) + '<\/td>'
    + '<td style="color:' + wkCol  + '">' + fmtPct(s.perf_w)  + '<\/td>'
    + '<td style="color:' + moCol  + '">' + fmtPct(s.perf_1m) + '<\/td>'
    + '<td>' + fmt(s.rsi, 1) + '<\/td>'
    + '<td>' + fmt(s.rel_vol_10d, 1) + 'x<\/td>'
    + '<td style="color:var(--red)">'   + fmtPc(s.stop_price) + '<\/td>'
    + '<td style="color:var(--green)">' + fmtPc(s.t1_target)  + '<\/td>'
    + '<td style="font-weight:700">' + (rr ? rr.toFixed(2) + ':1' : '--') + '<\/td>'
    + '<td style="color:' + macdCl + ';font-size:11px;font-weight:600">' + s.macd_status + '<\/td>'
    + '<td style="font-size:11px">' + (RAT_LABEL[s.analyst_rating] || s.analyst_rating || '--') + '<\/td>'
    + '<td>' + scanTags + '<\/td>'
    + '<td style="color:var(--muted);font-size:11px">' + (s.sector || '--') + '<\/td>'
    + '<\/tr>';
}

function skipRow(s) {
  var wkCol = s.perf_w >= 0 ? 'var(--green)' : 'var(--red)';
  return '<tr>'
    + '<td><a href="https://www.tradingview.com/chart/?symbol=' + s.ticker + '" target="_blank" rel="noopener">' + s.ticker + '<\/a><\/td>'
    + '<td style="color:var(--muted)">' + s.score + '<\/td>'
    + '<td>' + fmtPc(s.price) + '<\/td>'
    + '<td style="color:' + wkCol + '">' + fmtPct(s.perf_w) + '<\/td>'
    + '<td>' + fmt(s.rsi, 1) + '<\/td>'
    + '<td>' + fmt(s.rel_vol_10d, 1) + 'x<\/td>'
    + '<td style="font-size:11px">' + (RAT_LABEL[s.analyst_rating] || s.analyst_rating || '--') + '<\/td>'
    + '<td style="color:var(--muted);font-size:11px">' + (s.sector || '--') + '<\/td>'
    + '<\/tr>';
}

function renderAll() {
  var trades = stocks.filter(function(s) { return s.verdict === 'TRADE'; });
  document.getElementById('trade-grid').innerHTML = trades.map(tradeCard).join('');
  document.getElementById('trade-badge').textContent = trades.length + ' stocks';

  renderWatch();

  var skips = stocks.filter(function(s) { return s.verdict === 'SKIP'; });
  document.getElementById('skip-tbody').innerHTML = skips.map(skipRow).join('');
  document.getElementById('skip-badge').textContent = skips.length;
  document.getElementById('skip-toggle-btn').textContent = 'Show Skipped Stocks (' + skips.length + ')';

  var sectors = [];
  stocks.forEach(function(s) {
    if (s.verdict !== 'SKIP' && s.sector && sectors.indexOf(s.sector) === -1) sectors.push(s.sector);
  });
  sectors.sort();
  var sel = document.getElementById('wsect');
  sectors.forEach(function(sec) {
    var opt = document.createElement('option');
    opt.value = sec; opt.textContent = sec;
    sel.appendChild(opt);
  });

  buildCharts();
}

function renderWatch() {
  var q    = document.getElementById('wsearch').value.toLowerCase();
  var sect = document.getElementById('wsect').value;
  var rat  = document.getElementById('wrat').value;
  var macd = document.getElementById('wmacd').value;

  var list = stocks.filter(function(s) {
    if (s.verdict !== 'WATCH') return false;
    if (q && !s.ticker.toLowerCase().includes(q) && !(s.sector || '').toLowerCase().includes(q)) return false;
    if (sect && s.sector !== sect) return false;
    if (rat  && s.analyst_rating !== rat) return false;
    if (macd && s.macd_status !== macd) return false;
    return true;
  });

  list = list.map(function(s) { return Object.assign({}, s, { _rr: calcRR(s) || 0 }); });

  var col = wSort.col;
  list.sort(function(a, b) {
    var av = col === 'ticker' ? a.ticker : (a[col] != null ? a[col] : 0);
    var bv = col === 'ticker' ? b.ticker : (b[col] != null ? b[col] : 0);
    if (av < bv) return wSort.dir;
    if (av > bv) return -wSort.dir;
    return 0;
  });

  document.getElementById('watch-badge').textContent = list.length + ' stocks';
  document.getElementById('watch-tbody').innerHTML = list.map(watchRow).join('');

  document.querySelectorAll('thead th').forEach(function(th) { th.classList.remove('sorted'); });
  var arr = document.getElementById('arr-' + col);
  if (arr) arr.closest('th').classList.add('sorted');
}

function sortWatch(col) {
  if (wSort.col === col) wSort.dir = -wSort.dir;
  else { wSort.col = col; wSort.dir = -1; }
  var arrowIds = ['ticker','score','price','perf_w','perf_1m','rsi','rel_vol_10d','_rr'];
  arrowIds.forEach(function(id) {
    var el = document.getElementById('arr-' + id);
    if (el) el.innerHTML = '&#8597;';
  });
  var arr = document.getElementById('arr-' + col);
  if (arr) arr.innerHTML = wSort.dir === -1 ? '&#8595;' : '&#8593;';
  renderWatch();
}

function toggleSkip() {
  var body = document.getElementById('skip-body');
  var btn  = document.getElementById('skip-toggle-btn');
  body.classList.toggle('open');
  var cnt = document.getElementById('skip-badge').textContent;
  btn.textContent = body.classList.contains('open')
    ? 'Hide Skipped'
    : 'Show Skipped Stocks (' + cnt + ')';
}

function openSizer(ticker) {
  sizerStock = null;
  for (var i = 0; i < stocks.length; i++) {
    if (stocks[i].ticker === ticker) { sizerStock = stocks[i]; break; }
  }
  if (!sizerStock) return;
  document.getElementById('modal-ticker').textContent = ticker + ' — Position Sizer';
  document.getElementById('modal-sub').textContent =
    'Entry: ' + fmtPc(sizerStock.price) +
    '  |  Stop: ' + fmtPc(sizerStock.stop_price) +
    '  |  Target: ' + fmtPc(sizerStock.t1_target);
  document.getElementById('modal-overlay').classList.add('open');
  calcSizer();
}

function calcSizer() {
  if (!sizerStock) return;
  var portfolio = parseFloat(document.getElementById('portfolio-val').value) || 0;
  var riskPct   = parseFloat(document.getElementById('risk-pct').value) || 1;
  var riskAmt   = portfolio * riskPct / 100;
  var riskPerSh = sizerStock.price - sizerStock.stop_price;
  if (riskPerSh <= 0) return;
  var shares = Math.floor(riskAmt / riskPerSh);
  var posVal = shares * sizerStock.price;
  var gain   = shares * (sizerStock.t1_target - sizerStock.price);
  var rr     = calcRR(sizerStock);
  document.getElementById('sz-shares').textContent = shares.toLocaleString() + ' shares';
  document.getElementById('sz-pos').textContent    = '$' + posVal.toLocaleString(undefined, { maximumFractionDigits: 0 });
  document.getElementById('sz-risk').textContent   = '$' + riskAmt.toFixed(2);
  document.getElementById('sz-gain').textContent   = '$' + gain.toFixed(2);
  document.getElementById('sz-rr').textContent     = rr ? rr.toFixed(2) + ':1' : 'N/A';
  document.getElementById('sizer-result').classList.add('show');
}

function closeModal(e) {
  if (!e || e.target === document.getElementById('modal-overlay')) {
    document.getElementById('modal-overlay').classList.remove('open');
    sizerStock = null;
  }
}

function exportCSV() {
  var rows = stocks.filter(function(s) { return s.verdict !== 'SKIP'; });
  var lines = ['Ticker,Verdict,Score,Price,Stop,Target,RR,WeekPct,MonthPct,RSI,VolX,Sector,Rating,Scans'];
  rows.forEach(function(s) {
    var rr = calcRR(s);
    lines.push([
      s.ticker,
      s.verdict,
      s.score,
      (s.price || 0).toFixed(2),
      (s.stop_price || 0).toFixed(4),
      (s.t1_target || 0).toFixed(4),
      rr ? rr.toFixed(2) : '',
      (s.perf_w || 0).toFixed(2),
      (s.perf_1m || 0).toFixed(2),
      (s.rsi || 0).toFixed(1),
      (s.rel_vol_10d || 0).toFixed(2),
      (s.sector || '').replace(/,/g, ';'),
      s.analyst_rating || '',
      s.found_in.join('|')
    ].join(','));
  });
  var csv  = lines.join('\\n');
  var blob = new Blob([csv], { type: 'text/csv' });
  var a    = document.createElement('a');
  a.href  = URL.createObjectURL(blob);
  a.download = 'scanner-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
}

function buildCharts() {
  var gc = 'rgba(48,54,61,0.8)';
  var bo = { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } };

  var scanCounts = scans.map(function(sc) {
    return stocks.filter(function(s) { return s.found_in.indexOf(sc.id) !== -1; }).length;
  });
  new Chart(document.getElementById('scanChart'), {
    type: 'bar',
    data: { labels: scans.map(function(s) { return s.name; }), datasets: [{ data: scanCounts, backgroundColor: ['#3fb950','#bc8cff','#58a6ff','#f85149'], borderRadius: 5 }] },
    options: Object.assign({}, bo, { indexAxis: 'y', scales: { x: { grid: { color: gc }, beginAtZero: true }, y: { grid: { color: 'transparent' }, ticks: { font: { size: 11 } } } } })
  });

  var sectorRankData = D.sector_rankings || [];
  if (sectorRankData.length > 0) {
    var topSet = new Set((D.top_sectors || []).map(function(s) { return s.sector; }));
    var secColors = sectorRankData.map(function(s) {
      return topSet.has(s.sector) ? '#3fb950' : '#30363d';
    });
    new Chart(document.getElementById('sectorChart'), {
      type: 'bar',
      data: {
        labels: sectorRankData.map(function(s) { return s.etf; }),
        datasets: [{ data: sectorRankData.map(function(s) { return s.perf_w != null ? parseFloat(s.perf_w.toFixed(2)) : 0; }), backgroundColor: secColors, borderRadius: 4 }]
      },
      options: Object.assign({}, bo, {
        scales: {
          x: { grid: { color: 'transparent' }, ticks: { font: { size: 10 } } },
          y: { grid: { color: gc }, ticks: { callback: function(v) { return v + '%'; }, font: { size: 10 } } }
        },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(ctx) { return sectorRankData[ctx.dataIndex].sector + ': ' + (ctx.raw >= 0 ? '+' : '') + ctx.raw + '%W'; } } } }
      })
    });
  } else {
    var sectorMap = {};
    stocks.forEach(function(s) { if (s.sector) sectorMap[s.sector] = (sectorMap[s.sector] || 0) + 1; });
    var topSec = Object.entries(sectorMap).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 8);
    new Chart(document.getElementById('sectorChart'), {
      type: 'bar',
      data: { labels: topSec.map(function(s) { return s[0]; }), datasets: [{ data: topSec.map(function(s) { return s[1]; }), backgroundColor: '#a371f7', borderRadius: 5 }] },
      options: Object.assign({}, bo, { indexAxis: 'y', scales: { x: { grid: { color: gc }, beginAtZero: true }, y: { grid: { color: 'transparent' }, ticks: { font: { size: 10 } } } } })
    });
  }

  var bins = [0, 0, 0, 0, 0];
  stocks.forEach(function(s) {
    if      (s.score <= 5)  bins[0]++;
    else if (s.score <= 7)  bins[1]++;
    else if (s.score <= 9)  bins[2]++;
    else if (s.score <= 11) bins[3]++;
    else                    bins[4]++;
  });
  new Chart(document.getElementById('scoreChart'), {
    type: 'bar',
    data: { labels: ['1-5 Skip','6-7 Skip','8-9 Watch','10-11 Watch','12+ Trade'], datasets: [{ data: bins, backgroundColor: ['#30363d','#30363d','#e3b341','#e3b341','#3fb950'], borderRadius: 5 }] },
    options: Object.assign({}, bo, { scales: { x: { grid: { color: 'transparent' }, ticks: { font: { size: 10 } } }, y: { grid: { color: gc }, beginAtZero: true } } })
  });
}

window.addEventListener('load', renderAll);
<\/script>
</body>
</html>`;

fs.writeFileSync(outFile, html, 'utf8');
console.log('Report written: report.html');
console.log('  TRADE: ' + tradeCount + '  WATCH: ' + watchCount + '  Total scanned: ' + totalCount);

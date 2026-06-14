/**
 * Scanner MCP — Cloudflare Worker
 * Stores TradingView scanner results in KV and exposes them as MCP tools.
 *
 * Setup:
 *   1. npx wrangler kv namespace create SCANNER_KV  → paste id into wrangler.toml
 *   2. npx wrangler secret put SCANNER_API_KEY      → same key goes in scanner.js
 *   3. npx wrangler deploy
 *
 * Endpoints:
 *   POST /update          — scanner.js pushes fresh results here (Bearer auth)
 *   GET  /mcp             — SSE stub for mcp-remote handshake
 *   POST /mcp             — JSON-RPC MCP tools
 *   GET  /health          — status check
 */

const KV_KEY        = "latest_scan";
const KV_REPORT_KEY = "latest_report";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPct(n)  { return n == null ? "N/A" : (n >= 0 ? "+" : "") + n.toFixed(1) + "%"; }
function fmtPc(n)   { return n == null ? "N/A" : "$" + n.toFixed(2); }
function fmtM(n)    {
  if (n == null) return "N/A";
  if (n >= 1e12) return "$" + (n / 1e12).toFixed(1) + "T";
  if (n >= 1e9)  return "$" + (n / 1e9).toFixed(1) + "B";
  return "$" + (n / 1e6).toFixed(0) + "M";
}

function formatStock(s) {
  const rr = (s.price && s.stop_price && s.t1_target)
    ? ((s.t1_target - s.price) / (s.price - s.stop_price)).toFixed(2)
    : "N/A";
  return [
    `${s.ticker} | Score ${s.score} | ${s.verdict} | ${s.found_in.join("+")}`,
    `  Price: ${fmtPc(s.price)}  Stop: ${fmtPc(s.stop_price)}  Target: ${fmtPc(s.t1_target)}  R:R ${rr}:1`,
    `  RSI: ${s.rsi ? s.rsi.toFixed(1) : "N/A"}  Vol×: ${s.rel_vol_10d ? s.rel_vol_10d.toFixed(1) : "N/A"}x  MACD: ${s.macd_status}`,
    `  Wk: ${fmtPct(s.perf_w)}  Mo: ${fmtPct(s.perf_1m)}  MCap: ${fmtM(s.market_cap)}`,
    `  SMA50: ${fmtPc(s.sma50)}  SMA200: ${fmtPc(s.sma200)}  ATR: ${s.atr ? s.atr.toFixed(2) : "N/A"}`,
    `  Sector: ${s.sector || "N/A"}  Rating: ${s.analyst_rating || "N/A"}`,
  ].join("\n");
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "get_scan_results",
    description: "Returns today's scanner results. Filter by verdict: TRADE (score≥12, act now), WATCH (score 8-11, monitor), ALL. Each stock includes price, stop, target, R:R, RSI, volume spike, MACD status, weekly/monthly performance, sector, and analyst rating. Run this first before analyzing any trade.",
    inputSchema: {
      type: "object",
      properties: {
        verdict: {
          type: "string",
          enum: ["TRADE", "WATCH", "ALL"],
          description: "Filter by verdict. TRADE = immediate candidates. WATCH = monitor list. ALL = everything.",
        },
        macd_filter: {
          type: "string",
          enum: ["BULLISH", "BEARISH", "ANY"],
          description: "Optional: filter by MACD momentum. BULLISH = confirmed momentum. Default: ANY.",
        },
        limit: {
          type: "integer",
          description: "Max stocks to return. Default 20.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_stock",
    description: "Returns full details for a specific ticker from today's scan. Use this to get the exact entry price, stop, target and all metrics before calling trade-analyzer or placing an order.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: {
          type: "string",
          description: "Stock ticker symbol (e.g. ROKU, BBVA, RYCEY)",
        },
      },
      required: ["ticker"],
    },
  },
  {
    name: "get_scan_summary",
    description: "Returns a brief summary of today's scan — total counts, top picks by score, MACD breakdown, and scan timestamp. Use this for a quick overview before diving into individual stocks.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_healthcare_stocks",
    description: "Returns Healthcare and Pharma stocks (Health Technology sector only — pharma, biotech, medical devices) found in today's scan. Excludes insurance companies (Health Services). Use this when the user asks about drug companies, biotech, or pharma plays.",
    inputSchema: {
      type: "object",
      properties: {
        verdict: {
          type: "string",
          enum: ["TRADE", "WATCH", "ALL"],
          description: "Filter by verdict. Default: ALL (shows TRADE and WATCH healthcare stocks).",
        },
      },
      required: [],
    },
  },
  {
    name: "get_scan_config",
    description: "Returns the filter criteria used to run the scanner — all 4 scan types with their exact conditions, the scoring rules (how points are awarded), and the verdict thresholds (TRADE/WATCH/SKIP). Use this when the user asks why a stock was or wasn't included, or wants to understand the strategy behind the scan.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function handleGetScanResults(args, kv) {
  const raw = await kv.get(KV_KEY);
  if (!raw) return "No scan data available. Run scanner.js first to populate results.";

  const data   = JSON.parse(raw);
  const verdict = (args.verdict || "TRADE").toUpperCase();
  const macdF   = (args.macd_filter || "ANY").toUpperCase();
  const limit   = args.limit || 20;

  let stocks = data.stocks;
  if (verdict !== "ALL") stocks = stocks.filter(s => s.verdict === verdict);
  if (macdF  !== "ANY")  stocks = stocks.filter(s => s.macd_status === macdF);
  stocks = stocks.slice(0, limit);

  if (stocks.length === 0) {
    return `No ${verdict} stocks found${macdF !== "ANY" ? ` with ${macdF} MACD` : ""}. Try verdict=ALL or macd_filter=ANY.`;
  }

  const ts = new Date(data.timestamp).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });

  const header = `SCANNER RESULTS — ${ts} | ${verdict === "ALL" ? "All verdicts" : verdict} | ${stocks.length} stocks\n${"─".repeat(60)}`;
  const body   = stocks.map(formatStock).join("\n\n");
  const footer = `\n${"─".repeat(60)}\nSummary: ${data.summary.trade_candidates} TRADE | ${data.summary.watch_candidates} WATCH | ${data.summary.total_candidates} total scanned`;

  return header + "\n\n" + body + footer;
}

async function handleGetStock(args, kv) {
  const raw = await kv.get(KV_KEY);
  if (!raw) return "No scan data available. Run scanner.js first.";

  const data   = JSON.parse(raw);
  const ticker = (args.ticker || "").toUpperCase();
  const stock  = data.stocks.find(s => s.ticker === ticker);

  if (!stock) {
    return `${ticker} not found in today's scan. It may not have met any scan criteria today.`;
  }

  const rr = (stock.price && stock.stop_price && stock.t1_target)
    ? ((stock.t1_target - stock.price) / (stock.price - stock.stop_price)).toFixed(2)
    : "N/A";

  return [
    `${stock.ticker} — ${stock.verdict} | Score ${stock.score}/21`,
    `Found in: ${stock.found_in.join(", ")}`,
    "",
    "LEVELS",
    `  Entry:  ${fmtPc(stock.price)}`,
    `  Stop:   ${fmtPc(stock.stop_price)}  (${stock.price && stock.stop_price ? ((stock.stop_price / stock.price - 1) * 100).toFixed(1) : "N/A"}% from entry)`,
    `  Target: ${fmtPc(stock.t1_target)}  (${stock.price && stock.t1_target ? ((stock.t1_target / stock.price - 1) * 100).toFixed(1) : "N/A"}% from entry)`,
    `  R:R:    ${rr}:1`,
    "",
    "TECHNICALS",
    `  RSI:    ${stock.rsi ? stock.rsi.toFixed(1) : "N/A"}`,
    `  MACD:   ${stock.macd_status}  (macd ${stock.macd ? stock.macd.toFixed(3) : "N/A"} / signal ${stock.macd_signal ? stock.macd_signal.toFixed(3) : "N/A"})`,
    `  Vol×:   ${stock.rel_vol_10d ? stock.rel_vol_10d.toFixed(2) : "N/A"}x average`,
    `  SMA50:  ${fmtPc(stock.sma50)}  (price is ${stock.price && stock.sma50 ? ((stock.price / stock.sma50 - 1) * 100).toFixed(1) : "N/A"}% above)`,
    `  SMA200: ${fmtPc(stock.sma200)}  (price is ${stock.price && stock.sma200 ? ((stock.price / stock.sma200 - 1) * 100).toFixed(1) : "N/A"}% above)`,
    `  ATR:    ${stock.atr ? stock.atr.toFixed(2) : "N/A"}`,
    "",
    "PERFORMANCE",
    `  Week:   ${fmtPct(stock.perf_w)}`,
    `  Month:  ${fmtPct(stock.perf_1m)}`,
    "",
    "PROFILE",
    `  Sector:  ${stock.sector || "N/A"}`,
    `  MCap:    ${fmtM(stock.market_cap)}`,
    `  Rating:  ${stock.analyst_rating || "N/A"}`,
    "",
    "SUGGESTED NEXT STEPS",
    `  1. Call trade-analyzer: analyze_trade(symbol="${stock.ticker}", side="buy", price=${stock.price ? stock.price.toFixed(2) : "?"}, ...)`,
    `  2. Call guardrail-engine: check position sizing against your portfolio`,
    `  3. Call robinhood: review_equity_order before placing`,
  ].join("\n");
}

async function handleGetScanSummary(kv) {
  const raw = await kv.get(KV_KEY);
  if (!raw) return "No scan data available. Run scanner.js first to populate results.";

  const data    = JSON.parse(raw);
  const ts      = new Date(data.timestamp).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });

  const trades  = data.stocks.filter(s => s.verdict === "TRADE").sort((a, b) => b.score - a.score);
  const watches = data.stocks.filter(s => s.verdict === "WATCH");
  const bullish = data.stocks.filter(s => s.verdict !== "SKIP" && s.macd_status === "BULLISH").length;
  const bearish = data.stocks.filter(s => s.verdict !== "SKIP" && s.macd_status === "BEARISH").length;
  const actionable = trades.length + watches.length;

  const topTrades = trades.slice(0, 5).map(s =>
    `  ${s.ticker.padEnd(6)} score ${s.score}  ${s.found_in.join("+")}  RSI ${s.rsi ? s.rsi.toFixed(0) : "?"} MACD ${s.macd_status}  Wk ${fmtPct(s.perf_w)}`
  ).join("\n");

  return [
    `SCAN SUMMARY — ${ts}`,
    `Mode: ${data.mode === "live" ? "Live Data" : "Mock Data"}`,
    "─".repeat(55),
    "",
    `TRADE candidates: ${trades.length}`,
    `WATCH candidates: ${watches.length}`,
    `Total scanned:    ${data.summary.total_candidates}`,
    `Multi-scan hits:  ${data.summary.multi_scan_hits}`,
    "",
    `MACD breakdown (actionable ${actionable} stocks):`,
    `  BULLISH: ${bullish}  ← momentum confirmed`,
    `  BEARISH: ${bearish}  ← momentum headwind`,
    "",
    "TOP TRADE CANDIDATES (by score):",
    topTrades || "  None",
    "",
    "RECOMMENDED WORKFLOW:",
    "  1. get_stock(<ticker>) for details on each TRADE candidate",
    "  2. trade-analyzer: analyze_trade for position sizing + live technicals",
    "  3. robinhood: get_portfolio to check buying power",
    "  4. robinhood: review_equity_order → confirm → place_equity_order",
    "  5. trade-journal: log the trade",
  ].join("\n");
}

async function handleGetHealthcareStocks(args, kv) {
  const raw = await kv.get(KV_KEY);
  if (!raw) return "No scan data available. Run the scanner first.";
  const data = JSON.parse(raw);

  const verdict = (args.verdict || "ALL").toUpperCase();
  const hc = (data.stocks || []).filter(s => {
    if (s.sector !== "Health Technology") return false;
    if (verdict !== "ALL" && s.verdict !== verdict) return false;
    if (s.verdict === "SKIP") return false;
    return true;
  });

  if (hc.length === 0) return "No Healthcare / Pharma stocks found in today's scan" + (verdict !== "ALL" ? ` with verdict ${verdict}` : "") + ".";

  hc.sort((a, b) => b.score - a.score);

  const lines = [
    `HEALTHCARE & PHARMA — ${new Date(data.timestamp).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`,
    `(Health Technology + Health Services) — ${hc.length} stocks`,
    "─".repeat(55),
    "",
  ];

  for (const s of hc) {
    const rr = (s.price && s.stop_price && s.t1_target)
      ? ((s.t1_target - s.price) / (s.price - s.stop_price)).toFixed(2)
      : "N/A";
    lines.push(
      `${s.ticker} | Score ${s.score} | ${s.verdict} | ${s.sector}`,
      `  Price: $${(s.price||0).toFixed(2)}  Stop: $${(s.stop_price||0).toFixed(2)}  Target: $${(s.t1_target||0).toFixed(2)}  R:R ${rr}:1`,
      `  RSI: ${s.rsi ? s.rsi.toFixed(1) : "N/A"}  Vol×: ${s.rel_vol_10d ? s.rel_vol_10d.toFixed(1) : "N/A"}x  MACD: ${s.macd_status}  Rating: ${s.analyst_rating || "N/A"}`,
      `  Wk: ${s.perf_w != null ? (s.perf_w >= 0 ? "+" : "") + s.perf_w.toFixed(1) + "%" : "N/A"}  Mo: ${s.perf_1m != null ? (s.perf_1m >= 0 ? "+" : "") + s.perf_1m.toFixed(1) + "%" : "N/A"}  Scans: ${s.found_in.join("+")}`,
      ""
    );
  }

  return lines.join("\n");
}

function handleGetScanConfig() {
  return [
    "SCANNER CONFIGURATION",
    "═".repeat(55),
    "",
    "SCAN TYPES (4 parallel scans run on every execution):",
    "",
    "1. MOMENTUM BREAKOUT",
    "   Weekly perf > +2%",
    "   RSI 55–75 (momentum without being overbought)",
    "   Price above SMA50",
    "   Relative volume > 1.5× (above-average activity)",
    "",
    "2. PULLBACK TO SUPPORT",
    "   RSI 42–52 (cooling off, not oversold)",
    "   Price above SMA200 (long-term uptrend intact)",
    "   Weekly perf −8% to −1% (dip in progress)",
    "   1-month perf > +3% (pullback within a rising trend)",
    "",
    "3. OVERSOLD BOUNCE",
    "   RSI < 35 (oversold)",
    "   Weekly perf < −4% (sharp drop)",
    "   1-month perf −45% to −10% (significant decline, not a collapse)",
    "",
    "4. EARLY TREND FORMING",
    "   RSI 50–72 (gaining momentum)",
    "   Price above SMA50",
    "   1-month perf > +7% (emerging strength)",
    "   Relative volume > 1.1× (growing interest)",
    "",
    "SCORING RULES (max 21 pts):",
    "",
    "  Multi-scan confluence:",
    "    1 scan hit  → +2 pts",
    "    2 scan hits → +4 pts",
    "    3+ scan hits → +5 pts",
    "",
    "  Analyst rating:",
    "    Strong Buy → +5 pts",
    "    Buy        → +3 pts",
    "    Hold       → +1 pt",
    "    Sell       → −2 pts",
    "",
    "  Relative volume:",
    "    > 2.0×  → +3 pts",
    "    > 1.5×  → +2 pts",
    "    > 1.0×  → +1 pt",
    "",
    "  Daily price change:",
    "    > +5%   → +3 pts",
    "    > +2%   → +2 pts",
    "    > 0%    → +1 pt",
    "    < −3%   → −1 pt",
    "",
    "  Market cap > $5B → +2 pts",
    "",
    "VERDICT THRESHOLDS:",
    "  TRADE  = score ≥ 12  (high-conviction, act now)",
    "  WATCH  = score 8–11  (monitor, wait for confirmation)",
    "  SKIP   = score < 8   (insufficient signal)",
    "",
    "STOP / TARGET CALCULATION (ATR-based %):",
    "  Breakout  → Stop −3%  / Target +7%",
    "  Oversold  → Stop −2%  / Target +4%",
    "  All others → Stop −2.5% / Target +5%",
    "",
    "DATA SOURCE: TradingView screener API (unauthenticated, US equities)",
    "UNIVERSE: All US stocks passing each scan's filter set",
  ].join("\n");
}

// ── MCP message router ────────────────────────────────────────────────────────

const mcpOk  = (id, result)        => ({ jsonrpc: "2.0", id, result });
const mcpErr = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleMcpMessage(msg, kv) {
  const { method, params, id } = msg;

  if (method === "initialize") {
    return mcpOk(id, {
      protocolVersion: "2024-11-05",
      capabilities:    { tools: {} },
      serverInfo:      { name: "scanner-mcp", version: "1.2" },
    });
  }
  if (method === "notifications/initialized") return null;
  if (method === "ping")       return mcpOk(id, {});
  if (method === "tools/list") return mcpOk(id, { tools: TOOLS });

  if (method === "tools/call") {
    const { name, arguments: args } = params ?? {};
    try {
      let text;
      if (name === "get_scan_results")  text = await handleGetScanResults(args ?? {}, kv);
      else if (name === "get_stock")    text = await handleGetStock(args ?? {}, kv);
      else if (name === "get_scan_summary") text = await handleGetScanSummary(kv);
      else if (name === "get_healthcare_stocks") text = await handleGetHealthcareStocks(args ?? {}, kv);
      else if (name === "get_scan_config")  text = handleGetScanConfig();
      else return mcpErr(id, -32601, `Unknown tool: ${name}`);
      return mcpOk(id, { content: [{ type: "text", text }], isError: false });
    } catch (err) {
      return mcpErr(id, -32603, String(err.message));
    }
  }

  return mcpErr(id, -32601, `Unknown method: ${method}`);
}

// ── CORS headers ──────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
};

// ── Cloudflare Worker export ──────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: CORS });

    // ── Health check ──────────────────────────────────────────────────────────
    if (url.pathname === "/" || url.pathname === "/health") {
      const hasData = !!(await env.SCANNER_KV.get(KV_KEY));
      return new Response(JSON.stringify({
        status:   "ok",
        server:   "scanner-mcp",
        version:  "1.0",
        has_data: hasData,
        kv_key:   KV_KEY,
      }), { headers: { "Content-Type": "application/json", ...CORS } });
    }

    // ── POST /update — scanner.js pushes fresh results ────────────────────────
    if (url.pathname === "/update" && request.method === "POST") {
      const authHeader = request.headers.get("Authorization") || "";
      const token      = authHeader.replace("Bearer ", "").trim();

      if (!env.SCANNER_API_KEY || token !== env.SCANNER_API_KEY) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { "Content-Type": "application/json", ...CORS },
        });
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400, headers: { "Content-Type": "application/json", ...CORS },
        });
      }

      await env.SCANNER_KV.put(KV_KEY, JSON.stringify(body));

      const tradeCount = (body.stocks || []).filter(s => s.verdict === "TRADE").length;
      const watchCount = (body.stocks || []).filter(s => s.verdict === "WATCH").length;

      return new Response(JSON.stringify({
        ok: true,
        stored_at: new Date().toISOString(),
        trade_candidates: tradeCount,
        watch_candidates: watchCount,
        total_stocks: (body.stocks || []).length,
      }), { headers: { "Content-Type": "application/json", ...CORS } });
    }

    // ── GET /mcp — SSE stub for mcp-remote handshake ──────────────────────────
    if (url.pathname === "/mcp" && request.method === "GET") {
      const body = `data: ${JSON.stringify({
        jsonrpc: "2.0", method: "notifications/initialized", params: {}
      })}\n\n`;
      return new Response(body, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...CORS },
      });
    }

    // ── POST /mcp — JSON-RPC handler ──────────────────────────────────────────
    if (url.pathname === "/mcp" && request.method === "POST") {
      let msg;
      try {
        msg = await request.json();
      } catch {
        return new Response(
          JSON.stringify(mcpErr(null, -32700, "Parse error")),
          { status: 400, headers: { "Content-Type": "application/json", ...CORS } }
        );
      }

      const isBatch = Array.isArray(msg);
      const msgs    = isBatch ? msg : [msg];
      const results = (await Promise.all(
        msgs.map(m => handleMcpMessage(m, env.SCANNER_KV))
      )).filter(r => r !== null);

      const body = isBatch ? JSON.stringify(results) : JSON.stringify(results[0] ?? "");
      return new Response(body, {
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }

    // ── POST /update-report — scanner.js pushes generated HTML ───────────────
    if (url.pathname === "/update-report" && request.method === "POST") {
      const authHeader = request.headers.get("Authorization") || "";
      const token      = authHeader.replace("Bearer ", "").trim();

      if (!env.SCANNER_API_KEY || token !== env.SCANNER_API_KEY) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { "Content-Type": "application/json", ...CORS },
        });
      }

      const html = await request.text();
      if (!html || !html.includes("<!DOCTYPE")) {
        return new Response(JSON.stringify({ error: "Invalid HTML" }), {
          status: 400, headers: { "Content-Type": "application/json", ...CORS },
        });
      }

      await env.SCANNER_KV.put(KV_REPORT_KEY, html);
      return new Response(JSON.stringify({ ok: true, stored_at: new Date().toISOString() }), {
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }

    // ── GET /report — serve the latest HTML report ────────────────────────────
    if (url.pathname === "/report" && request.method === "GET") {
      const html = await env.SCANNER_KV.get(KV_REPORT_KEY);
      if (!html) {
        return new Response("<h1>No report yet</h1><p>Run the scanner first.</p>", {
          status: 404, headers: { "Content-Type": "text/html", ...CORS },
        });
      }
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8", ...CORS },
      });
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};

/**
 * Trade Journal — Cloudflare Worker
 * MCP Server over Streamable HTTP transport (replaces SSE)
 * Backend: Notion database
 *
 * Version: 6.0
 * All journal logic identical to v5.0 — only transport layer changed
 *
 * Required secrets (unchanged):
 *   wrangler secret put NOTION_API_KEY
 *   wrangler secret put NOTION_DATABASE_ID
 *
 * Deploy: npx wrangler deploy
 * Config: { "command": "npx", "args": ["-y", "mcp-remote", "https://trade-journal.tda-guardrails.workers.dev/mcp"] }
 */

const NOTION_VERSION = "2022-06-28";
const TIER1_R        = 1.5;
const TIER2_R        = 2.5;
const TIME_STOP_DAYS = 7;

const TIER_MAP = {
  1: "T1 Large Cap Stable",
  2: "T2 Large Cap Growth",
  3: "T3 Mid Cap / Thematic",
  4: "T4 Small Cap / ADR",
};

const SECTOR_MAP = {
  tech: "Tech", consumer: "Consumer", industrials: "Industrials",
  healthcare: "Healthcare", energy: "Energy", financials: "Financials",
};

// ── Notion API helpers ────────────────────────────────────────────────────────
async function notionRequest(method, path, body, apiKey) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      "Authorization":   `Bearer ${apiKey}`,
      "Content-Type":    "application/json",
      "Notion-Version":  NOTION_VERSION,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Notion API ${res.status}: ${err}`);
  }
  return res.json();
}

async function queryDatabase(dbId, filter, apiKey) {
  const body = { page_size: 100 };
  if (filter) body.filter = filter;
  const data = await notionRequest("POST", `/databases/${dbId}/query`, body, apiKey);
  return data.results ?? [];
}

async function createPage(dbId, properties, apiKey) {
  return notionRequest("POST", "/pages", { parent: { database_id: dbId }, properties }, apiKey);
}

async function updatePage(pageId, properties, apiKey) {
  return notionRequest("PATCH", `/pages/${pageId}`, { properties }, apiKey);
}

// ── Property builders / readers ───────────────────────────────────────────────
const prop = {
  title: t  => ({ title:     [{ text: { content: String(t) } }] }),
  text:  t  => ({ rich_text: [{ text: { content: String(t ?? "") } }] }),
  num:   n  => ({ number: n ?? null }),
  sel:   o  => o ? { select: { name: o } } : { select: null },
  date:  d  => d ? { date: { start: d } } : { date: null },
};

const readTitle = p => p?.title?.[0]?.plain_text ?? "";
const readText  = p => p?.rich_text?.[0]?.plain_text ?? "";
const readNum   = p => p?.number ?? 0;
const readSel   = p => p?.select?.name ?? "";
const readDate  = p => p?.date?.start ?? "";

// ── Date helpers ──────────────────────────────────────────────────────────────
function addTradingDays(dateStr, days) {
  const dt = new Date(dateStr + "T12:00:00Z");
  let added = 0;
  while (added < days) {
    dt.setUTCDate(dt.getUTCDate() + 1);
    const dow = dt.getUTCDay();
    if (dow >= 1 && dow <= 5) added++;
  }
  return dt.toISOString().slice(0, 10);
}

const today        = () => new Date().toISOString().slice(0, 10);
const daysBetween  = (a, b) => (new Date(b) - new Date(a)) / 86400000;

// ── Tool definitions (identical to v5.0) ─────────────────────────────────────
const TOOLS = [
  {
    name: "log_trade",
    description: "Log a new trade entry to the Notion trade journal.",
    inputSchema: {
      type: "object",
      properties: {
        symbol:             { type: "string" },
        side:               { type: "string", enum: ["buy","sell"] },
        quantity:           { type: "integer" },
        price:              { type: "number" },
        stop_loss:          { type: "number",  default: 0 },
        atr14:              { type: "number",  default: 0 },
        tier1_price:        { type: "number",  default: 0 },
        tier2_price:        { type: "number",  default: 0 },
        stock_tier:         { type: "integer", default: 3 },
        sector:             { type: "string",  default: "" },
        rsi_at_entry:       { type: "number",  default: 0 },
        guardrail_warnings: { type: "string",  default: "" },
        notes:              { type: "string",  default: "" },
      },
      required: ["symbol","side","quantity","price"],
    },
  },
  {
    name: "close_trade",
    description: "Mark an open trade as closed. Updates Status, Exit Price, Exit Date, Realized PnL, Tier Reached.",
    inputSchema: {
      type: "object",
      properties: {
        symbol:       { type: "string" },
        exit_price:   { type: "number" },
        tier_reached: { type: "integer", default: 0 },
        notes:        { type: "string",  default: "" },
      },
      required: ["symbol","exit_price"],
    },
  },
  {
    name: "get_open_trades",
    description: "List all open trades from the Notion Trade Journal.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_stats",
    description: "Compute trading stats from closed trades: win rate, P&L, tier hit rates, sector breakdown.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "integer", default: 30 },
      },
    },
  },
  {
    name: "log_rule_override",
    description: "Append a guardrail override note to a trade's Notes field.",
    inputSchema: {
      type: "object",
      properties: {
        rule_id: { type: "string" },
        symbol:  { type: "string", default: "" },
        reason:  { type: "string" },
        outcome: { type: "string", default: "pending" },
      },
      required: ["rule_id","reason"],
    },
  },
];

// ── Tool handlers (identical to v5.0) ─────────────────────────────────────────
async function handleLogTrade(args, apiKey, dbId) {
  const sym       = (args.symbol ?? "").toUpperCase();
  const side      = args.side ?? "buy";
  const qty       = args.quantity ?? 0;
  const price     = args.price ?? 0;
  const stopLoss  = args.stop_loss ?? 0;
  const atr14     = args.atr14 ?? 0;
  const t1        = args.tier1_price ?? 0;
  const t2        = args.tier2_price ?? 0;
  const stockTier = args.stock_tier ?? 3;
  const sector    = args.sector ?? "";
  const rsi       = args.rsi_at_entry ?? 0;
  const warnings  = args.guardrail_warnings ?? "";
  const notes     = args.notes ?? "";

  const entryDate    = today();
  const timeStopDate = addTradingDays(entryDate, TIME_STOP_DAYS);
  const tierLabel    = TIER_MAP[stockTier] ?? "T3 Mid Cap / Thematic";
  const sectorLabel  = SECTOR_MAP[sector.toLowerCase()] ?? "Tech";
  const tradeTitle   = `${sym} — ${side.charAt(0).toUpperCase() + side.slice(1)} ${qty}sh`;

  await createPage(dbId, {
    "Trade":              prop.title(tradeTitle),
    "Symbol":             prop.text(sym),
    "Side":               prop.sel(side.charAt(0).toUpperCase() + side.slice(1)),
    "Status":             prop.sel("Open"),
    "Stock Tier":         prop.sel(tierLabel),
    "Sector":             prop.sel(sectorLabel),
    "Entry Price":        prop.num(price),
    "Quantity":           prop.num(qty),
    "Stop Loss":          prop.num(stopLoss || null),
    "Tier 1 Target":      prop.num(t1 || null),
    "Tier 2 Target":      prop.num(t2 || null),
    "ATR14 at Entry":     prop.num(atr14 || null),
    "RSI at Entry":       prop.num(rsi || null),
    "Guardrail Warnings": prop.text(warnings),
    "Notes":              prop.text(notes),
    "Entry Date":         prop.date(entryDate),
    "Time Stop Date":     prop.date(timeStopDate),
  }, apiKey);

  const lines = [
    `Logged: ${side.toUpperCase()} ${qty} ${sym} @ $${price.toFixed(2)}`,
    `  Tier: ${tierLabel} | Sector: ${sectorLabel}`,
    `  Time stop: ${timeStopDate} (day ${TIME_STOP_DAYS})`,
  ];
  if (t1) lines.push(`  T1 target: $${t1.toFixed(2)} (+${TIER1_R}R) -> sell 40%`);
  if (t2) lines.push(`  T2 target: $${t2.toFixed(2)} (+${TIER2_R}R) -> sell 30%`);
  return lines.join("\n");
}

async function handleCloseTrade(args, apiKey, dbId) {
  const sym       = (args.symbol ?? "").toUpperCase();
  const exitPrice = args.exit_price ?? 0;
  const tierHit   = args.tier_reached ?? 0;
  const notes     = args.notes ?? "";

  const pages = await queryDatabase(dbId, {
    and: [
      { property: "Symbol", rich_text: { equals: sym } },
      { property: "Status", select:    { equals: "Open" } },
    ],
  }, apiKey);

  if (!pages.length) return `No open trade found for ${sym}`;

  const page       = pages[0];
  const p          = page.properties;
  const entryPrice = readNum(p["Entry Price"]);
  const qty        = readNum(p["Quantity"]);
  const side       = readSel(p["Side"]).toLowerCase();
  const entryDate  = readDate(p["Entry Date"]);
  const exitDate   = today();
  const holdDays   = entryDate ? daysBetween(entryDate, exitDate) : 0;
  const pnl        = side === "buy"
    ? (exitPrice - entryPrice) * qty
    : (entryPrice - exitPrice) * qty;

  const tierReachedMap = { 0: "None / Stopped", 1: "Tier 1", 2: "Tier 2", 3: "Tier 3" };
  const statusMap      = { 0: pnl >= 0 ? "Closed - Win" : "Closed - Loss", 1: "Closed - Win", 2: "Closed - Win", 3: "Closed - Win" };
  const existingNote   = readText(p["Notes"]);
  const updatedNotes   = notes
    ? (existingNote ? existingNote + "\n" : "") + notes
    : existingNote;

  await updatePage(page.id, {
    "Status":       prop.sel(statusMap[tierHit] ?? (pnl >= 0 ? "Closed - Win" : "Closed - Loss")),
    "Exit Price":   prop.num(exitPrice),
    "Realized PnL": prop.num(Math.round(pnl * 100) / 100),
    "Tier Reached": prop.sel(tierReachedMap[tierHit] ?? "None / Stopped"),
    "Exit Date":    prop.date(exitDate),
    "Notes":        prop.text(updatedNotes),
  }, apiKey);

  return `Closed ${sym}: ${pnl >= 0 ? "WIN" : "LOSS"} $${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} | Held ${holdDays.toFixed(1)}d | ${tierReachedMap[tierHit] ?? "None / Stopped"}`;
}

async function handleGetOpenTrades(apiKey, dbId) {
  const pages = await queryDatabase(dbId, {
    property: "Status", select: { equals: "Open" },
  }, apiKey);

  if (!pages.length) return "No open trades in journal.";

  const todayStr = today();
  const lines    = ["OPEN TRADES"];

  for (const page of pages) {
    const p         = page.properties;
    const sym       = readText(p["Symbol"]);
    const side      = readSel(p["Side"]);
    const qty       = readNum(p["Quantity"]);
    const price     = readNum(p["Entry Price"]);
    const tier      = readSel(p["Stock Tier"]);
    const sector    = readSel(p["Sector"]);
    const entryDate = readDate(p["Entry Date"]);
    const timeStop  = readDate(p["Time Stop Date"]);
    const t1        = readNum(p["Tier 1 Target"]);
    const t2        = readNum(p["Tier 2 Target"]);
    const stopLoss  = readNum(p["Stop Loss"]);
    const daysHeld  = entryDate ? daysBetween(entryDate, todayStr).toFixed(1) : "?";
    const daysLeft  = timeStop  ? daysBetween(todayStr, timeStop).toFixed(0)  : "?";

    let line = `  ${sym} ${side.toUpperCase()} ${qty}sh @ $${price.toFixed(2)} | ${tier} | ${sector} | Held ${daysHeld}d | Time stop: ${timeStop} (${daysLeft}d left)`;
    if (stopLoss) line += ` | Stop: $${stopLoss.toFixed(2)}`;
    if (t1)       line += ` | T1: $${t1.toFixed(2)}`;
    if (t2)       line += ` | T2: $${t2.toFixed(2)}`;
    lines.push(line);
  }
  return lines.join("\n");
}

async function handleGetStats(args, apiKey, dbId) {
  const days   = args.days ?? 30;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const pages = await queryDatabase(dbId, {
    and: [
      { property: "Status",    select: { does_not_equal: "Open" } },
      { property: "Exit Date", date:   { on_or_after: cutoff } },
    ],
  }, apiKey);

  if (!pages.length) return `No closed trades in last ${days} days.`;

  const trades = pages.map(page => {
    const p = page.properties;
    return {
      sym:         readText(p["Symbol"]),
      pnl:         readNum(p["Realized PnL"]),
      tier:        readSel(p["Stock Tier"]),
      sector:      readSel(p["Sector"]),
      tierReached: readSel(p["Tier Reached"]),
      entryDate:   readDate(p["Entry Date"]),
      exitDate:    readDate(p["Exit Date"]),
    };
  });

  const wins     = trades.filter(t => t.pnl > 0);
  const losses   = trades.filter(t => t.pnl <= 0);
  const total    = trades.length;
  const wr       = (wins.length / total * 100).toFixed(1);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin   = wins.length   ? wins.reduce((s,t)   => s + t.pnl, 0) / wins.length   : 0;
  const avgLoss  = losses.length ? losses.reduce((s,t) => s + t.pnl, 0) / losses.length : 0;
  const rr       = avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(1) : "N/A";

  const t1Hit = trades.filter(t => ["Tier 1","Tier 2","Tier 3"].includes(t.tierReached)).length;
  const t2Hit = trades.filter(t => ["Tier 2","Tier 3"].includes(t.tierReached)).length;
  const t3Hit = trades.filter(t => t.tierReached === "Tier 3").length;
  const tStop = trades.filter(t => t.tierReached === "None / Stopped").length;

  const tierStats = {};
  for (const t of trades) {
    if (!tierStats[t.tier]) tierStats[t.tier] = { wins: 0, total: 0, pnl: 0 };
    tierStats[t.tier].total++;
    tierStats[t.tier].pnl += t.pnl;
    if (t.pnl > 0) tierStats[t.tier].wins++;
  }

  const secStats = {};
  for (const t of trades) {
    if (!secStats[t.sector]) secStats[t.sector] = { total: 0, pnl: 0 };
    secStats[t.sector].total++;
    secStats[t.sector].pnl += t.pnl;
  }

  const symPnl = {};
  for (const t of trades) symPnl[t.sym] = (symPnl[t.sym] ?? 0) + t.pnl;
  const sorted = Object.entries(symPnl).sort((a, b) => b[1] - a[1]);

  const alerts = [];
  if (parseFloat(wr) < 45)                             alerts.push("Win rate below 45% — review entry criteria");
  if (rr !== "N/A" && parseFloat(rr) < 1.5 && total > 5) alerts.push("R/R below 1.5:1 — winners not big enough");
  if (tStop / total > 0.4)                             alerts.push(">40% time stops — entries may be too early");
  if (t1Hit / total < 0.5)                             alerts.push("T1 hit rate <50% — tighten entry criteria");
  if (!alerts.length)                                  alerts.push("Stats look healthy");

  const openPages = await queryDatabase(dbId, {
    property: "Status", select: { equals: "Open" },
  }, apiKey);

  const tierLines = Object.entries(tierStats).map(([tier, s]) =>
    `  ${tier}: ${s.total} trades | WR ${(s.wins/s.total*100).toFixed(0)}% | P&L $${s.pnl >= 0 ? "+" : ""}${s.pnl.toFixed(0)}`
  );
  const secLines = Object.entries(secStats)
    .sort((a, b) => b[1].pnl - a[1].pnl)
    .map(([sec, s]) => `  ${sec}: ${s.total} trades | $${s.pnl >= 0 ? "+" : ""}${s.pnl.toFixed(0)}`);

  return `TRADING STATS — last ${days} days
Trades: ${total} (${wins.length}W / ${losses.length}L) | Open: ${openPages.length}
Win rate: ${wr}% | Total P&L: $${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
Avg winner: $+${avgWin.toFixed(2)} | Avg loser: $${avgLoss.toFixed(2)}
R/R achieved: ${rr}:1

TIER EXIT PERFORMANCE
  T1 reached (+1.5R): ${t1Hit}/${total} (${(t1Hit/total*100).toFixed(0)}%)
  T2 reached (+2.5R): ${t2Hit}/${total} (${(t2Hit/total*100).toFixed(0)}%)
  T3 reached (trail): ${t3Hit}/${total} (${(t3Hit/total*100).toFixed(0)}%)
  Time stop fired:    ${tStop}/${total} (${(tStop/total*100).toFixed(0)}%)

BY STOCK TIER
${tierLines.join("\n") || "  No data"}

BY SECTOR
${secLines.join("\n") || "  No data"}

BEST/WORST SYMBOLS
  Best:  ${sorted[0]?.[0] ?? "N/A"} ($${(sorted[0]?.[1] ?? 0) >= 0 ? "+" : ""}${(sorted[0]?.[1] ?? 0).toFixed(0)})
  Worst: ${sorted[sorted.length-1]?.[0] ?? "N/A"} ($${(sorted[sorted.length-1]?.[1] ?? 0).toFixed(0)})

ALERTS
${alerts.map(a => `  ${a}`).join("\n")}`;
}

async function handleLogRuleOverride(args, apiKey, dbId) {
  const ruleId  = args.rule_id ?? "";
  const sym     = (args.symbol ?? "").toUpperCase();
  const reason  = args.reason ?? "";
  const outcome = args.outcome ?? "pending";

  if (sym) {
    const pages = await queryDatabase(dbId, {
      and: [
        { property: "Symbol", rich_text: { equals: sym } },
        { property: "Status", select:    { equals: "Open" } },
      ],
    }, apiKey);

    if (pages.length) {
      const page         = pages[0];
      const existingNote = readText(page.properties["Notes"]);
      const newNote      = `${existingNote ? existingNote + "\n" : ""}OVERRIDE ${ruleId}: ${reason} [outcome: ${outcome}] — ${today()}`;
      await updatePage(page.id, { "Notes": prop.text(newNote) }, apiKey);
      return `Override logged on ${sym} trade: ${ruleId} — update outcome when known.`;
    }
  }
  return `Override logged: ${ruleId} (${reason}) — outcome: ${outcome}`;
}

// ── MCP message router ────────────────────────────────────────────────────────
const mcpOk  = (id, result)         => ({ jsonrpc: "2.0", id, result });
const mcpErr = (id, code, message)  => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleMcpMessage(msg, env) {
  const { method, params, id } = msg;
  const apiKey = env.NOTION_API_KEY    ?? "";
  const dbId   = env.NOTION_DATABASE_ID ?? "";

  if (method === "initialize") {
    return mcpOk(id, {
      protocolVersion: "2024-11-05",
      capabilities:    { tools: {} },
      serverInfo:      { name: "trade-journal", version: "6.0" },
    });
  }
  if (method === "notifications/initialized") return null;
  if (method === "ping")        return mcpOk(id, {});
  if (method === "tools/list")  return mcpOk(id, { tools: TOOLS });

  if (method === "tools/call") {
    const { name, arguments: args } = params ?? {};
    try {
      let text;
      if      (name === "log_trade")          text = await handleLogTrade(args ?? {}, apiKey, dbId);
      else if (name === "close_trade")        text = await handleCloseTrade(args ?? {}, apiKey, dbId);
      else if (name === "get_open_trades")    text = await handleGetOpenTrades(apiKey, dbId);
      else if (name === "get_stats")          text = await handleGetStats(args ?? {}, apiKey, dbId);
      else if (name === "log_rule_override")  text = await handleLogRuleOverride(args ?? {}, apiKey, dbId);
      else return mcpErr(id, -32601, `Unknown tool: ${name}`);
      return mcpOk(id, { content: [{ type: "text", text }], isError: false });
    } catch (err) {
      return mcpErr(id, -32603, `Tool error: ${err.message}`);
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

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({
        status:          "ok",
        server:          "trade-journal",
        version:         "6.0",
        transport:       "Streamable HTTP",
        backend:         "Notion",
        notion_key_set:  !!env.NOTION_API_KEY,
        notion_db_set:   !!env.NOTION_DATABASE_ID,
      }), { headers: { "Content-Type": "application/json", ...CORS } });
    }

    // ── /mcp — Streamable HTTP transport ─────────────────────────────────────
    if (url.pathname === "/mcp") {

      // GET /mcp — minimal SSE response then close
      if (request.method === "GET") {
        const body = `data: ${JSON.stringify({
          jsonrpc: "2.0", method: "notifications/initialized", params: {}
        })}\n\n`;
        return new Response(body, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...CORS },
        });
      }

      // POST /mcp — handle JSON-RPC
      if (request.method === "POST") {
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
        const results = (await Promise.all(msgs.map(m => handleMcpMessage(m, env))))
          .filter(r => r !== null);

        const body = isBatch ? JSON.stringify(results) : JSON.stringify(results[0] ?? "");
        return new Response(body, {
          headers: { "Content-Type": "application/json", ...CORS },
        });
      }

      return new Response("Method not allowed", { status: 405, headers: CORS });
    }

    // Legacy /sse redirect
    if (url.pathname === "/sse") {
      return new Response(JSON.stringify({
        error:    "SSE transport deprecated",
        message:  "Update your config to use /mcp endpoint instead of /sse",
        new_url:  `${url.origin}/mcp`,
      }), { status: 301, headers: { "Content-Type": "application/json", ...CORS } });
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};

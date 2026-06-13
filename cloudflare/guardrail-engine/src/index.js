/**
 * Guardrail Engine — Cloudflare Worker
 * MCP Server over Streamable HTTP transport (replaces SSE)
 *
 * Version: 6.0
 * Transport: Streamable HTTP (MCP spec 2024-11-05)
 * All guardrail logic identical to v5.0 — only transport layer changed
 *
 * Deploy: npx wrangler deploy
 * Config: { "command": "npx", "args": ["-y", "mcp-remote", "https://guardrail-engine.tda-guardrails.workers.dev/mcp"] }
 */

// ── Constants ─────────────────────────────────────────────────────────────────
const TIER_CAPS        = { 1: 0.20, 2: 0.15, 3: 0.10, 4: 0.05 };
const TIER_LABELS      = {
  1: "T1 large cap stable (20%)",
  2: "T2 large cap growth (15%)",
  3: "T3 mid cap / thematic (10%)",
  4: "T4 small cap / ADR (5%)",
};
const RISK_CAP_PCT     = 0.01;
const DAILY_LOSS_MULT  = 2.0;
const CASH_RESERVE_PCT = 0.10;
const MAX_MARGIN_PCT   = 0.25;
const ATR_MULT         = 2.0;
const MIN_ATR_MULT     = 1.0;
const MAX_ATR_MULT     = 3.0;
const PENNY_MIN        = 5.0;
const MAX_POSITIONS    = 10;
const MIN_RR           = 1.7;
const TIER1_R          = 1.5;
const TIER2_R          = 2.5;
const LEVERAGED_KW     = ["2x","3x","ultra","daily","leveraged","inverse","bear","bull","-2","-3"];
const OTC_SUFFIXES     = [".OTC",".PK",".PINK"];

const SECTOR_CAPS = {
  tech:             0.46,
  financials:       0.19,
  communications:   0.13,
  consumer:         0.10,
  healthcare:       0.09,
  industrials:      0.08,
  consumer_staples: 0.06,
  energy:           0.03,
  materials:        0.02,
  real_estate:      0.02,
  utilities:        0.02,
};
const SECTOR_CAP_DEFAULT = 0.05;
const SECTOR_CAP_FLOOR   = 0.02;
const SECTOR_CAP_CEILING = 0.50;

// ── Helpers ───────────────────────────────────────────────────────────────────
const r   = (n, d = 2) => Math.round(n * 10**d) / 10**d;
const fmt = n => n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

function calcLimits(equity) {
  return {
    risk_cap:     r(equity * RISK_CAP_PCT),
    daily_limit:  r(equity * RISK_CAP_PCT * DAILY_LOSS_MULT),
    cash_reserve: r(equity * CASH_RESERVE_PCT),
    max_margin:   r(equity * MAX_MARGIN_PCT),
    t1_cap:       r(equity * TIER_CAPS[1]),
    t2_cap:       r(equity * TIER_CAPS[2]),
    t3_cap:       r(equity * TIER_CAPS[3]),
    t4_cap:       r(equity * TIER_CAPS[4]),
  };
}

function tierCap(equity, tier) {
  return r(equity * (TIER_CAPS[tier] ?? TIER_CAPS[3]));
}

function calcAtrStop(price, atr14) {
  const dist = r(ATR_MULT * atr14);
  return {
    stop_price:    r(price - dist),
    stop_distance: dist,
    min_stop:      r(price - MIN_ATR_MULT * atr14),
    max_stop:      r(price - MAX_ATR_MULT * atr14),
  };
}

function calcShares(price, atr14, riskCap, posCap) {
  const dist       = ATR_MULT * atr14;
  const riskShares = dist > 0 ? Math.floor(riskCap / dist) : 0;
  const sizeShares = price > 0 ? Math.floor(posCap / price) : 0;
  const shares     = Math.min(riskShares, sizeShares);
  return {
    shares,
    position_value: r(shares * price),
    actual_risk:    r(shares * dist),
    stop_distance:  r(dist),
    tier1_price:    r(price + TIER1_R * dist),
    tier2_price:    r(price + TIER2_R * dist),
  };
}

function getSectorCap(equity, sector) {
  const key = (sector || "").toLowerCase().replace(/[\s-]/g, "_");
  let pct   = SECTOR_CAPS[key] ?? SECTOR_CAP_DEFAULT;
  pct       = Math.max(SECTOR_CAP_FLOOR, Math.min(SECTOR_CAP_CEILING, pct));
  return { pct, amount: r(equity * pct), label: `${(pct*100).toFixed(0)}% dynamic cap` };
}

const isLeveraged = (name, ticker) =>
  LEVERAGED_KW.some(kw => (name + " " + ticker).toLowerCase().includes(kw));

const isOtc = ticker =>
  OTC_SUFFIXES.some(s => ticker.toUpperCase().endsWith(s));

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "check_guardrails",
    description: "Run guardrail rule engine before any trade. All limits calculated from equity_value. Returns PASS or BLOCK. BLOCK verdicts cannot be overridden.",
    inputSchema: {
      type: "object",
      properties: {
        symbol:                  { type: "string" },
        symbol_name:             { type: "string", default: "" },
        side:                    { type: "string", enum: ["buy","sell"] },
        quantity:                { type: "integer" },
        price:                   { type: "number" },
        equity_value:            { type: "number" },
        total_value:             { type: "number", default: 0 },
        stop_loss_price:         { type: "number", default: 0 },
        atr14:                   { type: "number", default: 0 },
        stock_tier:              { type: "integer", default: 3 },
        sector:                  { type: "string", default: "" },
        sector_current_exposure: { type: "number", default: 0 },
        positions_count:         { type: "integer" },
        daily_pnl:               { type: "number" },
        account_cash:            { type: "number" },
        avg_cost_in_symbol:      { type: "number", default: 0 },
        times_averaged_down:     { type: "integer", default: 0 },
        stop_fired_within_48h:   { type: "boolean", default: false },
        exited_today:            { type: "boolean", default: false },
        is_extended_hours:       { type: "boolean", default: false },
      },
      required: ["symbol","side","quantity","price","equity_value","positions_count","daily_pnl","account_cash"],
    },
  },
  {
    name: "get_rules",
    description: "List all active guardrail rules with thresholds calculated from equity_value.",
    inputSchema: {
      type: "object",
      properties: {
        equity_value: { type: "number", default: 37000 },
      },
    },
  },
];

// ── Tool handlers (identical to v5.0) ─────────────────────────────────────────
function handleGetRules(args) {
  const ev     = args.equity_value ?? 37000;
  const limits = calcLimits(ev);
  return [
    `ACTIVE GUARDRAIL RULES  (equity: $${fmt(ev)})`,
    `Risk cap (1%):      $${fmt(limits.risk_cap)} per trade`,
    `Daily loss limit:   $${fmt(limits.daily_limit)} (2x risk cap)`,
    `Cash reserve (10%): $${fmt(limits.cash_reserve)}`,
    `Max margin (25%):   $${fmt(limits.max_margin)}`,
    `Min R/R:            ${MIN_RR}:1`,
    "",
    "POSITION TIER CAPS",
    `  T1 large cap stable:  $${fmt(limits.t1_cap)} (20%)`,
    `  T2 large cap growth:  $${fmt(limits.t2_cap)} (15%)`,
    `  T3 mid/thematic:      $${fmt(limits.t3_cap)} (10%)`,
    `  T4 small/ADR/spec:    $${fmt(limits.t4_cap)}  (5%)`,
    "",
    "HARD BLOCKS",
    "  [H1]  No trading while driving (weekday 7am-6pm CT)",
    "  [H2]  No new positions after 9pm CT",
    `  [H3]  Daily loss limit $${fmt(limits.daily_limit)}`,
    `  [H4]  Max ${MAX_POSITIONS} open positions`,
    "  [H5]  Leveraged/inverse ETF — decay risk",
    "  [H6]  48h stop-loss cooldown",
    "  [H7]  Max 2 average-downs on losing position",
    "  [H8]  Penny stock price < $5",
    "  [H9]  OTC/pink sheet",
    `  [H10] Margin usage > $${fmt(limits.max_margin)} (25% of equity)`,
    "",
    "WARNINGS",
    "  [W1]  Position exceeds tier cap",
    "  [W2]  Averaging down on underwater position",
    "  [W3]  Any margin in use",
    "  [W4]  No stop-loss set — use 2x ATR14",
    "  [W5]  Same-day re-entry",
    "  [W6]  Extended hours entry",
    "  [W7]  Sector concentration dynamic caps",
  ].join("\n");
}

function handleCheckGuardrails(args) {
  const sym            = (args.symbol ?? "").toUpperCase();
  const symName        = args.symbol_name ?? "";
  const side           = args.side;
  const qty            = args.quantity;
  const price          = args.price;
  const equity         = args.equity_value;
  const totalValue     = args.total_value ?? equity;
  const stopLoss       = args.stop_loss_price ?? 0;
  const atr14          = args.atr14 ?? 0;
  const stockTier      = args.stock_tier ?? 3;
  const sector         = (args.sector ?? "").toLowerCase();
  const sectorExposure = args.sector_current_exposure ?? 0;
  const posCount       = args.positions_count ?? 0;
  const dailyPnl       = args.daily_pnl ?? 0;
  const cash           = args.account_cash ?? 0;
  const avgCost        = args.avg_cost_in_symbol ?? 0;
  const timesAvgDown   = args.times_averaged_down ?? 0;
  const stopFired      = args.stop_fired_within_48h ?? false;
  const exitedToday    = args.exited_today ?? false;
  const isExt          = args.is_extended_hours ?? false;

  const limits     = calcLimits(equity);
  const posCap     = tierCap(equity, stockTier);
  const marginUsed = Math.max(0, totalValue - equity - Math.max(0, cash));
  const tradeValue = qty * price;

  const nowUtc    = new Date();
  const isWeekday = nowUtc.getUTCDay() >= 1 && nowUtc.getUTCDay() <= 5;
  const hourCt    = (nowUtc.getUTCHours() - 5 + 24) % 24;

  const blocks   = [];
  const warnings = [];

  if (side === "buy") {
    if (isWeekday && hourCt >= 7 && hourCt <= 18)
      blocks.push(["H1", `Weekday ${hourCt}:00 CT — confirm you're not driving`]);
    if (hourCt >= 21 || hourCt < 6)
      blocks.push(["H2", `${hourCt}:00 CT — new positions blocked after 9pm`]);
    if (dailyPnl <= -limits.daily_limit)
      blocks.push(["H3", `Daily P&L $${fmt(dailyPnl)} hit limit $${fmt(limits.daily_limit)}`]);
    if (posCount >= MAX_POSITIONS)
      blocks.push(["H4", `${posCount} positions open — max is ${MAX_POSITIONS}`]);
    if (isLeveraged(symName, sym))
      blocks.push(["H5", `${sym} is leveraged/daily ETF — decay risk`]);
    if (stopFired)
      blocks.push(["H6", `Stop fired on ${sym} within 48h — re-entry locked`]);
    if (timesAvgDown >= 2 && avgCost > 0 && price < avgCost)
      blocks.push(["H7", `Averaged down ${timesAvgDown}x already — hard limit is 2`]);
    if (price < PENNY_MIN)
      blocks.push(["H8", `$${price.toFixed(2)} below $${PENNY_MIN} penny stock threshold`]);
    if (isOtc(sym))
      blocks.push(["H9", `${sym} appears to be OTC/pink sheet`]);
    if (marginUsed > limits.max_margin)
      blocks.push(["H10", `Margin ~$${fmt(marginUsed)} exceeds 25% cap $${fmt(limits.max_margin)}`]);

    if (tradeValue > posCap)
      warnings.push(["W1", `$${fmt(tradeValue)} exceeds ${TIER_LABELS[stockTier] ?? "T3"} cap $${fmt(posCap)}`]);
    if (avgCost > 0 && price < avgCost && timesAvgDown < 2) {
      const pct = ((price - avgCost) / avgCost * 100).toFixed(1);
      warnings.push(["W2", `Position already down ${pct}% (avg $${avgCost.toFixed(2)})`]);
    }
    if (cash < 0)
      warnings.push(["W3", `Account using $${fmt(Math.abs(cash))} in margin`]);
    if (!stopLoss) {
      if (atr14 > 0) {
        const s = calcAtrStop(price, atr14);
        warnings.push(["W4",
          `No stop set — suggested $${s.stop_price.toFixed(2)} ` +
          `(2x ATR14 $${atr14.toFixed(2)} = $${s.stop_distance.toFixed(2)} below). ` +
          `Range: $${s.min_stop.toFixed(2)}-$${s.max_stop.toFixed(2)}`]);
      } else {
        warnings.push(["W4", "No stop set — pull ATR14 and set at 2x ATR14 below entry"]);
      }
    }
    if (exitedToday)
      warnings.push(["W5", `Already exited ${sym} today — what changed?`]);
    if (isExt)
      warnings.push(["W6", "Extended hours — wider spreads, thinner liquidity"]);
    if (sector) {
      const sc       = getSectorCap(equity, sector);
      const newTotal = sectorExposure + tradeValue;
      if (newTotal > sc.amount) {
        const pct = (newTotal / equity * 100).toFixed(1);
        warnings.push(["W7",
          `${sector} sector would be $${fmt(newTotal)} (${pct}%) — ` +
          `dynamic cap is ${sc.label} ($${fmt(sc.amount)})`]);
      }
    }
  }

  let rrNote = "", tierNote = "", sizingNote = "";
  const effStop = stopLoss || (atr14 > 0 ? calcAtrStop(price, atr14).stop_price : 0);
  if (effStop && effStop < price) {
    const risk     = price - effStop;
    const rrTarget = price + risk * MIN_RR;
    const rrPct    = (risk / price * 100).toFixed(1);
    rrNote         = `\nR/R: risk $${risk.toFixed(2)} (${rrPct}%), need >= $${rrTarget.toFixed(2)} for ${MIN_RR}:1`;
    const t1       = r(price + TIER1_R * risk);
    const t2       = r(price + TIER2_R * risk);
    tierNote       = `\nTier exits:\n  T1 (+${TIER1_R}R): $${t1} -> sell 40%, stop to breakeven\n  T2 (+${TIER2_R}R): $${t2} -> sell 30%, trail 1x ATR14\n  T3: trail 30% at 2x ATR14 | Time stop: day 7 if T1 not hit`;
  }
  if (atr14 > 0) {
    const s = calcShares(price, atr14, limits.risk_cap, posCap);
    sizingNote = `\nSizing: ${s.shares} shares | Position $${fmt(s.position_value)} | Risk $${fmt(s.actual_risk)} | Stop $${r(price - s.stop_distance).toFixed(2)}`;
  }

  const verdict = blocks.length > 0 ? "BLOCK" : (warnings.length > 0 ? "PASS with warnings" : "PASS");
  const lines   = [
    `GUARDRAIL CHECK: ${side.toUpperCase()} ${qty} ${sym} @ $${price.toFixed(2)}`,
    `Equity: $${fmt(equity)} | Tier: ${TIER_LABELS[stockTier] ?? "T3"} cap $${fmt(posCap)} | Risk cap: $${fmt(limits.risk_cap)}`,
    `VERDICT: ${verdict}${rrNote}${tierNote}${sizingNote}`,
    "",
  ];
  if (blocks.length > 0) {
    lines.push("BLOCKS:");
    blocks.forEach(([id, msg]) => lines.push(`  x ${id}: ${msg}`));
  }
  if (warnings.length > 0) {
    lines.push("\nWARNINGS:");
    warnings.forEach(([id, msg]) => lines.push(`  ! ${id}: ${msg}`));
  }
  if (blocks.length === 0 && warnings.length === 0) lines.push("All rules passed.");
  lines.push(`\nChecked ${nowUtc.toISOString().slice(11,16)} UTC | v6.0`);
  return lines.join("\n");
}

// ── MCP message router ────────────────────────────────────────────────────────
function mcpOk(id, result)          { return { jsonrpc: "2.0", id, result }; }
function mcpErr(id, code, message)  { return { jsonrpc: "2.0", id, error: { code, message } }; }

function handleMcpMessage(msg) {
  const { method, params, id } = msg;

  if (method === "initialize") {
    return mcpOk(id, {
      protocolVersion: "2024-11-05",
      capabilities:    { tools: {} },
      serverInfo:      { name: "guardrail-engine", version: "6.0" },
    });
  }
  if (method === "notifications/initialized") return null;
  if (method === "ping")         return mcpOk(id, {});
  if (method === "tools/list")   return mcpOk(id, { tools: TOOLS });

  if (method === "tools/call") {
    const { name, arguments: args } = params ?? {};
    try {
      let text;
      if      (name === "get_rules")          text = handleGetRules(args ?? {});
      else if (name === "check_guardrails")   text = handleCheckGuardrails(args ?? {});
      else return mcpErr(id, -32601, `Unknown tool: ${name}`);
      return mcpOk(id, { content: [{ type: "text", text }], isError: false });
    } catch (err) {
      return mcpErr(id, -32603, String(err.message));
    }
  }

  return mcpErr(id, -32601, `Unknown method: ${method}`);
}

// ── Cloudflare Worker export ───────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: CORS });

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({
        status: "ok", server: "guardrail-engine",
        version: "6.0", transport: "Streamable HTTP",
      }), { headers: { "Content-Type": "application/json", ...CORS } });
    }

    // ── /mcp — Streamable HTTP transport ─────────────────────────────────────
    // GET  → server capabilities (SSE stream for notifications — we return minimal)
    // POST → MCP JSON-RPC message
    if (url.pathname === "/mcp") {

      // GET /mcp — return minimal SSE with server info then close
      if (request.method === "GET") {
        const body = `data: ${JSON.stringify({
          jsonrpc: "2.0", method: "notifications/initialized", params: {}
        })}\n\n`;
        return new Response(body, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            ...CORS,
          },
        });
      }

      // POST /mcp — handle JSON-RPC message
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

        // Handle batch (array) or single message
        const isBatch = Array.isArray(msg);
        const msgs    = isBatch ? msg : [msg];
        const results = msgs
          .map(handleMcpMessage)
          .filter(r => r !== null);

        const body = isBatch ? JSON.stringify(results) : JSON.stringify(results[0] ?? "");
        return new Response(body, {
          headers: { "Content-Type": "application/json", ...CORS },
        });
      }

      return new Response("Method not allowed", { status: 405, headers: CORS });
    }

    // Legacy /sse — redirect to /mcp with a helpful message
    if (url.pathname === "/sse") {
      return new Response(JSON.stringify({
        error: "SSE transport deprecated",
        message: "Update your config to use /mcp endpoint instead of /sse",
        new_url: `${url.origin}/mcp`,
      }), { status: 301, headers: { "Content-Type": "application/json", ...CORS } });
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};

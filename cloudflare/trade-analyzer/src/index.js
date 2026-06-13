/**
 * Trade Analyzer — Cloudflare Worker
 * MCP Server over Streamable HTTP transport (replaces SSE)
 *
 * Version: 5.0
 * All analysis logic identical to v4.0 — only transport layer changed
 *
 * Required secret (unchanged):
 *   wrangler secret put POLYGON_API_KEY
 *
 * Deploy: npx wrangler deploy
 * Config: { "command": "npx", "args": ["-y", "mcp-remote", "https://trade-analyzer.tda-guardrails.workers.dev/mcp"] }
 */

const BASE           = "https://api.polygon.io";
const TIER_CAPS      = { 1: 0.20, 2: 0.15, 3: 0.10, 4: 0.05 };
const TIER_LABELS    = {
  1: "T1 large cap stable",
  2: "T2 large cap growth",
  3: "T3 mid cap / thematic",
  4: "T4 small cap / ADR",
};
const RISK_CAP_PCT   = 0.01;
const SECTOR_CAP_PCT = 0.25;
const MAX_MARGIN_PCT = 0.25;
const ATR_MULT       = 2.0;
const TIER1_R        = 1.5;
const TIER2_R        = 2.5;
const PENNY_MIN      = 5.0;
const MAX_POSITIONS  = 6;
const MIN_RR         = 1.7;
const LEVERAGED_KW   = ["2x","3x","ultra","daily","leveraged","inverse","bear","bull","-2","-3"];

// ── Helpers ───────────────────────────────────────────────────────────────────
const r   = (n, d = 2) => Math.round(n * 10**d) / 10**d;
const fmt = n => n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

async function polyFetch(path, params, apiKey) {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("apiKey", apiKey);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  try {
    const res = await fetch(url.toString(), { cf: { cacheTtl: 60 } });
    return res.ok ? res.json() : {};
  } catch { return {}; }
}

function calcLimits(equity, tier) {
  const riskCap = r(equity * RISK_CAP_PCT);
  const posCap  = r(equity * (TIER_CAPS[tier] ?? TIER_CAPS[3]));
  return {
    risk_cap:    riskCap,
    daily_limit: r(riskCap * 2),
    pos_cap:     posCap,
    sector_cap:  r(equity * SECTOR_CAP_PCT),
    max_margin:  r(equity * MAX_MARGIN_PCT),
  };
}

function autoAssignTier(marketCap, beta) {
  if (!marketCap)                             return 3;
  if (marketCap > 200e9 && beta < 1.2)       return 1;
  if (marketCap > 50e9)                       return 2;
  if (marketCap >= 2e9)                       return 3;
  return 4;
}

function calcAtr14(bars) {
  const sorted = [...bars].reverse();
  const trs = [];
  for (let i = 1; i < sorted.length; i++) {
    const { h, l } = sorted[i];
    const pc = sorted[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < 14) return 0;
  let atr = trs.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
  for (const tr of trs.slice(14)) atr = (atr * 13 + tr) / 14;
  return r(atr);
}

function scoreRsi(v) {
  if (v >= 70) return `${v.toFixed(1)} — OVERBOUGHT`;
  if (v <= 30) return `${v.toFixed(1)} — OVERSOLD (potential bounce)`;
  if (v >= 60) return `${v.toFixed(1)} — elevated, watch for reversal`;
  if (v <= 40) return `${v.toFixed(1)} — low, building momentum`;
  return `${v.toFixed(1)} — neutral`;
}

function scoreMacd(macd, signal, hist) {
  if (macd > signal && hist > 0) return `BULLISH — ${macd.toFixed(2)} above signal ${signal.toFixed(2)}`;
  if (macd < signal && hist < 0) return `BEARISH — ${macd.toFixed(2)} below signal ${signal.toFixed(2)}`;
  return `NEUTRAL — converging (hist ${hist.toFixed(2)})`;
}

function scoreNews(articles, symbol) {
  if (!articles?.length) return "No news in last 48h";
  const relevant = [];
  for (const a of articles.slice(0, 5)) {
    for (const ins of (a.insights ?? [])) {
      if (ins.ticker === symbol)
        relevant.push(`${ins.sentiment.toUpperCase()}: ${(a.title ?? "").slice(0, 80)}`);
    }
  }
  return relevant.length
    ? relevant.slice(0, 3).join(" | ")
    : `${articles.length} articles, none ${symbol}-specific`;
}

function fmtMarketCap(mc) {
  if (!mc)        return "unavailable";
  if (mc >= 1e12) return `$${(mc / 1e12).toFixed(1)}T`;
  if (mc >= 1e9)  return `$${(mc / 1e9).toFixed(1)}B`;
  return `$${(mc / 1e6).toFixed(0)}M`;
}

function runGuardrails(args, limits, hourCt, isWeekday) {
  const { sym, side, qty, price, equity, totalValue, posCount,
          dailyPnl, cash, isLeveragedEtf, sector,
          sectorExposure, stockTier } = args;
  const blocks   = [];
  const tradeVal = qty * price;
  const marginUsd = Math.max(0, totalValue - equity - Math.max(0, cash));

  if (side === "buy") {
    if (isWeekday && hourCt >= 7 && hourCt <= 18)
      blocks.push("H1: Possible driving hours — confirm at computer");
    const hourUtc = (hourCt + 5) % 24;
    if (hourUtc >= 21 || hourUtc < 6)
      blocks.push("H2: After 9pm CT — new positions blocked");
    if (dailyPnl <= -limits.daily_limit)
      blocks.push(`H3: Daily loss limit hit ($${fmt(dailyPnl)} vs $${fmt(limits.daily_limit)})`);
    if (posCount >= MAX_POSITIONS)
      blocks.push(`H4: ${posCount}/${MAX_POSITIONS} positions open`);
    if (isLeveragedEtf)
      blocks.push("H5: Leveraged/inverse ETF — daily decay risk");
    if (price < PENNY_MIN)
      blocks.push(`H8: $${price.toFixed(2)} below $${PENNY_MIN} penny threshold`);
    if (marginUsd > limits.max_margin)
      blocks.push(`H10: Margin ~$${fmt(marginUsd)} exceeds 25% cap $${fmt(limits.max_margin)}`);
    if (tradeVal > limits.pos_cap) {
      const pct = (tradeVal / equity * 100).toFixed(1);
      blocks.push(`W1: $${fmt(tradeVal)} (${pct}%) exceeds ${TIER_LABELS[stockTier]} cap $${fmt(limits.pos_cap)}`);
    }
    if (cash < 0)
      blocks.push(`W3: Using $${fmt(Math.abs(cash))} margin`);
    if (sector) {
      const newTotal = sectorExposure + tradeVal;
      if (newTotal > limits.sector_cap) {
        const pct = (newTotal / equity * 100).toFixed(1);
        blocks.push(`W7: ${sector} sector -> $${fmt(newTotal)} (${pct}%) exceeds 25% cap`);
      }
    }
  }
  return blocks;
}

// ── Tool definition (identical to v4.0) ──────────────────────────────────────
const TOOLS = [{
  name: "analyze_trade",
  description: "Run complete pre-trade research + guardrail check. Fetches ATR14 (calculated from OHLCV), RSI, MACD, news, market cap, beta. Auto-assigns stock tier. Calculates tier-based position size, ATR stop, and 3-tier profit targets. Returns ~200 token brief.",
  inputSchema: {
    type: "object",
    properties: {
      symbol:                  { type: "string" },
      side:                    { type: "string", enum: ["buy","sell"] },
      quantity:                { type: "integer" },
      price:                   { type: "number" },
      equity_value:            { type: "number" },
      total_value:             { type: "number", default: 0 },
      positions_count:         { type: "integer" },
      daily_pnl:               { type: "number" },
      account_cash:            { type: "number" },
      avg_cost:                { type: "number", default: 0 },
      is_leveraged_etf:        { type: "boolean", default: false },
      sector:                  { type: "string", default: "" },
      sector_current_exposure: { type: "number", default: 0 },
      stock_tier_override:     { type: "integer", default: 0 },
    },
    required: ["symbol","side","quantity","price","equity_value","positions_count","daily_pnl","account_cash"],
  },
}];

// ── Main handler (identical to v4.0) ─────────────────────────────────────────
async function handleAnalyzeTrade(args, apiKey) {
  const sym            = (args.symbol ?? "").toUpperCase();
  const side           = args.side;
  const qty            = args.quantity;
  const price          = args.price;
  const equity         = args.equity_value;
  const totalValue     = args.total_value ?? equity;
  const posCount       = args.positions_count ?? 0;
  const dailyPnl       = args.daily_pnl ?? 0;
  const cash           = args.account_cash ?? 0;
  const avgCost        = args.avg_cost ?? 0;
  const isLeveragedEtf = args.is_leveraged_etf ?? false;
  const sector         = (args.sector ?? "").toLowerCase();
  const sectorExposure = args.sector_current_exposure ?? 0;
  const tierOverride   = args.stock_tier_override ?? 0;

  const now       = new Date();
  const isWeekday = now.getUTCDay() >= 1 && now.getUTCDay() <= 5;
  const hourCt    = (now.getUTCHours() - 5 + 24) % 24;
  const today     = now.toISOString().slice(0, 10);
  const monthAgo  = new Date(now - 35 * 86400000).toISOString().slice(0, 10);
  const since48h  = new Date(now - 48 * 3600000).toISOString();

  const [rsiData, macdData, newsData, aggData, refData] = await Promise.all([
    polyFetch(`/v1/indicators/rsi/${sym}`,  { timespan: "day", window: 14, limit: 1, series_type: "close" }, apiKey),
    polyFetch(`/v1/indicators/macd/${sym}`, { timespan: "day", short_window: 12, long_window: 26, signal_window: 9, limit: 1, series_type: "close" }, apiKey),
    polyFetch("/v2/reference/news",          { ticker: sym, "published_utc.gte": since48h, limit: 5, order: "desc" }, apiKey),
    polyFetch(`/v2/aggs/ticker/${sym}/range/1/day/${monthAgo}/${today}`, { adjusted: "true", sort: "desc", limit: 20 }, apiKey),
    polyFetch(`/vX/reference/tickers/${sym}`, {}, apiKey),
  ]);

  const rsiVals  = rsiData?.results?.values ?? [];
  const rsiStr   = rsiVals.length ? scoreRsi(rsiVals[0].value) : "unavailable";

  const macdVals = macdData?.results?.values ?? [];
  const macdStr  = macdVals.length
    ? scoreMacd(macdVals[0].value, macdVals[0].signal, macdVals[0].histogram)
    : "unavailable";

  const bars  = (aggData?.results ?? []).map(b => ({ h: b.h, l: b.l, c: b.c, o: b.o }));
  const atr14 = bars.length >= 15 ? calcAtr14(bars) : 0;

  const tickerInfo = refData?.results ?? {};
  const marketCap  = tickerInfo.market_cap ?? 0;
  const beta       = 1.0;

  const autoTier  = autoAssignTier(marketCap, beta);
  const stockTier = (tierOverride >= 1 && tierOverride <= 4) ? tierOverride : autoTier;
  const tierSrc   = (tierOverride >= 1 && tierOverride <= 4) ? "override" : "auto-assigned";

  const limits = calcLimits(equity, stockTier);

  let sizingStr = "ATR14 unavailable — pull manually";
  let tierStr   = "Cannot calculate — ATR14 required";
  let rrStr     = "Cannot calculate";

  if (atr14 > 0) {
    const stopDist   = ATR_MULT * atr14;
    const stopPrice  = r(price - stopDist);
    const riskShares = Math.floor(limits.risk_cap / stopDist);
    const sizeShares = Math.floor(limits.pos_cap / price);
    const shares     = Math.min(riskShares, sizeShares);
    const posVal     = r(shares * price);
    const actualRisk = r(shares * stopDist);
    const t1Price    = r(price + TIER1_R * stopDist);
    const t2Price    = r(price + TIER2_R * stopDist);
    const rr         = stopPrice < price ? ((t1Price - price) / (price - stopPrice)).toFixed(1) : "0";

    sizingStr = `$${atr14.toFixed(2)} ATR14 | Stop: $${stopPrice.toFixed(2)} (-$${stopDist.toFixed(2)})\n  Shares: ${shares} | Position: $${fmt(posVal)} | Risk: $${fmt(actualRisk)}`;
    tierStr   = `T1 (+${TIER1_R}R): $${t1Price.toFixed(2)} -> sell 40%, stop->breakeven\n  T2 (+${TIER2_R}R): $${t2Price.toFixed(2)} -> sell 30%, trail 1xATR\n  T3: trail 30% at 2xATR14 | Time stop: day 7 if T1 not hit`;
    rrStr     = `${rr}:1 to T1 (min ${MIN_RR}:1)`;
  }

  const newsStr = scoreNews(newsData?.results ?? [], sym);

  const barsArr = aggData?.results ?? [];
  let trendStr  = `~$${price.toFixed(2)}`;
  if (barsArr.length >= 2) {
    const chg = ((barsArr[0].c - barsArr[1].c) / barsArr[1].c * 100).toFixed(1);
    trendStr  = `Last close $${barsArr[0].c.toFixed(2)} (${chg > 0 ? "+" : ""}${chg}% vs prev)`;
  }

  const guardArgs   = { sym, side, qty, price, equity, totalValue, posCount,
                        dailyPnl, avgCost, cash, isLeveragedEtf, sector,
                        sectorExposure, stockTier };
  const guardBlocks = runGuardrails(guardArgs, limits, hourCt, isWeekday);
  const guardStr    = guardBlocks.length === 0
    ? "ALL PASS"
    : "\n  ! " + guardBlocks.join("\n  ! ");
  const verdict     = guardBlocks.length === 0 ? "CLEAR" : "BLOCKED — resolve issues above";

  return `TRADE BRIEF: ${side.toUpperCase()} ${sym} @ $${price.toFixed(2)}
Equity: $${fmt(equity)} | Tier: ${TIER_LABELS[stockTier]} (${tierSrc}) | Cap: $${fmt(limits.pos_cap)}
Market cap: ${fmtMarketCap(marketCap)}

POSITION SIZING
  ${sizingStr}
  R/R: ${rrStr}

TIER EXIT TARGETS
  ${tierStr}

TECHNICALS
  RSI(14): ${rsiStr}
  MACD:    ${macdStr}
  Price:   ${trendStr}

NEWS (48h)
  ${newsStr}

ACCOUNT STATE
  Positions: ${posCount}/${MAX_POSITIONS} | P&L today: $${dailyPnl >= 0 ? "+" : ""}${fmt(dailyPnl)}
  Cash: $${fmt(cash)} | Daily limit: $${fmt(limits.daily_limit)}
  ${sector ? `Sector (${sector}): $${fmt(sectorExposure)} current / $${fmt(limits.sector_cap)} cap` : ""}

GUARDRAILS
  ${guardStr}

VERDICT: ${verdict}`;
}

// ── MCP message router ────────────────────────────────────────────────────────
const mcpOk  = (id, result)        => ({ jsonrpc: "2.0", id, result });
const mcpErr = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleMcpMessage(msg, apiKey) {
  const { method, params, id } = msg;

  if (method === "initialize") {
    return mcpOk(id, {
      protocolVersion: "2024-11-05",
      capabilities:    { tools: {} },
      serverInfo:      { name: "trade-analyzer", version: "5.0" },
    });
  }
  if (method === "notifications/initialized") return null;
  if (method === "ping")        return mcpOk(id, {});
  if (method === "tools/list")  return mcpOk(id, { tools: TOOLS });

  if (method === "tools/call") {
    const { name, arguments: args } = params ?? {};
    if (name !== "analyze_trade")
      return mcpErr(id, -32601, `Unknown tool: ${name}`);
    try {
      const text = await handleAnalyzeTrade(args ?? {}, apiKey);
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

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({
        status:          "ok",
        server:          "trade-analyzer",
        version:         "5.0",
        transport:       "Streamable HTTP",
        polygon_key_set: !!env.POLYGON_API_KEY,
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
        const results = (await Promise.all(
          msgs.map(m => handleMcpMessage(m, env.POLYGON_API_KEY ?? ""))
        )).filter(r => r !== null);

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
        error:   "SSE transport deprecated",
        message: "Update your config to use /mcp endpoint instead of /sse",
        new_url: `${url.origin}/mcp`,
      }), { status: 301, headers: { "Content-Type": "application/json", ...CORS } });
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};

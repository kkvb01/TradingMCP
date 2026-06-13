"""
Custom MCP 1: trade_analyzer
============================
Single tool call → complete pre-trade research brief + guardrail verdict.

Version: 4.0
Updated: 2026-06-07
Changes:
  - equity_value replaces account_value — margin excluded from all limits
  - stock_tier + sector + sector_current_exposure params added
  - Tier cap auto-applied to share count calculation
  - Dollar risk cap = 1% of equity (was 15% × 7%)
  - Market cap + beta fetched to support tier auto-assignment
  - Sector cap check (W7) added to guardrail section
  - H10 margin cap check added
"""

import asyncio
import os
from datetime import datetime, timedelta, timezone
import httpx
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

POLYGON_KEY = os.environ.get("POLYGON_API_KEY", "")
BASE        = "https://api.polygon.io"

TIER_CAPS   = {1: 0.20, 2: 0.15, 3: 0.10, 4: 0.05}
TIER_LABELS = {
    1: "T1 large cap stable",
    2: "T2 large cap growth",
    3: "T3 mid cap / thematic",
    4: "T4 small cap / ADR",
}
RISK_CAP_PCT   = 0.01
DAILY_LOSS_PCT = 0.02
SECTOR_CAP_PCT = 0.25
MAX_MARGIN_PCT = 0.25
ATR_MULT       = 2.0
TIER1_R        = 1.5
TIER2_R        = 2.5
PENNY_MIN      = 5.0
MAX_POSITIONS  = 6
MIN_RR         = 1.7

app = Server("trade-analyzer")


async def fetch(client: httpx.AsyncClient, path: str, params: dict = {}) -> dict:
    p = dict(params)
    p["apiKey"] = POLYGON_KEY
    try:
        r = await client.get(f"{BASE}{path}", params=p, timeout=10)
        return r.json() if r.status_code == 200 else {}
    except Exception:
        return {}


def calc_limits(equity_value: float, stock_tier: int) -> dict:
    risk_cap   = round(equity_value * RISK_CAP_PCT, 2)
    pos_cap    = round(equity_value * TIER_CAPS.get(stock_tier, 0.10), 2)
    return {
        "risk_cap":    risk_cap,
        "daily_limit": round(risk_cap * 2, 2),
        "pos_cap":     pos_cap,
        "sector_cap":  round(equity_value * SECTOR_CAP_PCT, 2),
        "max_margin":  round(equity_value * MAX_MARGIN_PCT, 2),
    }


def auto_assign_tier(market_cap: float, beta: float) -> int:
    if market_cap == 0:
        return 3
    if market_cap > 200e9 and beta < 1.2:
        return 1
    if market_cap > 50e9:
        return 2
    if market_cap >= 2e9:
        return 3
    return 4


def score_rsi(v: float) -> str:
    if v >= 70:   return f"{v:.1f} — OVERBOUGHT ⚠"
    if v <= 30:   return f"{v:.1f} — OVERSOLD (potential bounce)"
    if v >= 60:   return f"{v:.1f} — elevated, watch for reversal"
    if v <= 40:   return f"{v:.1f} — low, building momentum"
    return        f"{v:.1f} — neutral"


def score_macd(macd: float, signal: float, hist: float) -> str:
    if macd > signal and hist > 0:
        return f"BULLISH — {macd:.2f} above signal {signal:.2f}"
    if macd < signal and hist < 0:
        return f"BEARISH — {macd:.2f} below signal {signal:.2f}"
    return f"NEUTRAL — converging (hist {hist:.2f})"


def score_news(articles: list, symbol: str) -> str:
    if not articles:
        return "No news in last 48h"
    relevant = []
    for a in articles[:5]:
        for ins in a.get("insights", []):
            if ins.get("ticker") == symbol:
                relevant.append(f"{ins.get('sentiment','neutral').upper()}: {a.get('title','')[:80]}")
    return " | ".join(relevant[:3]) if relevant else f"{len(articles)} articles, none {symbol}-specific"


def check_guardrails(sym, side, qty, price, equity_value, total_value,
                     positions_count, daily_pnl, avg_cost, cash,
                     hour_ct, is_weekday, is_leveraged_etf,
                     stock_tier, sector, sector_exposure, limits) -> list[str]:
    blocks      = []
    trade_value = qty * price
    margin_used = max(0, total_value - equity_value - max(0, cash))

    if side == "buy":
        if is_weekday and 7 <= hour_ct <= 18:
            blocks.append("H1: Possible driving hours — confirm at computer")
        hour_utc = (hour_ct + 5) % 24
        if hour_utc >= 21 or hour_utc < 6:
            blocks.append("H2: After 9pm CT — new positions blocked")
        if daily_pnl <= -limits["daily_limit"]:
            blocks.append(f"H3: Daily loss limit hit (${daily_pnl:,.0f} vs ${limits['daily_limit']:,.0f})")
        if positions_count >= MAX_POSITIONS:
            blocks.append(f"H4: {positions_count}/6 positions open")
        if is_leveraged_etf:
            blocks.append("H5: Leveraged/inverse ETF — daily decay risk")
        if price < PENNY_MIN:
            blocks.append(f"H8: ${price:.2f} below ${PENNY_MIN:.0f} penny threshold")
        if margin_used > limits["max_margin"]:
            blocks.append(f"H10: Margin ~${margin_used:,.0f} exceeds 25% cap ${limits['max_margin']:,.0f}")
        if trade_value > limits["pos_cap"]:
            pct = trade_value / equity_value * 100
            blocks.append(f"W1: ${trade_value:,.0f} ({pct:.1f}%) exceeds {TIER_LABELS.get(stock_tier)} cap ${limits['pos_cap']:,.0f}")
        if cash < 0:
            blocks.append(f"W3: Using ${abs(cash):,.0f} margin")
        if sector:
            new_total = sector_exposure + trade_value
            if new_total > limits["sector_cap"]:
                pct = new_total / equity_value * 100
                blocks.append(f"W7: {sector.title()} sector → ${new_total:,.0f} ({pct:.1f}%) exceeds 25% cap")
    return blocks


@app.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="analyze_trade",
            description=(
                "Run complete pre-trade research + guardrail check. "
                "Fetches ATR14, RSI, MACD, news, market cap, beta. "
                "Auto-assigns stock tier. Calculates tier-based position size, "
                "ATR stop, and 3-tier profit targets. Returns ~200 token brief."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "symbol":                  {"type": "string"},
                    "side":                    {"type": "string", "enum": ["buy", "sell"]},
                    "quantity":                {"type": "integer"},
                    "price":                   {"type": "number"},
                    "equity_value":            {"type": "number", "description": "equity_value from get_portfolio (NOT total_value)"},
                    "total_value":             {"type": "number", "default": 0, "description": "total_value from get_portfolio — for margin check"},
                    "positions_count":         {"type": "integer"},
                    "daily_pnl":               {"type": "number"},
                    "account_cash":            {"type": "number"},
                    "avg_cost":                {"type": "number", "default": 0},
                    "is_leveraged_etf":        {"type": "boolean", "default": False},
                    "sector":                  {"type": "string", "default": "", "description": "e.g. tech, consumer, energy"},
                    "sector_current_exposure": {"type": "number", "default": 0, "description": "Current $ in this sector"},
                    "stock_tier_override":     {"type": "integer", "default": 0, "description": "Override auto-assigned tier (1/2/3/4). 0 = auto."},
                },
                "required": ["symbol", "side", "quantity", "price", "equity_value",
                             "positions_count", "daily_pnl", "account_cash"],
            },
        )
    ]


@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    if name != "analyze_trade":
        return [TextContent(type="text", text="Unknown tool")]

    sym              = arguments["symbol"].upper()
    side             = arguments["side"]
    qty              = arguments["quantity"]
    price            = arguments["price"]
    equity_value     = arguments["equity_value"]
    total_value      = arguments.get("total_value", equity_value)
    positions_count  = arguments.get("positions_count", 0)
    daily_pnl        = arguments.get("daily_pnl", 0)
    cash             = arguments.get("account_cash", 0)
    avg_cost         = arguments.get("avg_cost", 0) or 0
    is_leveraged     = arguments.get("is_leveraged_etf", False)
    sector           = arguments.get("sector", "")
    sector_exposure  = arguments.get("sector_current_exposure", 0)
    tier_override    = arguments.get("stock_tier_override", 0)

    now_utc    = datetime.now(timezone.utc)
    is_weekday = now_utc.weekday() < 5
    hour_ct    = (now_utc.hour - 5) % 24
    today      = now_utc.strftime("%Y-%m-%d")
    month_ago  = (now_utc - timedelta(days=30)).strftime("%Y-%m-%d")
    since_48h  = (now_utc - timedelta(hours=48)).strftime("%Y-%m-%dT%H:%M:%SZ")

    async with httpx.AsyncClient() as client:
        rsi_d, macd_d, atr_d, news_d, agg_d, ref_d, ratio_d = await asyncio.gather(
            fetch(client, f"/v1/indicators/rsi/{sym}",
                  {"timespan": "day", "window": 14, "limit": 1, "series_type": "close"}),
            fetch(client, f"/v1/indicators/macd/{sym}",
                  {"timespan": "day", "short_window": 12, "long_window": 26,
                   "signal_window": 9, "limit": 1, "series_type": "close"}),
            fetch(client, f"/v1/indicators/atr/{sym}",
                  {"timespan": "day", "window": 14, "limit": 1}),
            fetch(client, "/v2/reference/news",
                  {"ticker": sym, "published_utc.gte": since_48h, "limit": 5, "order": "desc"}),
            fetch(client, f"/v2/aggs/ticker/{sym}/range/1/day/{month_ago}/{today}",
                  {"adjusted": "true", "sort": "desc", "limit": 5}),
            fetch(client, f"/vX/reference/tickers/{sym}"),
            fetch(client, f"/stocks/financials/v1/ratios",
                  {"ticker": sym, "limit": 1}),
        )

    # Parse indicators
    rsi_vals  = rsi_d.get("results", {}).get("values", [])
    rsi_str   = score_rsi(rsi_vals[0]["value"]) if rsi_vals else "unavailable"

    macd_vals = macd_d.get("results", {}).get("values", [])
    macd_str  = score_macd(macd_vals[0].get("value", 0),
                           macd_vals[0].get("signal", 0),
                           macd_vals[0].get("histogram", 0)) if macd_vals else "unavailable"

    atr_vals  = atr_d.get("results", {}).get("values", [])
    atr14     = atr_vals[0]["value"] if atr_vals else 0

    # Parse market cap + beta for tier assignment
    ticker_info = ref_d.get("results", {})
    market_cap  = ticker_info.get("market_cap", 0) or 0

    ratio_results = ratio_d.get("results", [])
    beta = 0
    if ratio_results:
        beta = ratio_results[0].get("beta", 0) or 0

    # Assign tier
    auto_tier   = auto_assign_tier(market_cap, beta)
    stock_tier  = tier_override if tier_override in (1, 2, 3, 4) else auto_tier
    tier_source = "override" if tier_override in (1, 2, 3, 4) else "auto-assigned"

    limits = calc_limits(equity_value, stock_tier)

    # ATR-based sizing
    if atr14 > 0:
        stop_dist    = ATR_MULT * atr14
        stop_price   = round(price - stop_dist, 2)
        risk_shares  = int(limits["risk_cap"] / stop_dist)
        size_shares  = int(limits["pos_cap"] / price)
        shares       = min(risk_shares, size_shares)
        pos_value    = round(shares * price, 2)
        actual_risk  = round(shares * stop_dist, 2)
        t1_price     = round(price + TIER1_R * stop_dist, 2)
        t2_price     = round(price + TIER2_R * stop_dist, 2)
        rr           = (t1_price - price) / (price - stop_price) if stop_price < price else 0

        sizing_str = (
            f"${atr14:.2f} ATR14 | Stop: ${stop_price:.2f} (−${stop_dist:.2f})\n"
            f"  Shares: {shares} | Position: ${pos_value:,.0f} | Risk: ${actual_risk:.0f}"
        )
        tier_str = (
            f"T1 (+{TIER1_R}R): ${t1_price:.2f} → sell 40%, stop→breakeven\n"
            f"  T2 (+{TIER2_R}R): ${t2_price:.2f} → sell 30%, trail 1×ATR\n"
            f"  T3: trail 30% at 2×ATR14 | Time stop: day 7 if T1 not hit"
        )
        rr_str = f"{rr:.1f}:1 to T1 (min {MIN_RR}:1)"
    else:
        sizing_str = "ATR14 unavailable — pull manually"
        tier_str   = "Cannot calculate — ATR14 required"
        rr_str     = "Cannot calculate"

    # Market cap display
    if market_cap >= 1e12:
        mcap_str = f"${market_cap/1e12:.1f}T"
    elif market_cap >= 1e9:
        mcap_str = f"${market_cap/1e9:.1f}B"
    elif market_cap > 0:
        mcap_str = f"${market_cap/1e6:.0f}M"
    else:
        mcap_str = "unavailable"

    # News
    news_str = score_news(news_d.get("results", []), sym)

    # Price trend
    bars = agg_d.get("results", [])
    if len(bars) >= 2:
        chg      = (bars[0].get("c", price) - bars[1].get("c", price)) / bars[1].get("c", price) * 100
        trend_str = f"Last close ${bars[0].get('c', price):.2f} ({chg:+.1f}% vs prev)"
    else:
        trend_str = f"~${price:.2f}"

    # Guardrails
    blocks    = check_guardrails(sym, side, qty, price, equity_value, total_value,
                                  positions_count, daily_pnl, avg_cost, cash,
                                  hour_ct, is_weekday, is_leveraged,
                                  stock_tier, sector, sector_exposure, limits)
    guard_str = "ALL PASS ✓" if not blocks else "\n  ⚠ " + "\n  ⚠ ".join(blocks)
    verdict   = "CLEAR" if not blocks else "BLOCKED — resolve issues above"

    brief = f"""📊 TRADE BRIEF: {side.upper()} {sym} @ ${price:.2f}
Equity: ${equity_value:,.0f} | Tier: {TIER_LABELS.get(stock_tier)} ({tier_source}) | Cap: ${limits['pos_cap']:,.0f}
Market cap: {mcap_str} | Beta: {beta:.2f}

POSITION SIZING
  {sizing_str}
  R/R: {rr_str}

TIER EXIT TARGETS
  {tier_str}

TECHNICALS
  RSI(14): {rsi_str}
  MACD:    {macd_str}
  Price:   {trend_str}

NEWS (48h)
  {news_str}

ACCOUNT STATE
  Positions: {positions_count}/6 | P&L today: ${daily_pnl:+,.0f}
  Cash: ${cash:+,.0f} | Daily limit: ${limits['daily_limit']:,.0f}
  {f'Sector ({sector}): ${sector_exposure:,.0f} current / ${limits["sector_cap"]:,.0f} cap' if sector else ''}

GUARDRAILS
  {guard_str}

VERDICT: {verdict}"""

    return [TextContent(type="text", text=brief)]


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, app.create_initialization_options())

if __name__ == "__main__":
    asyncio.run(main())

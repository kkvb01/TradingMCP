"""
Custom MCP 2: guardrail_engine
==============================
Hard-coded trading rules in Python.

Version: 4.0
Updated: 2026-06-07
Changes:
  - All limits now based on equity_value (not total_value) — margin excluded
  - Flat 15% position cap replaced with 4-tier system (T1=20, T2=15, T3=10, T4=5%)
  - Dollar risk cap simplified to 1% of equity_value
  - Added H10: margin usage cap (> 25% of equity = hard block)
  - Added W7: sector concentration cap (> 25% of equity per sector)
  - check_guardrails accepts stock_tier, sector, sector_current_exposure params
  - W4 stop suggestion is ATR-based (2× ATR14), not fixed %
  - H8: penny stock hard block, H9: OTC hard block retained
"""

import asyncio
import os
from datetime import datetime, timezone
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

app = Server("guardrail-engine")

LEVERAGED_ETF_KEYWORDS = ["2x", "3x", "ultra", "daily", "leveraged", "inverse", "bear", "bull", "-2", "-3"]
OTC_SUFFIXES           = [".OTC", ".PK", ".PINK"]

# Percentage constants — applied to equity_value only
TIER_CAPS = {1: 0.20, 2: 0.15, 3: 0.10, 4: 0.05}
RISK_CAP_PCT          = 0.01    # 1% of equity per trade
DAILY_LOSS_MULT       = 2.0
CASH_RESERVE_PCT      = 0.10
MAX_MARGIN_PCT        = 0.25    # H10: hard block if margin > 25% of equity
SECTOR_CAP_PCT        = 0.25    # W7: warn if sector > 25% of equity
ATR_MULTIPLIER        = 2.0
MIN_ATR_MULT          = 1.0
MAX_ATR_MULT          = 3.0
PENNY_MIN             = 5.0
MAX_POSITIONS         = 6
MIN_RR                = 1.7
TIER1_R               = 1.5
TIER2_R               = 2.5

TIER_LABELS = {
    1: "T1 large cap stable (20%)",
    2: "T2 large cap growth (15%)",
    3: "T3 mid cap / thematic (10%)",
    4: "T4 small cap / ADR (5%)",
}


def calc_limits(equity_value: float) -> dict:
    return {
        "risk_cap":     round(equity_value * RISK_CAP_PCT, 2),
        "daily_limit":  round(equity_value * RISK_CAP_PCT * DAILY_LOSS_MULT, 2),
        "cash_reserve": round(equity_value * CASH_RESERVE_PCT, 2),
        "max_margin":   round(equity_value * MAX_MARGIN_PCT, 2),
        "sector_cap":   round(equity_value * SECTOR_CAP_PCT, 2),
        "t1_cap":       round(equity_value * TIER_CAPS[1], 2),
        "t2_cap":       round(equity_value * TIER_CAPS[2], 2),
        "t3_cap":       round(equity_value * TIER_CAPS[3], 2),
        "t4_cap":       round(equity_value * TIER_CAPS[4], 2),
    }


def tier_cap(equity_value: float, tier: int) -> float:
    return round(equity_value * TIER_CAPS.get(tier, TIER_CAPS[3]), 2)


def calc_atr_stop(price: float, atr14: float) -> dict:
    dist = round(ATR_MULTIPLIER * atr14, 2)
    return {
        "stop_price":    round(price - dist, 2),
        "stop_distance": dist,
        "min_stop":      round(price - MIN_ATR_MULT * atr14, 2),
        "max_stop":      round(price - MAX_ATR_MULT * atr14, 2),
    }


def calc_shares(price: float, atr14: float, risk_cap: float, pos_cap: float) -> dict:
    dist          = ATR_MULTIPLIER * atr14
    risk_shares   = int(risk_cap / dist) if dist > 0 else 0
    size_shares   = int(pos_cap / price) if price > 0 else 0
    shares        = min(risk_shares, size_shares)
    return {
        "shares":        shares,
        "position_value":round(shares * price, 2),
        "actual_risk":   round(shares * dist, 2),
        "stop_distance": round(dist, 2),
        "tier1_price":   round(price + TIER1_R * dist, 2),
        "tier2_price":   round(price + TIER2_R * dist, 2),
    }


def is_leveraged(name: str, ticker: str) -> bool:
    return any(kw in (name + " " + ticker).lower() for kw in LEVERAGED_ETF_KEYWORDS)


def is_otc(ticker: str) -> bool:
    return any(ticker.upper().endswith(s) for s in OTC_SUFFIXES)


@app.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="check_guardrails",
            description=(
                "Run the hard-coded guardrail rule engine before any trade. "
                "All limits calculated from equity_value (margin excluded). "
                "Position caps are tier-based: T1=20%, T2=15%, T3=10%, T4=5%. "
                "Returns PASS or BLOCK. BLOCK verdicts cannot be overridden."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "symbol":                  {"type": "string"},
                    "symbol_name":             {"type": "string", "default": ""},
                    "side":                    {"type": "string", "enum": ["buy", "sell"]},
                    "quantity":                {"type": "integer"},
                    "price":                   {"type": "number"},
                    "equity_value":            {"type": "number", "description": "equity_value from get_portfolio — NOT total_value"},
                    "total_value":             {"type": "number", "default": 0, "description": "total_value from get_portfolio — used to calculate margin in use"},
                    "stop_loss_price":         {"type": "number", "default": 0},
                    "atr14":                   {"type": "number", "default": 0},
                    "stock_tier":              {"type": "integer", "default": 3, "description": "1=large stable, 2=large growth, 3=mid/thematic, 4=small/ADR"},
                    "sector":                  {"type": "string", "default": "", "description": "e.g. tech, consumer, energy, healthcare"},
                    "sector_current_exposure": {"type": "number", "default": 0, "description": "Current $ already in this sector"},
                    "positions_count":         {"type": "integer"},
                    "daily_pnl":               {"type": "number"},
                    "account_cash":            {"type": "number"},
                    "avg_cost_in_symbol":      {"type": "number", "default": 0},
                    "times_averaged_down":     {"type": "integer", "default": 0},
                    "stop_fired_within_48h":   {"type": "boolean", "default": False},
                    "exited_today":            {"type": "boolean", "default": False},
                    "is_extended_hours":       {"type": "boolean", "default": False},
                },
                "required": ["symbol", "side", "quantity", "price", "equity_value",
                             "positions_count", "daily_pnl", "account_cash"],
            },
        ),
        Tool(
            name="get_rules",
            description="List all active guardrail rules with thresholds calculated from equity_value.",
            inputSchema={
                "type": "object",
                "properties": {
                    "equity_value": {"type": "number", "default": 37000,
                                    "description": "equity_value from get_portfolio"}
                },
            },
        ),
    ]


@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:

    # ── GET RULES ──────────────────────────────────────────────────────────
    if name == "get_rules":
        ev     = arguments.get("equity_value", 37000)
        limits = calc_limits(ev)
        lines  = [
            f"ACTIVE GUARDRAIL RULES  (equity: ${ev:,.0f})",
            f"Risk cap (1%):      ${limits['risk_cap']:,.0f} per trade",
            f"Daily loss limit:   ${limits['daily_limit']:,.0f} (2× risk cap)",
            f"Cash reserve (10%): ${limits['cash_reserve']:,.0f}",
            f"Max margin (25%):   ${limits['max_margin']:,.0f}",
            f"Sector cap (25%):   ${limits['sector_cap']:,.0f} per sector",
            f"Min R/R:            {MIN_RR}:1",
            "",
            "POSITION TIER CAPS",
            f"  T1 large cap stable:  ${limits['t1_cap']:,.0f} (20%)",
            f"  T2 large cap growth:  ${limits['t2_cap']:,.0f} (15%)",
            f"  T3 mid/thematic:      ${limits['t3_cap']:,.0f} (10%)",
            f"  T4 small/ADR/spec:    ${limits['t4_cap']:,.0f}  (5%)",
            "",
            "HARD BLOCKS",
            "  [H1]  No trading while driving (weekday 7am–6pm CT)",
            "  [H2]  No new positions after 9pm CT",
            f" [H3]  Daily loss limit ${limits['daily_limit']:,.0f}",
            f" [H4]  Max {MAX_POSITIONS} open positions",
            "  [H5]  Leveraged/inverse ETF — decay risk",
            "  [H6]  48h stop-loss cooldown",
            "  [H7]  Max 2 average-downs on losing position",
            "  [H8]  Penny stock price < $5",
            "  [H9]  OTC/pink sheet",
            f" [H10] Margin usage > ${limits['max_margin']:,.0f} (25% of equity)",
            "",
            "WARNINGS",
            "  [W1]  Position exceeds tier cap",
            "  [W2]  Averaging down on underwater position",
            "  [W3]  Any margin in use",
            "  [W4]  No stop-loss set — use 2× ATR14",
            "  [W5]  Same-day re-entry",
            "  [W6]  Extended hours entry",
            f" [W7]  Sector exposure > ${limits['sector_cap']:,.0f} (25% of equity)",
        ]
        return [TextContent(type="text", text="\n".join(lines))]

    # ── CHECK GUARDRAILS ───────────────────────────────────────────────────
    if name == "check_guardrails":
        sym               = arguments["symbol"].upper()
        sym_name          = arguments.get("symbol_name", "")
        side              = arguments["side"]
        qty               = arguments["quantity"]
        price             = arguments["price"]
        equity_value      = arguments["equity_value"]
        total_value       = arguments.get("total_value", equity_value)
        stop_loss         = arguments.get("stop_loss_price", 0)
        atr14             = arguments.get("atr14", 0)
        stock_tier        = arguments.get("stock_tier", 3)
        sector            = arguments.get("sector", "")
        sector_exposure   = arguments.get("sector_current_exposure", 0)
        positions_count   = arguments.get("positions_count", 0)
        daily_pnl         = arguments.get("daily_pnl", 0)
        cash              = arguments.get("account_cash", 0)
        avg_cost          = arguments.get("avg_cost_in_symbol", 0)
        times_avg_down    = arguments.get("times_averaged_down", 0)
        stop_fired        = arguments.get("stop_fired_within_48h", False)
        exited_today      = arguments.get("exited_today", False)
        is_ext            = arguments.get("is_extended_hours", False)

        limits      = calc_limits(equity_value)
        pos_cap     = tier_cap(equity_value, stock_tier)
        margin_used = max(0, total_value - equity_value - max(0, cash))
        trade_value = qty * price

        now_utc    = datetime.now(timezone.utc)
        is_weekday = now_utc.weekday() < 5
        hour_ct    = (now_utc.hour - 5) % 24

        blocks   = []
        warnings = []

        if side == "buy":
            # H1
            if is_weekday and 7 <= hour_ct <= 18:
                blocks.append(("H1", f"Weekday {hour_ct}:00 CT — confirm you're not driving"))
            # H2
            if hour_ct >= 21 or hour_ct < 6:
                blocks.append(("H2", f"{hour_ct}:00 CT — new positions blocked after 9pm"))
            # H3
            if daily_pnl <= -limits["daily_limit"]:
                blocks.append(("H3", f"Daily P&L ${daily_pnl:,.0f} hit limit ${limits['daily_limit']:,.0f}"))
            # H4
            if positions_count >= MAX_POSITIONS:
                blocks.append(("H4", f"{positions_count} positions open — max is {MAX_POSITIONS}"))
            # H5
            if is_leveraged(sym_name, sym):
                blocks.append(("H5", f"{sym} is leveraged/daily ETF — decay risk confirmed"))
            # H6
            if stop_fired:
                blocks.append(("H6", f"Stop fired on {sym} within 48h — re-entry locked"))
            # H7
            if times_avg_down >= 2 and avg_cost > 0 and price < avg_cost:
                blocks.append(("H7", f"Averaged down {times_avg_down}× already — hard limit is 2"))
            # H8
            if price < PENNY_MIN:
                blocks.append(("H8", f"${price:.2f} is below ${PENNY_MIN:.0f} penny stock threshold"))
            # H9
            if is_otc(sym):
                blocks.append(("H9", f"{sym} appears to be OTC/pink sheet"))
            # H10
            if margin_used > limits["max_margin"]:
                blocks.append(("H10",
                    f"Margin in use ~${margin_used:,.0f} exceeds "
                    f"25% cap ${limits['max_margin']:,.0f} — reduce margin before buying"))

            # W1 — tier-based position size
            if trade_value > pos_cap:
                pct = trade_value / equity_value * 100
                warnings.append(("W1",
                    f"${trade_value:,.0f} ({pct:.1f}% of equity) exceeds "
                    f"{TIER_LABELS.get(stock_tier)} cap ${pos_cap:,.0f}"))
            # W2
            if avg_cost > 0 and price < avg_cost and times_avg_down < 2:
                pct = (price - avg_cost) / avg_cost * 100
                warnings.append(("W2", f"Position already down {pct:.1f}% (avg ${avg_cost:.2f})"))
            # W3
            if cash < 0:
                warnings.append(("W3", f"Account using ${abs(cash):,.0f} in margin"))
            # W4
            if not stop_loss:
                if atr14 > 0:
                    s = calc_atr_stop(price, atr14)
                    warnings.append(("W4",
                        f"No stop set — suggested ${s['stop_price']:.2f} "
                        f"(2× ATR14 ${atr14:.2f} = ${s['stop_distance']:.2f} below). "
                        f"Range: ${s['min_stop']:.2f}–${s['max_stop']:.2f}"))
                else:
                    warnings.append(("W4", "No stop set — pull ATR14 and set at 2× ATR14 below entry"))
            # W5
            if exited_today:
                warnings.append(("W5", f"Already exited {sym} today — what changed?"))
            # W6
            if is_ext:
                warnings.append(("W6", "Extended hours — wider spreads, thinner liquidity"))
            # W7
            if sector:
                new_sector_total = sector_exposure + trade_value
                if new_sector_total > limits["sector_cap"]:
                    pct = new_sector_total / equity_value * 100
                    warnings.append(("W7",
                        f"{sector.title()} sector would be ${new_sector_total:,.0f} "
                        f"({pct:.1f}% of equity) — cap is 25% (${limits['sector_cap']:,.0f})"))

        # R/R + tier targets
        rr_note   = ""
        tier_note = ""
        eff_stop  = stop_loss or (calc_atr_stop(price, atr14)["stop_price"] if atr14 > 0 else 0)
        if eff_stop and eff_stop < price:
            risk      = price - eff_stop
            rr_target = price + risk * MIN_RR
            rr_pct    = risk / price * 100
            rr_note   = f"\nR/R: risk ${risk:.2f} ({rr_pct:.1f}%), need ≥ ${rr_target:.2f} for {MIN_RR}:1"
            t1 = round(price + TIER1_R * risk, 2)
            t2 = round(price + TIER2_R * risk, 2)
            tier_note = (
                f"\nTier exits:"
                f"\n  T1 (+{TIER1_R}R): ${t1:.2f} → sell 40%, stop to breakeven"
                f"\n  T2 (+{TIER2_R}R): ${t2:.2f} → sell 30%, trail 1× ATR14"
                f"\n  T3: trail 30% at 2× ATR14 | Time stop: day 7 if T1 not hit"
            )

        # Sizing summary if ATR available
        sizing_note = ""
        if atr14 > 0:
            s = calc_shares(price, atr14, limits["risk_cap"], pos_cap)
            sizing_note = (
                f"\nSizing: {s['shares']} shares | "
                f"Position ${s['position_value']:,.0f} | "
                f"Risk ${s['actual_risk']:.0f} | "
                f"Stop ${round(price - s['stop_distance'], 2):.2f}"
            )

        verdict = "BLOCK" if blocks else ("PASS with warnings" if warnings else "PASS")

        lines = [
            f"GUARDRAIL CHECK: {side.upper()} {qty} {sym} @ ${price:.2f}",
            f"Equity: ${equity_value:,.0f} | "
            f"Tier: {TIER_LABELS.get(stock_tier, 'T3')} cap ${pos_cap:,.0f} | "
            f"Risk cap: ${limits['risk_cap']:,.0f}",
            f"VERDICT: {verdict}{rr_note}{tier_note}{sizing_note}",
            "",
        ]
        if blocks:
            lines.append("BLOCKS:")
            for rid, msg in blocks:
                lines.append(f"  ✗ {rid}: {msg}")
        if warnings:
            lines.append("\nWARNINGS:")
            for rid, msg in warnings:
                lines.append(f"  ⚠ {rid}: {msg}")
        if not blocks and not warnings:
            lines.append("✓ All rules passed.")

        lines.append(f"\nChecked {now_utc.strftime('%H:%M UTC')} | v4.0")
        return [TextContent(type="text", text="\n".join(lines))]

    return [TextContent(type="text", text="Unknown tool")]


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, app.create_initialization_options())

if __name__ == "__main__":
    asyncio.run(main())

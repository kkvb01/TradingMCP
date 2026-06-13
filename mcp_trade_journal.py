"""
Custom MCP 3: trade_journal
===========================
Persistent SQLite database across Claude sessions.

Version: 4.0
Updated: 2026-06-07
Changes:
  - Added stock_tier and sector columns to trades table
  - log_trade accepts stock_tier, sector params
  - get_open_trades shows tier, sector, days held, time stop, tier targets
  - get_stats shows win rate / P&L broken down by tier and sector
  - Schema auto-migrates existing DB without data loss
"""

import asyncio
import os
import sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path
from collections import defaultdict
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

DB_PATH        = os.environ.get("JOURNAL_DB_PATH", str(Path.home() / ".trading_journal.db"))
ATR_MULTIPLIER = 2.0
TIER1_R        = 1.5
TIER2_R        = 2.5
TIME_STOP_DAYS = 7

TIER_LABELS = {
    1: "T1 large cap stable",
    2: "T2 large cap growth",
    3: "T3 mid cap / thematic",
    4: "T4 small cap / ADR",
}

app = Server("trade-journal")


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    conn.execute("""
        CREATE TABLE IF NOT EXISTS trades (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp          TEXT NOT NULL,
            symbol             TEXT NOT NULL,
            side               TEXT NOT NULL,
            quantity           INTEGER NOT NULL,
            price              REAL NOT NULL,
            stop_loss          REAL,
            target_price       REAL,
            atr14              REAL,
            stop_distance      REAL,
            tier1_price        REAL,
            tier2_price        REAL,
            tier3_stop         REAL,
            time_stop_date     TEXT,
            stock_tier         INTEGER DEFAULT 3,
            sector             TEXT DEFAULT '',
            rsi_at_entry       REAL,
            news_sentiment     TEXT,
            guardrail_warnings TEXT,
            notes              TEXT,
            status             TEXT DEFAULT 'open',
            exit_price         REAL,
            exit_timestamp     TEXT,
            pnl                REAL,
            hold_days          REAL,
            day_of_week        TEXT,
            tier_reached       INTEGER
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS rule_overrides (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            rule_id   TEXT NOT NULL,
            symbol    TEXT,
            reason    TEXT,
            outcome   TEXT
        )
    """)

    # Safe migration — add columns if upgrading from older version
    existing = {row[1] for row in conn.execute("PRAGMA table_info(trades)")}
    new_cols = [
        ("atr14",          "REAL"),
        ("stop_distance",  "REAL"),
        ("tier1_price",    "REAL"),
        ("tier2_price",    "REAL"),
        ("tier3_stop",     "REAL"),
        ("time_stop_date", "TEXT"),
        ("tier_reached",   "INTEGER"),
        ("stock_tier",     "INTEGER DEFAULT 3"),
        ("sector",         "TEXT DEFAULT ''"),
    ]
    for col, typ in new_cols:
        if col not in existing:
            conn.execute(f"ALTER TABLE trades ADD COLUMN {col} {typ}")

    conn.commit()
    return conn


def add_trading_days(start: datetime, days: int) -> str:
    dt, added = start, 0
    while added < days:
        dt += timedelta(days=1)
        if dt.weekday() < 5:
            added += 1
    return dt.strftime("%Y-%m-%d")


@app.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="log_trade",
            description="Log a new trade entry to the persistent journal.",
            inputSchema={
                "type": "object",
                "properties": {
                    "symbol":             {"type": "string"},
                    "side":               {"type": "string", "enum": ["buy", "sell"]},
                    "quantity":           {"type": "integer"},
                    "price":              {"type": "number"},
                    "stop_loss":          {"type": "number",  "default": 0},
                    "target_price":       {"type": "number",  "default": 0},
                    "atr14":              {"type": "number",  "default": 0},
                    "tier1_price":        {"type": "number",  "default": 0},
                    "tier2_price":        {"type": "number",  "default": 0},
                    "tier3_stop":         {"type": "number",  "default": 0},
                    "stock_tier":         {"type": "integer", "default": 3, "description": "1/2/3/4"},
                    "sector":             {"type": "string",  "default": ""},
                    "rsi_at_entry":       {"type": "number",  "default": 0},
                    "news_sentiment":     {"type": "string",  "default": ""},
                    "guardrail_warnings": {"type": "string",  "default": ""},
                    "notes":              {"type": "string",  "default": ""},
                },
                "required": ["symbol", "side", "quantity", "price"],
            },
        ),
        Tool(
            name="close_trade",
            description="Mark an open trade as closed. Calculates P&L automatically.",
            inputSchema={
                "type": "object",
                "properties": {
                    "symbol":       {"type": "string"},
                    "exit_price":   {"type": "number"},
                    "tier_reached": {"type": "integer", "default": 0,
                                    "description": "0=none/stopped, 1=T1, 2=T2, 3=T3"},
                    "notes":        {"type": "string", "default": ""},
                },
                "required": ["symbol", "exit_price"],
            },
        ),
        Tool(
            name="get_stats",
            description=(
                "Trading performance stats: win rate, P&L, tier hit rates, "
                "time stop frequency, breakdown by stock tier and sector. "
                "Use at session start."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "days": {"type": "integer", "default": 30},
                },
            },
        ),
        Tool(
            name="get_open_trades",
            description=(
                "List all open trades with days held, time stop date, "
                "tier targets, stock tier, and sector."
            ),
            inputSchema={"type": "object", "properties": {}},
        ),
        Tool(
            name="log_rule_override",
            description="Log a guardrail override and outcome.",
            inputSchema={
                "type": "object",
                "properties": {
                    "rule_id": {"type": "string"},
                    "symbol":  {"type": "string", "default": ""},
                    "reason":  {"type": "string"},
                    "outcome": {"type": "string", "default": "pending"},
                },
                "required": ["rule_id", "reason"],
            },
        ),
    ]


@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    conn = get_db()
    now  = datetime.now(timezone.utc)

    try:
        # ── LOG TRADE ──────────────────────────────────────────────────────
        if name == "log_trade":
            atr14         = arguments.get("atr14", 0) or 0
            stop_distance = round(ATR_MULTIPLIER * atr14, 2) if atr14 > 0 else 0
            time_stop     = add_trading_days(now, TIME_STOP_DAYS)
            stock_tier    = arguments.get("stock_tier", 3)

            conn.execute("""
                INSERT INTO trades (
                    timestamp, symbol, side, quantity, price,
                    stop_loss, target_price, atr14, stop_distance,
                    tier1_price, tier2_price, tier3_stop, time_stop_date,
                    stock_tier, sector,
                    rsi_at_entry, news_sentiment, guardrail_warnings, notes, day_of_week
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                now.isoformat(),
                arguments["symbol"].upper(),
                arguments["side"],
                arguments["quantity"],
                arguments["price"],
                arguments.get("stop_loss", 0),
                arguments.get("target_price", 0),
                atr14, stop_distance,
                arguments.get("tier1_price", 0),
                arguments.get("tier2_price", 0),
                arguments.get("tier3_stop", 0),
                time_stop,
                stock_tier,
                arguments.get("sector", ""),
                arguments.get("rsi_at_entry", 0),
                arguments.get("news_sentiment", ""),
                arguments.get("guardrail_warnings", ""),
                arguments.get("notes", ""),
                now.strftime("%A"),
            ))
            conn.commit()

            sym   = arguments["symbol"].upper()
            price = arguments["price"]
            t1    = arguments.get("tier1_price", 0)
            t2    = arguments.get("tier2_price", 0)
            tier_label = TIER_LABELS.get(stock_tier, "T3")
            lines = [
                f"✓ Logged: {arguments['side'].upper()} {arguments['quantity']} {sym} @ ${price:.2f}",
                f"  Tier: {tier_label} | Sector: {arguments.get('sector','—')}",
                f"  Time stop: {time_stop} (day {TIME_STOP_DAYS})",
            ]
            if t1: lines.append(f"  T1 target: ${t1:.2f} (+{TIER1_R}R) → sell 40%")
            if t2: lines.append(f"  T2 target: ${t2:.2f} (+{TIER2_R}R) → sell 30%")
            return [TextContent(type="text", text="\n".join(lines))]

        # ── CLOSE TRADE ────────────────────────────────────────────────────
        elif name == "close_trade":
            sym        = arguments["symbol"].upper()
            exit_price = arguments["exit_price"]
            tier_hit   = arguments.get("tier_reached", 0)

            row = conn.execute(
                "SELECT * FROM trades WHERE symbol=? AND status='open' ORDER BY timestamp DESC LIMIT 1",
                (sym,)
            ).fetchone()
            if not row:
                return [TextContent(type="text", text=f"No open trade for {sym}")]

            hold_days = (now - datetime.fromisoformat(row["timestamp"])).total_seconds() / 86400
            pnl = (exit_price - row["price"]) * row["quantity"] if row["side"] == "buy" \
                  else (row["price"] - exit_price) * row["quantity"]

            conn.execute("""
                UPDATE trades SET status='closed', exit_price=?,
                exit_timestamp=?, pnl=?, hold_days=?, tier_reached=?
                WHERE id=?
            """, (exit_price, now.isoformat(), round(pnl, 2), hold_days, tier_hit, row["id"]))
            conn.commit()

            result     = "WIN ✓" if pnl > 0 else "LOSS ✗"
            tier_label = f"Tier {tier_hit}" if tier_hit > 0 else "No tier (stopped/time)"
            return [TextContent(type="text", text=
                f"Closed {sym}: {result} ${pnl:+,.2f} | Held {hold_days:.1f}d | {tier_label}"
            )]

        # ── GET STATS ──────────────────────────────────────────────────────
        elif name == "get_stats":
            days  = arguments.get("days", 30)
            since = (now - timedelta(days=days)).isoformat()
            closed = conn.execute(
                "SELECT * FROM trades WHERE status='closed' AND exit_timestamp >= ?", (since,)
            ).fetchall()

            if not closed:
                return [TextContent(type="text", text=f"No closed trades in last {days} days.")]

            wins   = [t for t in closed if t["pnl"] > 0]
            losses = [t for t in closed if t["pnl"] <= 0]
            total  = len(closed)
            wr     = len(wins) / total * 100
            total_pnl = sum(t["pnl"] for t in closed)
            avg_win   = sum(t["pnl"] for t in wins)   / len(wins)   if wins   else 0
            avg_loss  = sum(t["pnl"] for t in losses) / len(losses) if losses else 0
            avg_hold  = sum(t["hold_days"] for t in closed) / total
            rr        = abs(avg_win / avg_loss) if avg_loss else 0

            # Tier hit rates
            tc = defaultdict(int)
            for t in closed:
                tc[t["tier_reached"] or 0] += 1
            t1_reached = tc[1] + tc[2] + tc[3]
            t2_reached = tc[2] + tc[3]
            t3_reached = tc[3]
            time_stops = tc[0]

            # By stock tier
            tier_pnl = defaultdict(float)
            tier_cnt = defaultdict(int)
            tier_wins= defaultdict(int)
            for t in closed:
                st = t["stock_tier"] or 3
                tier_pnl[st]  += t["pnl"]
                tier_cnt[st]  += 1
                if t["pnl"] > 0:
                    tier_wins[st] += 1

            tier_lines = []
            for st in sorted(tier_pnl.keys()):
                cnt  = tier_cnt[st]
                wr_t = tier_wins[st] / cnt * 100 if cnt else 0
                tier_lines.append(
                    f"  {TIER_LABELS.get(st,'T?')}: "
                    f"{cnt} trades | WR {wr_t:.0f}% | P&L ${tier_pnl[st]:+,.0f}"
                )

            # By sector
            sec_pnl  = defaultdict(float)
            sec_cnt  = defaultdict(int)
            for t in closed:
                s = t["sector"] or "unknown"
                sec_pnl[s] += t["pnl"]
                sec_cnt[s] += 1
            sec_lines = [
                f"  {s}: {sec_cnt[s]} trades | ${sec_pnl[s]:+,.0f}"
                for s in sorted(sec_pnl, key=lambda x: sec_pnl[x], reverse=True)
            ]

            # Best/worst symbols
            sym_pnl = defaultdict(float)
            for t in closed:
                sym_pnl[t["symbol"]] += t["pnl"]
            sorted_syms = sorted(sym_pnl.items(), key=lambda x: x[1], reverse=True)

            # Best day
            day_pnl = defaultdict(float)
            for t in closed:
                day_pnl[t["day_of_week"]] += t["pnl"]
            best_day = max(day_pnl.items(), key=lambda x: x[1]) if day_pnl else ("N/A", 0)

            open_count = conn.execute(
                "SELECT COUNT(*) as c FROM trades WHERE status='open'"
            ).fetchone()["c"]

            alerts = []
            if wr < 45:
                alerts.append("⚠ Win rate below 45% — review entry criteria")
            if rr < 1.5 and total > 5:
                alerts.append("⚠ R/R below 1.5:1 — winners not big enough vs losers")
            if total > 0 and time_stops / total > 0.4:
                alerts.append("⚠ >40% time stops — entries may be too early")
            if total > 0 and t1_reached / total < 0.5:
                alerts.append("⚠ T1 hit rate <50% — tighten entry criteria")
            if not alerts:
                alerts.append("✓ Stats look healthy")

            stats = f"""TRADING STATS — last {days} days
Trades: {total} ({len(wins)}W / {len(losses)}L) | Open: {open_count}
Win rate: {wr:.1f}% | Total P&L: ${total_pnl:+,.2f}
Avg winner: ${avg_win:+,.2f} | Avg loser: ${avg_loss:+,.2f}
R/R achieved: {rr:.1f}:1 | Avg hold: {avg_hold:.1f}d

TIER EXIT PERFORMANCE
  T1 reached (+1.5R): {t1_reached}/{total} ({t1_reached/total*100:.0f}%)
  T2 reached (+2.5R): {t2_reached}/{total} ({t2_reached/total*100:.0f}%)
  T3 reached (trail): {t3_reached}/{total} ({t3_reached/total*100:.0f}%)
  Time stop fired:    {time_stops}/{total} ({time_stops/total*100:.0f}%)

BY STOCK TIER
{chr(10).join(tier_lines) if tier_lines else '  No data'}

BY SECTOR
{chr(10).join(sec_lines) if sec_lines else '  No data'}

BEST/WORST SYMBOLS
  Best:  {sorted_syms[0][0] if sorted_syms else 'N/A'} (${sorted_syms[0][1]:+,.0f if sorted_syms else 0})
  Worst: {sorted_syms[-1][0] if sorted_syms else 'N/A'} (${sorted_syms[-1][1]:+,.0f if sorted_syms else 0})
  Best day: {best_day[0]} (${best_day[1]:+,.0f})

ALERTS
{chr(10).join(alerts)}"""

            return [TextContent(type="text", text=stats)]

        # ── GET OPEN TRADES ────────────────────────────────────────────────
        elif name == "get_open_trades":
            rows = conn.execute(
                "SELECT * FROM trades WHERE status='open' ORDER BY timestamp DESC"
            ).fetchall()
            if not rows:
                return [TextContent(type="text", text="No open trades in journal.")]

            lines = ["OPEN TRADES"]
            for r in rows:
                days_held  = (now - datetime.fromisoformat(r["timestamp"])).total_seconds() / 86400
                tier_label = TIER_LABELS.get(r["stock_tier"] or 3, "T3")
                line = (
                    f"  {r['symbol']} {r['side'].upper()} {r['quantity']}sh @ ${r['price']:.2f} | "
                    f"{tier_label} | {r['sector'] or '—'} | "
                    f"Held {days_held:.1f}d | Stop: {r['time_stop_date'] or '?'}"
                )
                if r["tier1_price"]:
                    line += f" | T1: ${r['tier1_price']:.2f}"
                if r["tier2_price"]:
                    line += f" | T2: ${r['tier2_price']:.2f}"
                if r["stop_loss"]:
                    line += f" | Stop: ${r['stop_loss']:.2f}"
                lines.append(line)
            return [TextContent(type="text", text="\n".join(lines))]

        # ── LOG RULE OVERRIDE ──────────────────────────────────────────────
        elif name == "log_rule_override":
            conn.execute("""
                INSERT INTO rule_overrides (timestamp, rule_id, symbol, reason, outcome)
                VALUES (?, ?, ?, ?, ?)
            """, (now.isoformat(), arguments["rule_id"],
                  arguments.get("symbol", ""), arguments["reason"],
                  arguments.get("outcome", "pending")))
            conn.commit()
            return [TextContent(type="text", text=
                f"Override logged: {arguments['rule_id']} — update outcome when known."
            )]

    finally:
        conn.close()

    return [TextContent(type="text", text="Unknown tool")]


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, app.create_initialization_options())

if __name__ == "__main__":
    asyncio.run(main())

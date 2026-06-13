# Custom MCP Setup Guide

## What you're building

Three Python MCP servers that sit between Claude and your data sources,
dramatically reducing token usage and adding capabilities Claude can't have on its own.

| MCP | File | Purpose |
|-----|------|---------|
| Trade Analyser | `mcp_trade_analyzer.py` | 8 API calls → 1 scored brief (15× fewer tokens) |
| Guardrail Engine | `mcp_guardrail_engine.py` | Hard-coded rules Claude cannot override |
| Trade Journal | `mcp_trade_journal.py` | Persistent memory across sessions |

---

## Prerequisites

```bash
pip install mcp httpx
```

---

## Setup (Claude Desktop)

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac)
or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "trade-analyzer": {
      "command": "python",
      "args": ["/full/path/to/mcp_trade_analyzer.py"],
      "env": {
        "POLYGON_API_KEY": "your_polygon_api_key_here"
      }
    },
    "guardrail-engine": {
      "command": "python",
      "args": ["/full/path/to/mcp_guardrail_engine.py"],
      "env": {
        "POLYGON_API_KEY": "your_polygon_api_key_here"
      }
    },
    "trade-journal": {
      "command": "python",
      "args": ["/full/path/to/mcp_trade_journal.py"],
      "env": {
        "JOURNAL_DB_PATH": "/full/path/to/trading_journal.db"
      }
    }
  }
}
```

Restart Claude Desktop after editing.

---

## How Claude uses these

### Start of every session
```
Claude reads GUARDRAILS.md and RULE_LOG.md
→ calls trade_journal.get_stats(days=30)  [get pattern context]
→ calls trade_journal.get_open_trades()   [know current state]
```

### When you say "analyse NVDA before I buy"
```
Claude calls trade_analyzer.analyze_trade(symbol="NVDA", side="buy", ...)
→ returns 200-token brief with RSI, news, guardrail verdict
→ Claude presents brief, asks for confirmation
```

### When you confirm "yes, buy NVDA"
```
Claude calls guardrail_engine.check_guardrails(...)  [final safety check]
→ if PASS: calls Robinhood to place/review order
→ calls trade_journal.log_trade(...)  [log entry]
```

### When you sell
```
Claude calls trade_journal.close_trade(symbol="NVDA", exit_price=220)
→ P&L calculated automatically, win/loss recorded
```

---

## Token comparison

| Approach | Calls | Tokens consumed |
|----------|-------|----------------|
| Claude calling raw Massive API directly | 8 calls | ~6,000 tokens |
| Claude calling trade_analyzer MCP | 1 call | ~200 tokens |
| Savings | 87% fewer | 30× reduction |

---

## Updating guardrail rules

When you want to change a rule in mcp_guardrail_engine.py:

1. Tell Claude in the Trading Project: "I want to add a new rule: no penny stocks under $5"
2. Claude runs the validation check against GUARDRAILS.md
3. You approve → Claude updates GUARDRAILS.md and RULE_LOG.md
4. You manually update the corresponding check in `mcp_guardrail_engine.py`
   (or Claude Code can do this for you)
5. Restart the MCP server

The two-file approach (GUARDRAILS.md for Claude's awareness,
Python code for hard enforcement) gives you both human-readable rules
and machine-enforced ones.

---

## Running without Claude Desktop (for testing)

```bash
# Test trade analyzer
echo '{"symbol":"NVDA","side":"buy","quantity":10,"price":205,"positions_count":3,"daily_pnl":-200,"account_cash":5000}' | python mcp_trade_analyzer.py

# Test journal
python -c "
import sqlite3
conn = sqlite3.connect('trading_journal.db')
print('Tables:', conn.execute(\"SELECT name FROM sqlite_master WHERE type='table'\").fetchall())
"
```

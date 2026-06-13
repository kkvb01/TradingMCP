# TradingMCP — Project Context

## What This Project Is
A personal trading assistant built on MCP (Model Context Protocol) that connects Claude to live brokerage and market data. Two parallel components:

1. **TradingView Scanner** — Node.js scanner that queries the TradingView screener API across 4 swing-trade setups, scores/deduplicates results, and generates an HTML report.
2. **MCP Tools** — Python MCP servers (trade analyzer, trade journal, guardrail engine) deployed to Cloudflare Workers that Claude uses via Claude Desktop.

## TradingView Scanner (`TradingView Scanner/`)
- `scanner.js` — Main scanner. Runs 4 scans in parallel, consolidates and scores results, writes `scanner-results.json`.
- `generate-report.js` — Reads `scanner-results.json`, generates self-contained `report.html`.
- `scanner-results.json` — Output of last scanner run (live data, gitignored implicitly).
- `report.html` — Generated HTML report (dark GitHub-style UI, Chart.js charts).

### 4 Scan Types
| ID | Name | Key Signal |
|----|------|-----------|
| `breakout` | Momentum Breakout | Perf.W > 2%, RSI 55-75, above SMA50, rel_vol > 1.5x |
| `pullback` | Pullback to Support | RSI 42-52, above SMA200, -8% to -1% week, Perf.1M > 3% |
| `oversold` | Oversold Bounce | RSI < 35, Perf.W < -4%, Perf.1M -45% to -10% |
| `early_trend` | Early Trend Forming | RSI 50-72, above SMA50, Perf.1M > 7%, rel_vol > 1.1x |

### Scoring (max 21 pts)
- Multi-scan hits: 2 pts (1 scan), 4 pts (2 scans), 5 pts (3+ scans)
- Analyst rating: StrongBuy=5, Buy=3, Hold=1, Sell=-2
- Relative volume: >2.0x=3, >1.5x=2, >1.0x=1
- Daily change: >5%=3, >2%=2, >0=1, <-3%=-1
- Market cap >$5B: +2

### Verdicts
- **TRADE** = score ≥ 12
- **WATCH** = score 8–11
- **SKIP** = score < 8

### Columns Returned by API (index map)
```
d[0]=ticker-view  d[1]=close        d[2]=type         d[3]=typespecs
d[4]=pricescale   d[5]=minmov       d[6]=fractional   d[7]=minmove2
d[8]=currency     d[9]=change       d[10]=volume      d[11]=rel_vol_10d
d[12]=market_cap  d[13]=fund_curr   d[14]=PE          d[15]=EPS
d[16]=EPS_growth  d[17]=div_yield   d[18]=sector.tr   d[19]=market
d[20]=sector      d[21]=AnalystRating d[22]=AnalystRating.tr
d[23]=RSI         d[24]=RSI[1W]     d[25]=SMA50       d[26]=SMA200
d[27]=EMA20       d[28]=ATR         d[29]=High.52W    d[30]=MACD.macd
d[31]=MACD.signal d[32]=Perf.W      d[33]=Perf.1M     d[34]=avg_vol_30d
```

## MCP Servers (`cloudflare/`)
Three Cloudflare Workers acting as MCP tools for Claude Desktop:
- `trade-analyzer` — Analyzes trade setups, risk/reward
- `trade-journal` — Reads/writes SQLite trade journal (`trading_journal.db`)
- `guardrail-engine` — Enforces position sizing and risk rules

Config: `cloudflare/claude_desktop_config_snippet.json` shows how to wire up MCP tools.

## Key Constraints
- Scanner uses unauthenticated TradingView screener API (public endpoint)
- All MACD status defaults to BEARISH when MACD columns are null (data quality issue to watch)
- `EXMT` and similar sub-penny stocks can slip through breakout scan; market_cap < $1M is noise
- Stop/target use percentage-based ATR proxy (breakout: 3%/7%, oversold: 2%/4%, default: 2.5%/5%)

## Run Commands
```bash
# Scanner (from TradingView Scanner/)
cd "TradingView Scanner"
npm start                # live API — loads .env automatically via --env-file
npm run mock             # mock data for testing (no .env needed)
npm run report           # regenerate HTML from last scanner-results.json

# .env file required for live upload (gitignored, never commit)
# SCANNER_WORKER_URL=https://scanner-mcp.tda-guardrails.workers.dev
# SCANNER_API_KEY=<your key>

# MCP servers (Cloudflare)
wrangler deploy          # from each cloudflare/* subdirectory
```

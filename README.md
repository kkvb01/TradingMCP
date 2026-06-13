# TradingView Scanner - 4 Swing Trade Setups

A Node.js screener that runs 4 parallel swing trade setups against TradingView's scanner API, consolidates results, deduplicates, scores by confluence signals, and outputs a ranked final list.

## Features

✅ **4 Parallel Scans** - Momentum Breakout, Pullback to Support, Oversold Bounce, Early Trend Forming
✅ **Smart Deduplication** - Tracks which screeners found each stock
✅ **Confluence Scoring** - Scores on 13 technical signals (21 points max)
✅ **Multi-scan Prioritization** - Stocks found in multiple scans listed first
✅ **Trade Metrics** - Calculates stop prices, T1 targets, and verdicts (TRADE/WATCH/SKIP)
✅ **Rich Output** - Formatted console display + JSON export
✅ **Mock Mode** - Test with synthetic data without API

## Quick Start

```bash
# Test with mock data (instant results)
node scanner.js --mock

# Run with live TradingView API (requires API access)
node scanner.js
```

## Output Example

```
=== TV SCANNER RESULTS — 2026-06-13 02:09:46 ===
Scans run: Momentum, Pullback, Oversold, Early

[AAPL] — TRADE (16/21) | Found in: breakout, pullback, oversold, early_trend
  Price: $169.96 | RSI: 64.7d / 55.3w | RelVol: 1.91x
  SMA50: $162.84 | SMA200: $160.75 | ATR: $1.72
  Perf: +1.2%W / +11.2%M | Cap: $2.51B | Sector: Healthcare
  Stop: $166.52 | T1: $175.12 | MACD: BULLISH
```

Results also saved as `scanner-results.json`.

## Confluence Scoring (21 pts max)

| Signal | Points |
|--------|--------|
| SMA50 > SMA200 | +2 |
| RSI[1W] > 50 | +2 |
| price > EMA20 | +1 |
| price within 10% of 52W high | +2 |
| relative volume > 1.5x | +2 |
| MACD above signal | +2 |
| RSI < 75 | +1 |
| RSI > 40 | +1 |
| Perf.1M > 5% | +2 |
| Perf.W > 0 | +2 |
| relative volume > 1.1x | +1 |
| market cap > 5B | +2 |
| market cap > 2B | +1 |

**Verdicts:**
- **TRADE**: Score ≥ 12
- **WATCH**: Score 8-11
- **SKIP**: Score < 8

## Scan Definitions

### 1. Momentum Breakout
Price above SMA50, weekly gain >2%, RSI 55-75, elevated volume

### 2. Pullback to Support  
Large cap (>$5B), price above SMA200, RSI 42-52, reduced volume, recent pullback

### 3. Oversold Bounce
Oversold RSI <35, recent sharp decline, monthly loss -10% to -45%

### 4. Early Trend Forming
Mid-cap (>$2B), price > SMA50, RSI 50-72, strong monthly gain >7%

## API Setup (For Live Mode)

The scanner uses TradingView's screener API:
```
POST https://scanner.tradingview.com/america/scan?label-product=popup-screener-stock
```

### Current Status
❌ **API returning "json parse error" on all requests**

### Troubleshooting

1. **Check if API requires authentication:**
   - Add Bearer token to HEADERS in scanner.js
   ```javascript
   'Authorization': 'Bearer YOUR_TOKEN_HERE'
   ```

2. **Verify endpoint is still active:**
   - Test in browser DevTools (Network tab) while using TradingView's screener

3. **Check TradingView's current API docs:**
   - Visit https://github.com/tvision-insights/tv-scanners (community docs)
   - Verify filter2 structure matches current API version

4. **Alternative: Use mock mode indefinitely**
   ```bash
   node scanner.js --mock
   ```

## Files

- `scanner.js` - Main screener script (Node 18+, no dependencies)
- `scanner-results.json` - Output JSON with all results and metrics
- `payload-debug.log` - Debug payloads sent to API (when running live mode)

## JSON Output Structure

```json
{
  "timestamp": "2026-06-13T02:09:46.000Z",
  "mode": "mock",
  "summary": {
    "total_candidates": 10,
    "multi_scan_hits": 10,
    "trade_candidates": 6,
    "watch_candidates": 4
  },
  "scans": [
    { "id": "breakout", "name": "Momentum Breakout" },
    ...
  ],
  "stocks": [
    {
      "ticker": "AAPL",
      "score": 16,
      "verdict": "TRADE",
      "found_in": ["breakout", "pullback", "oversold", "early_trend"],
      "price": 169.96,
      "rsi": 64.7,
      "sma50": 162.84,
      "sma200": 160.75,
      ...
      "stop_price": 166.52,
      "t1_target": 175.12,
      "macd_status": "BULLISH"
    }
  ]
}
```

## Filters

All scans filter to:
- Common stocks, preferred stocks, DRs, and non-ETF funds
- Exclude pre-IPO
- Minimum price: $10
- Minimum avg volume (varies by scan): $1-2M

## Trade Metrics

For each stock:
- **Stop Price** = Entry - (ATR × 2)
- **T1 Target** = Entry + (ATR × 3)
- **Risk/Reward** = (T1 - Entry) / (Entry - Stop)

## Requirements

- Node.js 18+
- No external dependencies (native fetch, JSON)

## Usage Patterns

```bash
# Test scoring logic with mock data
node scanner.js --mock

# Debug payload structure (check payload-debug.log)
node scanner.js

# Redirect to file for analysis
node scanner.js --mock > results.txt 2>&1
```

## Notes

- Parallel execution: All 4 scans run simultaneously
- Deduplication: Same ticker in multiple scans counts as "multi-scan hit"
- Scoring: Each signal is binary (met or not met)
- Sorting: Multi-scan hits first, then by score descending
- Market cap formatted in billions (B)
- Percentages displayed with +/- prefix

## Author Notes

- Created for swing trading setups with confluence scoring
- Focus on technical indicators + volume confirmation
- Suitable for swing trades (2-5 day holding periods)
- Adjust filters in SCANS object for custom thresholds

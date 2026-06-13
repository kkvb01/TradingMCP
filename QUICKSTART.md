# Quick Start Guide

## What You Have

A complete Node.js screener that:
- ✅ Runs 4 parallel swing trade scans
- ✅ Consolidates + deduplicates results
- ✅ Scores each stock by confluence (13 signals, 21 pts max)
- ✅ Calculates risk/reward metrics
- ✅ Formats beautiful console output + JSON export
- ✅ Works with mock data (for testing)
- ❌ **Currently unable to fetch live data** (API authentication issue)

## Usage

### Test with Mock Data (No API Needed)
```bash
cd c:\TradingMCP
node scanner.js --mock
```

**Output**: Console display + `scanner-results.json`

Example output:
```
📊 TradingView Scanner - 4 Swing Trade Setups
Mode: MOCK DATA (for testing)

Running scans...
✓ Momentum Breakout: 10 mock results
✓ Pullback to Support: 10 mock results
✓ Oversold Bounce: 10 mock results
✓ Early Trend Forming: 10 mock results

📈 Consolidating & scoring...

=== TV SCANNER RESULTS — 2026-06-13 02:09:46 ===
Scans run: Momentum, Pullback, Oversold, Early (MOCK DATA)
Total candidates: 10 | TRADE: 6 | WATCH: 4

MULTI-SCAN HITS (highest priority):
[AAPL] — TRADE (16/21) | Found in: breakout, pullback, oversold, early_trend
  Price: $169.96 | RSI: 64.7d / 55.3w | RelVol: 1.91x
  SMA50: $162.84 | SMA200: $160.75 | ATR: $1.72
  Perf: +1.2%W / +11.2%M | Cap: $2.51B | Sector: Healthcare
  Stop: $166.52 | T1: $175.12 | MACD: BULLISH
```

### Get Live Data (Requires API Fix)
```bash
# Try live API (currently returns error)
node scanner.js

# When API is fixed, this will show real TradingView data
```

## Files

| File | Purpose |
|------|---------|
| `scanner.js` | Main screener (Node 18+, no dependencies) |
| `scanner-results.json` | JSON output from last run |
| `README.md` | Full documentation |
| `API_TROUBLESHOOTING.md` | How to fix the API issue |
| `payload-debug.log` | Debug payloads (created during live runs) |

## Customization

### Modify Scan Criteria
Edit `scanner.js` in the `SCANS` object (around line 63):

```javascript
const SCANS = {
  breakout: {
    name: 'Momentum Breakout',
    filters: [
      { left: 'close', operation: 'egreater', right: 'SMA50' },
      { left: 'Perf.W', operation: 'greater', right: 2 },  // ← Change here
      // ...
    ],
    sort: 'relative_volume_10d_calc|desc'
  },
  // ...
};
```

### Adjust Scoring Weights
Edit `scoreConfluence()` function (around line 254):

```javascript
// SMA50 > SMA200: +2  (change to +3 for higher weight)
if (stock.sma50 > stock.sma200) score += 2;
```

### Change Verdict Thresholds
Edit `calculateTradeMetrics()` (around line 347):

```javascript
if (stock.score >= 12) verdict = 'TRADE';    // Change 12 to 10, 15, etc
else if (stock.score >= 8) verdict = 'WATCH';
```

## 4 Scan Setups Explained

### 1️⃣ Momentum Breakout
**Setup**: Price breaking above SMA50 with elevated volume
- Criteria: Close > SMA50, Weekly gain > 2%, RSI 55-75
- Volume: 1.5x+ relative
- Best for: Quick momentum plays

### 2️⃣ Pullback to Support
**Setup**: Large cap stock pulling back to SMA200
- Criteria: Cap > $5B, Close > SMA200, RSI 42-52
- Volume: Below average (volume squeeze)
- Best for: Support bounces with institutional backing

### 3️⃣ Oversold Bounce
**Setup**: Severe oversold conditions
- Criteria: RSI < 35, Weekly loss > -4%, Monthly loss -10% to -45%
- Volume: Any
- Best for: Mean reversion plays

### 4️⃣ Early Trend Forming
**Setup**: New uptrend emerging
- Criteria: Cap > $2B, Price > SMA50, RSI 50-72, Monthly gain > 7%
- Volume: 1.1x+ relative
- Best for: Early trend confirmation

## Scoring Signals (13 Total, 21 Max)

Each stock gets points for:

**Trend Confirmation** (4 signals)
- SMA50 > SMA200: +2
- Price > EMA20: +1
- Weekly gain positive: +2
- Monthly gain > 5%: +2

**Momentum** (5 signals)
- RSI 40-75: +2 (RSI < 75 +1, RSI > 40 +1)
- MACD bullish: +2
- Price near 52W high: +2

**Volume** (2 signals)
- Relative volume > 1.5x: +2
- Relative volume > 1.1x: +1

**Size** (2 signals)
- Market cap > $5B: +2
- Market cap > $2B: +1

## Example Workflow

```bash
# 1. Test with mock data
node scanner.js --mock

# 2. Review console output and scanner-results.json

# 3. Identify high-scoring candidates

# 4. Check real prices on TradingView

# 5. Set alerts for stop prices

# 6. Enter when setup confirms
```

## Risk Management

Each stock shows:
- **Stop Price** = Entry - (ATR × 2)
- **T1 Target** = Entry + (ATR × 3)
- **Risk/Reward** = Implied in output

Example:
```
Stop: $166.52 | T1: $175.12
Entry: $169.96
Risk: $3.44 per share
Reward: $5.16 per share
R:R = 1.5:1
```

## Troubleshooting

### Mock mode works but live API fails?
See `API_TROUBLESHOOTING.md` for debugging steps

### Output looks wrong?
1. Check `scanner-results.json` for raw data
2. Verify mock data looks reasonable
3. Review scoring logic in `scanner.js`

### Want to use real data?
1. Get TradingView API token
2. Update HEADERS in scanner.js
3. Run `node scanner.js` (without --mock)

## Next Steps

### Short Term
- ✅ Test mock mode: `node scanner.js --mock`
- ✅ Review output format and scoring
- ✅ Customize scan filters for your style

### Medium Term
- 🔧 Fix live API (see API_TROUBLESHOOTING.md)
- 📊 Add more data sources if needed
- 📝 Create alert system for new candidates

### Long Term
- 🤖 Backtest scan combinations
- 📈 Integrate with broker API for auto-trading
- 📉 Add risk management rules
- 🔔 Real-time alert system

## Commands Reference

```bash
# Mock mode (no API needed)
node scanner.js --mock

# Live mode (requires API)
node scanner.js

# Debug payloads
node scanner.js
type payload-debug.log

# View results
type scanner-results.json

# Redirect output to file
node scanner.js --mock > scan-report.txt 2>&1
```

## Support

- **API Issues**: See `API_TROUBLESHOOTING.md`
- **Code Customization**: Edit `scanner.js` (well-commented)
- **Output Format**: Check `README.md` for full documentation

---

**Current Mode**: ✅ Mock (Fully Working) | ⚠️ Live API (Needs Debugging)

**Latest Run**: Check `scanner-results.json` for results

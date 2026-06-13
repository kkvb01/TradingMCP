# API Troubleshooting Guide

## Current Issue
TradingView scanner API returns: `{"error":"json parse error","data":null}` on all requests

## Root Cause Analysis

The endpoint `https://scanner.tradingview.com/america/scan?label-product=popup-screener-stock` is either:
1. Requiring authentication (Bearer token or session cookie)
2. Validating the JSON payload structure differently
3. Blocking automated requests via WAF
4. Changed endpoint structure/format

## Debugging Steps

### Step 1: Check Payload Structure
```bash
node scanner.js
# Check payload-debug.log for the actual JSON being sent
type payload-debug.log
```

### Step 2: Test with Browser DevTools
1. Open https://www.tradingview.com/screener/stocks/
2. Open DevTools → Network tab
3. Create a new screen/apply a filter
4. Look for POST request to `scanner.tradingview.com/america/scan`
5. Compare the request:
   - Headers (especially Authorization, Cookie, etc.)
   - Body structure
   - Response format

### Step 3: Add Authentication
If you see auth headers in browser request:
```javascript
// In scanner.js, update HEADERS:
const HEADERS = {
  'Content-Type': 'application/json',
  'Origin': 'https://www.tradingview.com',
  'Referer': 'https://www.tradingview.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Authorization': 'Bearer YOUR_TOKEN_HERE',  // Add if needed
  'Cookie': 'your-session-cookie-here'         // Add if needed
};
```

### Step 4: Validate JSON
```bash
# Create test-payload.js
node -e "
const payload = require('./scanner.js'); // Won't work, but shows pattern
console.log(JSON.stringify(payload, null, 2));
"
```

### Step 5: Capture from Browser
```javascript
// In browser console while on TradingView screener:
// Find the fetch call and copy its payload
fetch('https://scanner.tradingview.com/america/scan?label-product=popup-screener-stock', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    // YOUR PAYLOAD HERE
  })
}).then(r => r.json()).then(console.log)
```

## Alternative Solutions

### Option A: Use TradingView API (Official)
TradingView has an official REST API for premium users:
- Requires subscription
- More reliable
- Better rate limits

### Option B: Reverse Engineer from Browser
```javascript
// In browser console:
const requests = [];
const originalFetch = window.fetch;
window.fetch = function(...args) {
  if (args[0].includes('scanner.tradingview.com')) {
    requests.push({ url: args[0], body: args[1].body });
  }
  return originalFetch.apply(this, args);
};
// Now use the screener normally, then:
console.log(JSON.stringify(requests, null, 2));
```

### Option C: Use Historical Data
Instead of live API, use a data file:
```bash
# Modify scanner.js to accept CSV/JSON input
node scanner.js --data=stocks.json
```

## Quick Test Commands

```bash
# Test with curl
curl -X POST https://scanner.tradingview.com/america/scan?label-product=popup-screener-stock \
  -H "Content-Type: application/json" \
  -H "Origin: https://www.tradingview.com" \
  -H "Referer: https://www.tradingview.com/" \
  -d '{"symbols":{"query":{"types":[]}},"columns":["ticker-view","close"],"range":[0,10],"sort":"close|desc","filter2":{"operator":"and","operands":[{"expression":{"left":"type","operation":"equal","right":"stock"}}]}}'

# Expected: Either data or clear error message
```

## Working Solution: Mock Mode

Until API is fixed, use mock mode:
```bash
node scanner.js --mock
```

This allows you to:
- Test scoring logic
- Validate output format
- Pre-stage reports
- Replace mock data when API is ready

## Files for Reference

- `payload-debug.log` - Latest request payload
- `scanner-results.json` - Last run output
- `scanner.js` - Main implementation (lines 81-145 are filter definitions)

## Next Steps

1. **Immediate**: Use `node scanner.js --mock` for testing
2. **Short-term**: Capture real request from browser, compare with payload-debug.log
3. **Medium-term**: Add auth headers if needed, test with curl
4. **Long-term**: Consider official TradingView API or alternative data sources

## Community Resources

- GitHub: tv-scanners (TradingView community)
- Reddit: r/algotrading
- TradingView Documentation: https://www.tradingview.com/pine-script-docs/

## Debug Checklist

- [ ] Payload looks valid (check payload-debug.log)
- [ ] Browser can access TradingView screener
- [ ] Network request succeeds in browser but fails in Node.js
- [ ] Missing authentication headers
- [ ] CORS or WAF blocking the request
- [ ] API endpoint has changed
- [ ] Request body format mismatch

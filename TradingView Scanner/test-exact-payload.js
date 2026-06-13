#!/usr/bin/env node

const payload = {
  "columns": ["ticker-view", "close", "type", "typespecs", "pricescale", "minmov", "fractional", "minmove2", "currency", "change", "volume", "relative_volume_10d_calc", "market_cap_basic", "fundamental_currency_code", "price_earnings_ttm", "earnings_per_share_diluted_ttm", "earnings_per_share_diluted_yoy_growth_ttm", "dividends_yield_current", "sector.tr", "market", "sector", "AnalystRating", "AnalystRating.tr"],
  "filter": [
    { "left": "Perf.W", "operation": "greater", "right": 2 },
    { "left": "relative_volume_10d_calc", "operation": "greater", "right": 1.5 },
    { "left": "SMA50", "operation": "greater", "right": "SMA200" },
    { "left": "average_volume_30d_calc", "operation": "greater", "right": 1000000 },
    { "left": "RSI", "operation": "in_range", "right": [55, 75] },
    { "left": "close", "operation": "egreater", "right": "SMA50" }
  ],
  "ignore_unknown_fields": false,
  "options": { "lang": "en" },
  "range": [0, 100],
  "sort": { "sortBy": "relative_volume_10d_calc", "sortOrder": "desc" },
  "markets": ["america"],
  "filter2": {
    "operator": "and",
    "operands": [
      {
        "operation": {
          "operator": "or",
          "operands": [
            {
              "operation": {
                "operator": "and",
                "operands": [
                  { "expression": { "left": "type", "operation": "equal", "right": "stock" } },
                  { "expression": { "left": "typespecs", "operation": "has", "right": ["common"] } }
                ]
              }
            },
            {
              "operation": {
                "operator": "and",
                "operands": [
                  { "expression": { "left": "type", "operation": "equal", "right": "stock" } },
                  { "expression": { "left": "typespecs", "operation": "has", "right": ["preferred"] } }
                ]
              }
            },
            {
              "operation": {
                "operator": "and",
                "operands": [
                  { "expression": { "left": "type", "operation": "equal", "right": "dr" } }
                ]
              }
            },
            {
              "operation": {
                "operator": "and",
                "operands": [
                  { "expression": { "left": "type", "operation": "equal", "right": "fund" } },
                  { "expression": { "left": "typespecs", "operation": "has_none_of", "right": ["etf", "mutual"] } }
                ]
              }
            }
          ]
        }
      },
      { "expression": { "left": "typespecs", "operation": "has_none_of", "right": ["pre-ipo"] } }
    ]
  }
};

const HEADERS = {
  'Content-Type': 'application/json',
  'Origin': 'https://www.tradingview.com',
  'Referer': 'https://www.tradingview.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

console.log('Testing TradingView Scanner API...\n');
console.log('Endpoint: https://scanner.tradingview.com/america/scan?label-product=popup-screener-stock\n');
console.log('Payload:', JSON.stringify(payload, null, 2).slice(0, 300) + '...\n');

fetch('https://scanner.tradingview.com/america/scan?label-product=popup-screener-stock', {
  method: 'POST',
  headers: HEADERS,
  body: JSON.stringify(payload)
})
  .then(res => {
    console.log(`Status: ${res.status} ${res.statusText}`);
    console.log('Headers:', Object.fromEntries(res.headers));
    return res.text();
  })
  .then(text => {
    console.log('\n✓ Response received:\n');
    try {
      const json = JSON.parse(text);
      console.log(JSON.stringify(json, null, 2));
      
      if (json.data && json.data.length > 0) {
        console.log(`\n✅ SUCCESS! Got ${json.data.length} results`);
        console.log('\nFirst result:');
        console.log(JSON.stringify(json.data[0], null, 2));
      } else if (json.data) {
        console.log(`\n⚠️ Got empty results array (totalCount: ${json.totalCount})`);
      }
    } catch (e) {
      console.log('(Plain text response)');
      console.log(text);
    }
  })
  .catch(err => {
    console.error('❌ Error:', err.message);
  });

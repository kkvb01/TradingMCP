#!/usr/bin/env node

const ENDPOINT = 'https://scanner.tradingview.com/america/scan?label-product=popup-screener-stock';

const HEADERS = {
  'Content-Type': 'application/json',
  'Origin': 'https://www.tradingview.com',
  'Referer': 'https://www.tradingview.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

// Minimal payload - just get any stocks
const payload = {
  symbols: { query: { types: [] } },
  columns: ['ticker-view', 'close'],
  range: [0, 10],
  sort: 'close|desc',
  filter2: {
    operator: 'and',
    operands: [
      {
        expression: {
          left: 'type',
          operation: 'equal',
          right: 'stock'
        }
      }
    ]
  }
};

console.log('Testing minimal payload...\n');
console.log('Payload:', JSON.stringify(payload, null, 2));
console.log('\nSending request...\n');

fetch(ENDPOINT, {
  method: 'POST',
  headers: HEADERS,
  body: JSON.stringify(payload)
})
.then(res => {
  console.log(`Status: ${res.status}`);
  return res.text();
})
.then(text => {
  console.log('Response:', text);
  try {
    const data = JSON.parse(text);
    console.log('\nParsed:', JSON.stringify(data, null, 2));
  } catch (e) {
    console.log('(Could not parse as JSON)');
  }
})
.catch(err => console.error('Error:', err.message));

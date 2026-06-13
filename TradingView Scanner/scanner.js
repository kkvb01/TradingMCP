#!/usr/bin/env node

/**
 * TradingView Scanner - 4 Swing Trade Setup Screener
 * Consolidates, deduplicates, and scores candidates by confluence
 * 
 * USAGE:
 *   node scanner.js          # Run with live API
 *   node scanner.js --mock   # Run with mock data (for testing)
 */

const USE_MOCK = process.argv.includes('--mock');

// ── Scanner MCP upload config ─────────────────────────────────────────────────
// After deploying cloudflare/scanner-mcp, fill these in:
//   WORKER_URL : your worker URL, e.g. https://scanner-mcp.tda-guardrails.workers.dev
//   API_KEY    : the value you set with: npx wrangler secret put SCANNER_API_KEY
// Leave WORKER_URL empty to skip upload (report still saved locally).
const UPLOAD_CONFIG = {
  WORKER_URL: process.env.SCANNER_WORKER_URL || 'https://scanner-mcp.tda-guardrails.workers.dev',
  API_KEY:    process.env.SCANNER_API_KEY    || '',
};

const ENDPOINT = 'https://scanner.tradingview.com/america/scan?label-product=popup-screener-stock';

const HEADERS = {
  'Content-Type': 'application/json',
  'Origin': 'https://www.tradingview.com',
  'Referer': 'https://www.tradingview.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  // TODO: Add auth header if API requires: 'Authorization': 'Bearer YOUR_TOKEN'
};

const COMMON_FILTER2 = {
  operator: 'and',
  operands: [
    {
      operation: {
        operator: 'or',
        operands: [
          { operation: { operator: 'and', operands: [{ expression: { left: 'type', operation: 'equal', right: 'stock' } }, { expression: { left: 'typespecs', operation: 'has', right: ['common'] } }] } },
          { operation: { operator: 'and', operands: [{ expression: { left: 'type', operation: 'equal', right: 'stock' } }, { expression: { left: 'typespecs', operation: 'has', right: ['preferred'] } }] } },
          { operation: { operator: 'and', operands: [{ expression: { left: 'type', operation: 'equal', right: 'dr' } }] } },
          { operation: { operator: 'and', operands: [{ expression: { left: 'type', operation: 'equal', right: 'fund' } }, { expression: { left: 'typespecs', operation: 'has_none_of', right: ['etf', 'mutual'] } }] } }
        ]
      }
    },
    { expression: { left: 'typespecs', operation: 'has_none_of', right: ['pre-ipo'] } }
  ]
};

const SCANS = {
  breakout: {
    name: 'Momentum Breakout',
    filters: [
      { left: 'Perf.W', operation: 'greater', right: 2 },
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 1.5 },
      { left: 'SMA50', operation: 'greater', right: 'SMA200' },
      { left: 'average_volume_30d_calc', operation: 'greater', right: 1000000 },
      { left: 'RSI', operation: 'in_range', right: [55, 75] },
      { left: 'close', operation: 'egreater', right: 'SMA50' }
    ],
    sort: 'relative_volume_10d_calc|desc'
  },
  pullback: {
    name: 'Pullback to Support',
    filters: [
      { left: 'average_volume_30d_calc', operation: 'greater', right: 2000000 },
      { left: 'market_cap_basic', operation: 'greater', right: 5000000000 },
      { left: 'close', operation: 'greater', right: 10 },
      { left: 'SMA50', operation: 'greater', right: 'SMA200' },
      { left: 'close', operation: 'egreater', right: 'SMA200' },
      { left: 'RSI', operation: 'in_range', right: [42, 52] },
      { left: 'RSI[1W]', operation: 'greater', right: 45 },
      { left: 'relative_volume_10d_calc', operation: 'less', right: 0.9 },
      { left: 'Perf.W', operation: 'in_range', right: [-8, -1] },
      { left: 'Perf.1M', operation: 'greater', right: 3 }
    ],
    sort: 'RSI|asc'
  },
  oversold: {
    name: 'Oversold Bounce',
    filters: [
      { left: 'average_volume_30d_calc', operation: 'greater', right: 1000000 },
      { left: 'market_cap_basic', operation: 'greater', right: 5000000000 },
      { left: 'close', operation: 'greater', right: 10 },
      { left: 'RSI', operation: 'less', right: 35 },
      { left: 'Perf.W', operation: 'less', right: -4 },
      { left: 'Perf.1M', operation: 'in_range', right: [-45, -10] }
    ],
    sort: 'RSI|asc'
  },
  early_trend: {
    name: 'Early Trend Forming',
    filters: [
      { left: 'average_volume_30d_calc', operation: 'greater', right: 1000000 },
      { left: 'market_cap_basic', operation: 'greater', right: 2000000000 },
      { left: 'close', operation: 'greater', right: 10 },
      { left: 'close', operation: 'egreater', right: 'SMA50' },
      { left: 'RSI', operation: 'in_range', right: [50, 72] },
      { left: 'Perf.1M', operation: 'greater', right: 7 },
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 1.1 }
    ],
    sort: 'Perf.1M|desc'
  }
};

/**
 * Generate mock data for testing
 */
function generateMockData(scanKey) {
  const tickers = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'TSLA', 'AMD', 'AVGO', 'CRM', 'ADBE', 'MU'];
  const sectors = ['Technology', 'Finance', 'Healthcare', 'Energy', 'Consumer'];
  
  const mockRows = tickers.map((ticker, idx) => {
    const baseClose = 50 + Math.random() * 150;
    const rsi = 30 + Math.random() * 60;
    const rsiW = 40 + Math.random() * 50;
    
    return {
      s: `NASDAQ:${ticker}`,
      d: [
        ticker,                              // 0
        baseClose,                           // 1: close
        Math.random() * 4 - 2,              // 2: change
        Math.random() * 8 - 2,              // 3: Perf.W
        Math.random() * 20 - 5,             // 4: Perf.1M
        Math.random() * 100000000,          // 5: volume
        Math.random() * 5000000 + 1000000,  // 6: avg_vol_30d
        Math.random() * 2 + 0.5,            // 7: rel_vol_10d
        Math.random() * 2000000000 + 1000000000, // 8: market_cap
        rsi,                                 // 9: RSI
        rsiW,                               // 10: RSI[1W]
        baseClose * (0.95 + Math.random() * 0.08), // 11: SMA50
        baseClose * (0.90 + Math.random() * 0.12), // 12: SMA200
        baseClose * (0.98 + Math.random() * 0.04), // 13: EMA20
        Math.random() * 2 + 0.5,            // 14: ATR
        baseClose * (1.1 + Math.random() * 0.3),  // 15: High.52W
        Math.random() * 2 - 1,              // 16: MACD
        Math.random() * 2 - 1,              // 17: MACD_signal
        sectors[Math.floor(Math.random() * sectors.length)], // 18: sector
        'Buy'                               // 19: AnalystRating
      ]
    };
  });

  return mockRows;
}

/**
 * Build scan request payload
 */
function buildScanPayload(scanKey) {
  const scan = SCANS[scanKey];
  
  // Parse sort string "field|asc" -> { sortBy: "field", sortOrder: "asc" }
  const [sortBy, sortOrder] = scan.sort.split('|');

  return {
    columns: [
      'ticker-view', 'close', 'type', 'typespecs', 'pricescale', 'minmov', 'fractional', 'minmove2',
      'currency', 'change', 'volume', 'relative_volume_10d_calc', 'market_cap_basic',
      'fundamental_currency_code', 'price_earnings_ttm', 'earnings_per_share_diluted_ttm',
      'earnings_per_share_diluted_yoy_growth_ttm', 'dividends_yield_current', 'sector.tr', 'market',
      'sector', 'AnalystRating', 'AnalystRating.tr',
      // d[23] onward — technical indicators used in filters, now also returned as data
      'RSI', 'RSI[1W]', 'SMA50', 'SMA200', 'EMA20', 'ATR', 'High.52W',
      'MACD.macd', 'MACD.signal', 'Perf.W', 'Perf.1M', 'average_volume_30d_calc'
    ],
    filter: scan.filters,
    ignore_unknown_fields: false,
    options: { lang: 'en' },
    range: [0, 250],
    sort: { sortBy, sortOrder },
    markets: ['america'],
    filter2: COMMON_FILTER2
  };
}

/**
 * Make scan API request or return mock data
 */
async function runScan(scanKey) {
  try {
    // Use mock data if requested
    if (USE_MOCK) {
      await new Promise(resolve => setTimeout(resolve, 200)); // Simulate network delay
      const data = generateMockData(scanKey);
      console.log(`✓ ${SCANS[scanKey].name}: ${data.length} mock results`);
      return { scanKey, data };
    }

    // Live API request
    const payload = buildScanPayload(scanKey);
    
    const fs = require('fs');
    fs.appendFileSync('payload-debug.log', `\n=== ${scanKey} ===\n${JSON.stringify(payload, null, 2)}\n`);
    
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Scan ${scanKey} failed with status ${response.status}`);
      console.error(`   Error: ${errorText}`);
      return { scanKey, data: [] };
    }

    const data = await response.json();
    const rows = data.data || [];
    
    if (rows.length === 0) {
      console.log(`⚠️  ${SCANS[scanKey].name}: 0 results`);
    } else {
      console.log(`✓ ${SCANS[scanKey].name}: ${rows.length} results`);
    }
    
    return { scanKey, data: rows };
  } catch (error) {
    console.error(`❌ Scan ${scanKey} error:`, error.message);
    return { scanKey, data: [] };
  }
}

/**
 * Parse row data to object with column names
 */
function parseRow(row, scanKey) {
  const ticker = row.s.split(':')[1]; // Extract AAPL from NASDAQ:AAPL
  const data = row.d;

  // Column mapping from buildScanPayload columns array:
  // d[0] = ticker-view (metadata object)
  // d[1] = close
  // d[2] = type
  // d[3] = typespecs
  // d[4] = pricescale
  // d[5] = minmov
  // d[6] = fractional
  // d[7] = minmove2
  // d[8] = currency
  // d[9] = change
  // d[10] = volume
  // d[11] = relative_volume_10d_calc
  // d[12] = market_cap_basic
  // d[13] = fundamental_currency_code
  // d[14] = price_earnings_ttm
  // d[15] = earnings_per_share_diluted_ttm
  // d[16] = earnings_per_share_diluted_yoy_growth_ttm
  // d[17] = dividends_yield_current
  // d[18] = sector.tr
  // d[19] = market
  // d[20] = sector
  // d[21] = AnalystRating
  // d[22] = AnalystRating.tr

  return {
    ticker,
    raw_ticker: row.s,
    scanKey,
    close: data[1],                    // close
    change: data[9],                   // change
    volume: data[10],                  // volume
    rel_vol_10d: data[11],             // relative_volume_10d_calc
    market_cap: data[12],              // market_cap_basic
    sector: data[20],                  // sector
    analyst_rating: data[21],          // AnalystRating
    // d[23..34] — technical indicators added to columns
    rsi: data[23] ?? null,             // RSI
    rsi_weekly: data[24] ?? null,      // RSI[1W]
    sma50: data[25] ?? null,           // SMA50
    sma200: data[26] ?? null,          // SMA200
    ema20: data[27] ?? null,           // EMA20
    atr: data[28] ?? null,             // ATR
    high_52w: data[29] ?? null,        // High.52W
    macd: data[30] ?? null,            // MACD.macd
    macd_signal: data[31] ?? null,     // MACD.signal
    perf_w: data[32] ?? null,          // Perf.W
    perf_1m: data[33] ?? null,         // Perf.1M
    avg_vol_30d: data[34] ?? null      // average_volume_30d_calc
  };
}

/**
 * Score stock by confluence signals (21 points max)
 * Since API filters provide technical criteria, score based on:
 * - Multiple scan hits (5 pts)
 * - Analyst rating (5 pts)
 * - Volume quality (3 pts)
 * - Daily performance (3 pts)
 */
function scoreConfluence(stock) {
  let score = 0;

  // Multi-scan hits (5 pts max)
  const scanCount = stock.found_in?.length || 1;
  if (scanCount >= 3) score += 5;
  else if (scanCount === 2) score += 4;
  else score += 2;

  // Analyst rating (5 pts max)
  const rating = (stock.analyst_rating || '').toLowerCase();
  if (rating.includes('strong buy')) score += 5;
  else if (rating.includes('buy')) score += 3;
  else if (rating.includes('hold')) score += 1;
  else if (rating.includes('sell')) score -= 2;

  // Volume quality (3 pts max)
  if (stock.rel_vol_10d != null) {
    if (stock.rel_vol_10d > 2.0) score += 3;
    else if (stock.rel_vol_10d > 1.5) score += 2;
    else if (stock.rel_vol_10d > 1.0) score += 1;
  }

  // Daily performance (3 pts max)
  if (stock.change != null) {
    if (stock.change > 5) score += 3;
    else if (stock.change > 2) score += 2;
    else if (stock.change > 0) score += 1;
    else if (stock.change < -3) score -= 1;
  }

  // Market cap stability bonus (2 pts)
  if (stock.market_cap != null && stock.market_cap > 5000000000) score += 2;

  // Cap at 21 max
  return Math.min(21, Math.max(0, score));
}

/**
 * Consolidate and deduplicate results
 */
function consolidateResults(allScans) {
  const consolidated = {};

  for (const { scanKey, data } of allScans) {
    for (const row of data) {
      const parsed = parseRow(row, scanKey);
      const ticker = parsed.ticker;

      // Skip stocks with missing critical data (only close price is required)
      if (parsed.close == null) continue;

      if (!consolidated[ticker]) {
        consolidated[ticker] = {
          ...parsed,
          found_in: [],
          score: 0
        };
      } else {
        // Update with latest data if available
        if (!consolidated[ticker].sector && parsed.sector) consolidated[ticker].sector = parsed.sector;
      }

      consolidated[ticker].found_in.push(scanKey);
    }
  }

  // Score each stock
  for (const ticker in consolidated) {
    consolidated[ticker].score = scoreConfluence(consolidated[ticker]);
  }

  return consolidated;
}

/**
 * Calculate trade metrics (stop loss, take profit targets)
 * Uses percentage-based approach since ATR not available from API
 */
function calculateTradeMetrics(stock) {
  const entry = stock.close;
  
  // Use change as proxy for volatility assessment
  // Conservative: 2% stop loss, 3% target for oversold scans
  // More aggressive: 3% stop loss, 6% target for breakout scans
  const isBreakout = stock.found_in?.includes('breakout');
  const isOversold = stock.found_in?.includes('oversold');
  
  let stopPercent = 2.5;  // Default stop loss
  let t1Percent = 5;      // Default take profit
  
  if (isBreakout) {
    stopPercent = 3;
    t1Percent = 7;
  } else if (isOversold) {
    stopPercent = 2;
    t1Percent = 4;
  }
  
  const stop = entry * (1 - stopPercent / 100);
  const t1 = entry * (1 + t1Percent / 100);

  let verdict = 'SKIP';
  if (stock.score >= 12) verdict = 'TRADE';
  else if (stock.score >= 8) verdict = 'WATCH';

  const macdStatus = (stock.macd != null && stock.macd_signal != null && stock.macd > stock.macd_signal) ? 'BULLISH' : 'BEARISH';

  return { entry, stop, t1, verdict, macdStatus };
}

/**
 * Format stock output line
 */
function formatStockLine(ticker, stock, metrics) {
  const found = stock.found_in.map(s => {
    const names = {
      breakout: 'breakout',
      pullback: 'pullback',
      oversold: 'oversold',
      early_trend: 'early_trend'
    };
    return names[s];
  }).join(', ');

  // Safe access with defaults for missing data
  const safeNum = (val, decimals = 1) => val != null ? parseFloat(val).toFixed(decimals) : 'N/A';
  const safeCap = (val) => val != null ? (val / 1e9).toFixed(2) : 'N/A';

  const lines = [
    `[${ticker}] — ${metrics.verdict} (${stock.score}/21) | Found in: ${found}`,
    `  Price: $${safeNum(stock.close, 2)} | Change: ${safeNum(stock.change, 2)}% | RelVol: ${safeNum(stock.rel_vol_10d, 2)}x`,
    `  Rating: ${stock.analyst_rating || 'N/A'} | Cap: $${safeCap(stock.market_cap)}B | Sector: ${stock.sector || 'N/A'}`,
    `  Stop: $${safeNum(metrics.stop, 2)} | T1: $${safeNum(metrics.t1, 2)} | Risk/Reward: ${((metrics.t1 - stock.close) / (stock.close - metrics.stop)).toFixed(1)}:1`
  ];

  return lines.join('\n');
}

/**
 * Format and display results
 */
function displayResults(consolidated) {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  
  // Separate by verdict and sort
  const multiScanHits = [];
  const tradeList = [];
  const watchList = [];

  for (const ticker in consolidated) {
    const stock = consolidated[ticker];
    const metrics = calculateTradeMetrics(stock);

    if (stock.found_in.length > 1) {
      multiScanHits.push({ ticker, stock, metrics });
    } else if (metrics.verdict === 'TRADE') {
      tradeList.push({ ticker, stock, metrics });
    } else if (metrics.verdict === 'WATCH') {
      watchList.push({ ticker, stock, metrics });
    }
  }

  // Sort
  multiScanHits.sort((a, b) => b.stock.score - a.stock.score);
  tradeList.sort((a, b) => b.stock.score - a.stock.score);
  watchList.sort((a, b) => b.stock.score - a.stock.score);

  // Display header
  console.log('\n' + '='.repeat(80));
  console.log(`=== TV SCANNER RESULTS — ${timestamp} ===`);
  console.log('='.repeat(80));
  console.log(`Scans run: ${Object.values(SCANS).map(s => s.name.split(' ')[0]).join(', ')} ${USE_MOCK ? '(MOCK DATA)' : ''}`);
  console.log(`Total candidates: ${Object.keys(consolidated).length} | TRADE: ${multiScanHits.filter(h => h.metrics.verdict === 'TRADE').length + tradeList.length} | WATCH: ${multiScanHits.filter(h => h.metrics.verdict === 'WATCH').length + watchList.length}\n`);

  // Multi-scan hits
  if (multiScanHits.length > 0) {
    console.log('MULTI-SCAN HITS (highest priority):');
    for (const { ticker, stock, metrics } of multiScanHits) {
      console.log(formatStockLine(ticker, stock, metrics));
      console.log('');
    }
    console.log('─'.repeat(80) + '\n');
  }

  // Trade candidates
  if (tradeList.length > 0) {
    console.log('TRADE candidates (score >= 12):');
    for (const { ticker, stock, metrics } of tradeList) {
      console.log(formatStockLine(ticker, stock, metrics));
      console.log('');
    }
    console.log('─'.repeat(80) + '\n');
  }

  // Watch candidates
  if (watchList.length > 0) {
    console.log('WATCH candidates (score 8-11):');
    for (const { ticker, stock, metrics } of watchList) {
      console.log(formatStockLine(ticker, stock, metrics));
      console.log('');
    }
  }

  console.log('='.repeat(80) + '\n');

  return { multiScanHits, tradeList, watchList };
}

/**
 * Save results to JSON
 */
async function saveResults(consolidated, categories) {
  const timestamp = new Date().toISOString();
  
  const output = {
    timestamp,
    mode: USE_MOCK ? 'mock' : 'live',
    summary: {
      total_candidates: Object.keys(consolidated).length,
      multi_scan_hits: categories.multiScanHits.length,
      trade_candidates: categories.multiScanHits.filter(h => h.metrics.verdict === 'TRADE').length + categories.tradeList.length,
      watch_candidates: categories.multiScanHits.filter(h => h.metrics.verdict === 'WATCH').length + categories.watchList.length
    },
    scans: Object.entries(SCANS).map(([key, scan]) => ({
      id: key,
      name: scan.name
    })),
    stocks: Object.entries(consolidated).map(([ticker, stock]) => {
      const metrics = calculateTradeMetrics(stock);
      return {
        ticker,
        score: stock.score,
        verdict: metrics.verdict,
        found_in: stock.found_in,
        price: stock.close,
        rsi: stock.rsi,
        rsi_weekly: stock.rsi_weekly,
        sma50: stock.sma50,
        sma200: stock.sma200,
        ema20: stock.ema20,
        atr: stock.atr,
        high_52w: stock.high_52w,
        market_cap: stock.market_cap,
        perf_w: stock.perf_w,
        perf_1m: stock.perf_1m,
        rel_vol_10d: stock.rel_vol_10d,
        avg_vol_30d: stock.avg_vol_30d,
        macd: stock.macd,
        macd_signal: stock.macd_signal,
        sector: stock.sector,
        analyst_rating: stock.analyst_rating,
        stop_price: metrics.stop,
        t1_target: metrics.t1,
        macd_status: metrics.macdStatus
      };
    }).sort((a, b) => {
      // Multi-scan first, then by score desc
      const aMulti = a.found_in.length > 1 ? 0 : 1;
      const bMulti = b.found_in.length > 1 ? 0 : 1;
      if (aMulti !== bMulti) return aMulti - bMulti;
      return b.score - a.score;
    })
  };

  const fs = require('fs');
  fs.writeFileSync('scanner-results.json', JSON.stringify(output, null, 2));
  console.log('✓ Results saved to scanner-results.json');
}

/**
 * Upload scan results to the scanner-mcp Cloudflare Worker.
 * Skipped silently if UPLOAD_CONFIG.WORKER_URL is not set.
 */
async function uploadResults(data) {
  const { WORKER_URL, API_KEY } = UPLOAD_CONFIG;
  if (!WORKER_URL) return; // not configured, skip

  try {
    const res = await fetch(`${WORKER_URL}/update`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(data),
    });

    if (res.ok) {
      const json = await res.json();
      console.log(`✓ Uploaded to scanner-mcp — ${json.trade_candidates} TRADE, ${json.watch_candidates} WATCH`);
    } else {
      console.warn(`⚠ Upload failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`⚠ Upload error (scan results still saved locally): ${err.message}`);
  }
}

/**
 * Main execution
 */
async function main() {
  const fs = require('fs');
  
  console.log('\n📊 TradingView Scanner - 4 Swing Trade Setups');
  console.log(`Mode: ${USE_MOCK ? 'MOCK DATA (for testing)' : 'LIVE API'}\n`);
  console.log('Running scans...\n');

  // Clear debug log
  if (!USE_MOCK) {
    fs.writeFileSync('payload-debug.log', '');
  }

  try {
    // Run all 4 scans in parallel
    const allScans = await Promise.all([
      runScan('breakout'),
      runScan('pullback'),
      runScan('oversold'),
      runScan('early_trend')
    ]);

    console.log('\n📈 Consolidating & scoring...\n');

    // Consolidate and deduplicate
    const consolidated = consolidateResults(allScans);

    // Display formatted results
    const categories = displayResults(consolidated);

    // Save to JSON
    await saveResults(consolidated, categories);

    // Upload to scanner-mcp Worker (if configured)
    const savedData = require('./scanner-results.json');
    await uploadResults(savedData);

  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

main();

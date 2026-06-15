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
};

// ── Sector-first config ───────────────────────────────────────────────────────
const TOP_SECTORS_COUNT = 3; // Top N sectors by weekly ETF momentum to focus on

// Maps SPDR sector ETF tickers → TradingView sector strings used in stock screener
const SECTOR_ETF_MAP = {
  'XLK':  'Technology',
  'XLF':  'Financial Services',
  'XLE':  'Energy',
  'XLY':  'Consumer Cyclical',
  'XLV':  'Healthcare',
  'XLI':  'Industrials',
  'XLB':  'Basic Materials',
  'XLP':  'Consumer Defensive',
  'XLRE': 'Real Estate',
  'XLU':  'Utilities',
  'XLC':  'Communication Services',
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
      { left: 'close', operation: 'greater', right: 5 },
      { left: 'market_cap_basic', operation: 'greater', right: 2000000000 },
      { left: 'average_volume_30d_calc', operation: 'greater', right: 1000000 },
      { left: 'Perf.W', operation: 'greater', right: 2 },
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 1.5 },
      { left: 'SMA50', operation: 'greater', right: 'SMA200' },
      { left: 'close', operation: 'egreater', right: 'SMA50' },
      { left: 'close', operation: 'egreater', right: 'SMA200' },
      { left: 'RSI', operation: 'in_range', right: [55, 75] }
    ],
    sort: 'relative_volume_10d_calc|desc'
  },
  pullback: {
    name: 'Pullback to Support',
    filters: [
      { left: 'close', operation: 'greater', right: 5 },
      { left: 'market_cap_basic', operation: 'greater', right: 2000000000 },
      { left: 'average_volume_30d_calc', operation: 'greater', right: 1000000 },
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
    // No SMA200 filter — oversold stocks are expected to be in downtrends
    filters: [
      { left: 'close', operation: 'greater', right: 5 },
      { left: 'market_cap_basic', operation: 'greater', right: 2000000000 },
      { left: 'average_volume_30d_calc', operation: 'greater', right: 1000000 },
      { left: 'RSI', operation: 'less', right: 35 },
      { left: 'Perf.W', operation: 'less', right: -4 },
      { left: 'Perf.1M', operation: 'in_range', right: [-45, -10] }
    ],
    sort: 'RSI|asc'
  },
  early_trend: {
    name: 'Early Trend Forming',
    filters: [
      { left: 'close', operation: 'greater', right: 5 },
      { left: 'market_cap_basic', operation: 'greater', right: 2000000000 },
      { left: 'average_volume_30d_calc', operation: 'greater', right: 1000000 },
      { left: 'close', operation: 'egreater', right: 'SMA50' },
      { left: 'close', operation: 'egreater', right: 'SMA200' },
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
  const sectors = ['Technology', 'Financial Services', 'Healthcare', 'Energy', 'Consumer Cyclical'];
  
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
 * Rank sectors by SPDR ETF weekly performance.
 * Returns all 11 sectors sorted by Perf.W desc, each tagged with rank.
 * Returns null if the request fails — callers skip sector filtering.
 */
async function scanSectors() {
  if (USE_MOCK) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const mock = [
      { etf: 'XLK',  sector: 'Technology',            perf_w:  3.2, perf_1m:  8.1, rsi: 62, rank: 1 },
      { etf: 'XLC',  sector: 'Communication Services', perf_w:  2.8, perf_1m:  6.5, rsi: 58, rank: 2 },
      { etf: 'XLY',  sector: 'Consumer Cyclical',      perf_w:  2.1, perf_1m:  5.2, rsi: 55, rank: 3 },
      { etf: 'XLF',  sector: 'Financial Services',     perf_w:  1.4, perf_1m:  4.8, rsi: 54, rank: 4 },
      { etf: 'XLV',  sector: 'Healthcare',             perf_w:  0.9, perf_1m:  2.1, rsi: 51, rank: 5 },
      { etf: 'XLI',  sector: 'Industrials',            perf_w:  0.3, perf_1m:  1.8, rsi: 49, rank: 6 },
      { etf: 'XLB',  sector: 'Basic Materials',        perf_w: -0.2, perf_1m:  0.5, rsi: 47, rank: 7 },
      { etf: 'XLP',  sector: 'Consumer Defensive',     perf_w: -0.8, perf_1m: -0.2, rsi: 45, rank: 8 },
      { etf: 'XLRE', sector: 'Real Estate',            perf_w: -1.2, perf_1m: -1.5, rsi: 43, rank: 9 },
      { etf: 'XLU',  sector: 'Utilities',              perf_w: -1.8, perf_1m: -2.1, rsi: 41, rank: 10 },
      { etf: 'XLE',  sector: 'Energy',                 perf_w: -2.4, perf_1m: -4.8, rsi: 38, rank: 11 },
    ];
    console.log('✓ Sector scan: mock data');
    return mock;
  }

  const etfTickers = Object.keys(SECTOR_ETF_MAP).map(t => `AMEX:${t}`);

  const payload = {
    columns: ['ticker-view', 'close', 'Perf.W', 'Perf.1M', 'RSI', 'relative_volume_10d_calc'],
    // d[0]=ticker-view  d[1]=close  d[2]=Perf.W  d[3]=Perf.1M  d[4]=RSI  d[5]=rel_vol
    symbols: { tickers: etfTickers },
    sort: { sortBy: 'Perf.W', sortOrder: 'desc' },
    range: [0, 20],
    options: { lang: 'en' },
    ignore_unknown_fields: false
  };

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.warn(`⚠ Sector scan failed (HTTP ${response.status}) — no sector filter applied`);
      return null;
    }

    const json = await response.json();
    const rows = json.data || [];

    const ranked = rows
      .map(row => {
        const etf = row.s.split(':')[1];
        const d = row.d;
        return {
          etf,
          sector:  SECTOR_ETF_MAP[etf] || etf,
          close:   d[1]  ?? null,
          perf_w:  d[2]  ?? null,
          perf_1m: d[3]  ?? null,
          rsi:     d[4]  ?? null,
          rel_vol: d[5]  ?? null,
        };
      })
      .filter(s => s.perf_w != null)
      .sort((a, b) => b.perf_w - a.perf_w)
      .map((s, i) => ({ ...s, rank: i + 1 }));

    console.log(`✓ Sector scan: ${ranked.length} sectors ranked`);
    return ranked.length > 0 ? ranked : null;
  } catch (err) {
    console.warn(`⚠ Sector scan error: ${err.message} — no sector filter applied`);
    return null;
  }
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
    type: data[2],                     // 'stock', 'dr' (ADR/depositary receipt), 'fund'
    close: data[1],                    // close
    change: data[9],                   // change
    volume: data[10],                  // volume
    rel_vol_10d: data[11],             // relative_volume_10d_calc
    market_cap: data[12],              // market_cap_basic
    eps_growth: data[16] ?? null,      // earnings_per_share_diluted_yoy_growth_ttm
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
 * Auto-detect catalysts from available API data.
 * [MOMENTUM] and [EARNINGS] can be derived from screener fields.
 * [INDEX], [UPGRADE], [SECTOR] require external data — not auto-detected.
 */
function detectCatalysts(stock) {
  const catalysts = [];
  if (stock.perf_w != null && stock.perf_w > 10) catalysts.push('[MOMENTUM]');
  if (stock.eps_growth != null && stock.eps_growth > 15) catalysts.push('[EARNINGS]');
  return catalysts;
}

/**
 * Score stock by confluence signals (max ~15 pts)
 *
 * Components:
 *   Scan confluence : 1 scan=1, 2 scans=3, 3+=4     (max 4)
 *   Analyst rating  : StrongBuy=3, Buy=2, Sell=-2    (max 3)
 *   MACD contextual : bullish+SMA50=+2, else varies  (max 2)
 *   RSI zone        : 45-65=+2, 65-70=+1             (max 2)
 *   Price vs MAs    : above both=+2, SMA50 only=+1   (max 2)
 *   Volume (Vol×)   : >3x=+2, 1.5-3x=+1             (max 2)
 */
function scoreConfluence(stock) {
  const catalysts = detectCatalysts(stock);
  stock.catalysts = catalysts;
  const hasCatalyst = catalysts.length > 0;

  const aboveSMA50  = stock.close != null && stock.sma50  != null && stock.close > stock.sma50;
  const aboveSMA200 = stock.close != null && stock.sma200 != null && stock.close > stock.sma200;
  const macdBullish = stock.macd != null && stock.macd_signal != null && stock.macd > stock.macd_signal;

  // Build flags for output
  stock.flags = [];
  if (stock.type === 'dr') stock.flags.push('ADR');
  if (stock.rsi != null && stock.rsi > 70) stock.flags.push('OVERBOUGHT');
  if (stock.rsi != null && stock.rsi < 30) stock.flags.push('OVERSOLD_BOUNCE');

  let score = 0;

  // Scan confluence (max 4 pts)
  const scanCount = stock.found_in?.length || 1;
  if (scanCount >= 3) score += 4;
  else if (scanCount === 2) score += 3;
  else score += 1;

  // Analyst rating (max 3 pts)
  const rating = (stock.analyst_rating || '').toLowerCase();
  if (rating.includes('strong buy')) score += 3;
  else if (rating.includes('buy')) score += 2;
  else if (rating.includes('sell')) score -= 2;

  // MACD contextual (max +2, min -1)
  if (macdBullish && aboveSMA50) score += 2;
  else if (!macdBullish && aboveSMA50 && hasCatalyst) score += 1;
  else if (!macdBullish && !aboveSMA50) score -= 1;
  // MACD bearish + below SMA200 → hard exclude handled in calculateTradeMetrics

  // RSI zone (max +2)
  const rsi = stock.rsi;
  if (rsi != null) {
    if (rsi >= 45 && rsi <= 65) score += 2;
    else if (rsi > 65 && rsi <= 70) score += 1;
    else if (rsi < 40 && hasCatalyst) score += 1;
    // RSI > 70: 0 pts (flagged OVERBOUGHT)
    // RSI < 40 without catalyst: 0 pts
  }

  // Price vs moving averages (max +2)
  if (aboveSMA50 && aboveSMA200) score += 2;
  else if (aboveSMA50) score += 1;

  // Volume — Vol× (max +2)
  if (stock.rel_vol_10d != null) {
    if (stock.rel_vol_10d > 3.0) score += 2;
    else if (stock.rel_vol_10d >= 1.5) score += 1;
  }

  return Math.max(0, score);
}

/**
 * Consolidate and deduplicate results.
 * topSectors: array of { sector, rank } objects — stocks not in this set are dropped.
 * Pass null to skip sector filtering.
 */
function consolidateResults(allScans, topSectors) {
  const topSectorSet = topSectors
    ? new Set(topSectors.map(s => s.sector.toLowerCase()))
    : null;
  const sectorRankMap = topSectors
    ? Object.fromEntries(topSectors.map(s => [s.sector.toLowerCase(), s.rank]))
    : {};

  let totalRows = 0, filteredRows = 0;
  const consolidated = {};

  for (const { scanKey, data } of allScans) {
    for (const row of data) {
      const parsed = parseRow(row, scanKey);
      const ticker = parsed.ticker;

      if (parsed.close == null) continue;
      totalRows++;

      // Sector filter — exclude stocks whose sector is known but not in top set
      if (topSectorSet && parsed.sector) {
        if (!topSectorSet.has(parsed.sector.toLowerCase())) {
          filteredRows++;
          continue;
        }
      }

      if (!consolidated[ticker]) {
        consolidated[ticker] = {
          ...parsed,
          found_in: [],
          score: 0,
          sector_rank: parsed.sector ? (sectorRankMap[parsed.sector.toLowerCase()] ?? null) : null
        };
      } else {
        if (!consolidated[ticker].sector && parsed.sector) {
          consolidated[ticker].sector = parsed.sector;
          consolidated[ticker].sector_rank = sectorRankMap[parsed.sector.toLowerCase()] ?? null;
        }
      }

      consolidated[ticker].found_in.push(scanKey);
    }
  }

  if (topSectorSet && filteredRows > 0) {
    console.log(`  Sector filter: excluded ${filteredRows} of ${totalRows + filteredRows} stocks not in top ${TOP_SECTORS_COUNT} sectors`);
  }

  for (const ticker in consolidated) {
    consolidated[ticker].score = scoreConfluence(consolidated[ticker]);
  }

  return consolidated;
}

/**
 * Calculate trade metrics — fixed -3% stop, +7% target.
 *
 * Verdict rules:
 *   Score ≥ 11 + catalyst        → TRADE
 *   Score ≥ 9  + MACD bullish    → TRADE
 *   Score ≥ 8                    → WATCH
 *   Score < 8 OR hard-exclude    → SKIP
 *
 * Hard-exclude: MACD bearish + price below SMA200
 *   (exception: oversold scan with catalyst — still eligible for WATCH)
 */
function calculateTradeMetrics(stock) {
  const entry = stock.close;
  const stop  = entry * 0.97;   // -3%
  const t1    = entry * 1.07;   // +7%

  const aboveSMA200 = stock.close != null && stock.sma200 != null && stock.close > stock.sma200;
  const macdBullish = stock.macd != null && stock.macd_signal != null && stock.macd > stock.macd_signal;
  const hasCatalyst = (stock.catalysts || []).length > 0;
  const isOversold  = stock.found_in?.includes('oversold');

  const hardExclude = !macdBullish && !aboveSMA200 && !(isOversold && hasCatalyst);

  let verdict = 'SKIP';
  if (!hardExclude) {
    if (stock.score >= 11 && hasCatalyst) verdict = 'TRADE';
    else if (stock.score >= 9 && macdBullish) verdict = 'TRADE';
    else if (stock.score >= 8) verdict = 'WATCH';
  }

  const macdStatus = macdBullish ? 'BULLISH' : 'BEARISH';
  return { entry, stop, t1, verdict, macdStatus };
}

/**
 * Format stock output line.
 * Layout: Symbol | Score | Price | Stop(-3%) | T1(+7%) | RSI | MACD | Vol× | Week% | MCap | Catalyst | Verdict
 */
function formatStockLine(ticker, stock, metrics) {
  const n  = (val, d = 1) => val != null ? parseFloat(val).toFixed(d) : 'N/A';
  const cap = (val) => val != null ? `$${(val / 1e9).toFixed(1)}B` : 'N/A';

  const adrTag    = (stock.flags || []).includes('ADR') ? ' [ADR]' : '';
  const extraFlags = (stock.flags || []).filter(f => f !== 'ADR').join(' ');
  const catalysts  = (stock.catalysts || []).join(' ') || '-';
  const scans      = stock.found_in.join(', ');
  const sectorStr  = stock.sector
    ? ` | ${stock.sector}${stock.sector_rank != null ? ` #${stock.sector_rank}` : ''}`
    : '';

  return [
    `[${ticker}${adrTag}] — ${metrics.verdict} (${stock.score} pts) | ${scans}${extraFlags ? ' | ' + extraFlags : ''}${sectorStr}`,
    `  $${n(stock.close, 2)} | Stop $${n(metrics.stop, 2)}(-3%) | T1 $${n(metrics.t1, 2)}(+7%) | RSI ${n(stock.rsi)} | MACD ${metrics.macdStatus} | Vol× ${n(stock.rel_vol_10d, 2)} | Week ${n(stock.perf_w, 1)}% | ${cap(stock.market_cap)} | ${catalysts}`
  ].join('\n');
}

/**
 * Format and display results
 */
function displayResults(consolidated, sectorRankings) {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Display sector rankings header
  if (sectorRankings && sectorRankings.length > 0) {
    const top  = sectorRankings.slice(0, TOP_SECTORS_COUNT);
    const rest = sectorRankings.slice(TOP_SECTORS_COUNT);
    const pct  = (v) => v != null ? (v >= 0 ? '+' : '') + v.toFixed(1) + '%' : 'N/A';

    console.log('SECTOR RANKINGS (weekly ETF momentum):');
    top.forEach(s => {
      console.log(`  #${s.rank} ${s.sector.padEnd(25)} (${s.etf.padEnd(4)})  W ${pct(s.perf_w).padStart(7)}  M ${pct(s.perf_1m).padStart(7)}  RSI ${s.rsi != null ? s.rsi.toFixed(0) : 'N/A'} ← SELECTED`);
    });
    if (rest.length > 0) {
      console.log(`  Not selected: ${rest.map(s => `${s.sector} (${pct(s.perf_w)}W)`).join(', ')}`);
    }
    console.log('');
  }

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
async function saveResults(consolidated, categories, sectorRankings) {
  const timestamp = new Date().toISOString();

  const output = {
    timestamp,
    mode: USE_MOCK ? 'mock' : 'live',
    sector_rankings: sectorRankings || [],
    top_sectors: sectorRankings ? sectorRankings.slice(0, TOP_SECTORS_COUNT) : [],
    summary: {
      total_candidates: Object.keys(consolidated).length,
      multi_scan_hits: categories.multiScanHits.length,
      trade_candidates: categories.multiScanHits.filter(h => h.metrics.verdict === 'TRADE').length + categories.tradeList.length,
      watch_candidates: categories.multiScanHits.filter(h => h.metrics.verdict === 'WATCH').length + categories.watchList.length,
      top_sector_count: TOP_SECTORS_COUNT
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
        sector_rank: stock.sector_rank ?? null,
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
        catalysts: stock.catalysts || [],
        flags: stock.flags || [],
        is_adr: stock.type === 'dr',
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

async function uploadReport() {
  const { WORKER_URL, API_KEY } = UPLOAD_CONFIG;
  if (!WORKER_URL) return;

  const fs = require('fs');
  const htmlPath = require('path').join(__dirname, 'report.html');
  if (!fs.existsSync(htmlPath)) return;

  try {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const res = await fetch(`${WORKER_URL}/update-report`, {
      method:  'POST',
      headers: {
        'Content-Type':  'text/html',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: html,
    });
    if (res.ok) {
      console.log(`✓ Report uploaded → ${WORKER_URL}/report`);
    } else {
      console.warn(`⚠ Report upload failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`⚠ Report upload error: ${err.message}`);
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
    // Step 1: Rank sectors by ETF momentum
    console.log('Step 1/2: Ranking sectors by weekly ETF momentum...\n');
    const sectorRankings = await scanSectors();
    const topSectors = sectorRankings ? sectorRankings.slice(0, TOP_SECTORS_COUNT) : null;

    if (topSectors) {
      console.log(`  Focusing on: ${topSectors.map(s => `${s.sector} (${s.etf})`).join(', ')}\n`);
    }

    // Step 2: Run all 4 stock scans in parallel
    console.log('Step 2/2: Running stock scans...\n');
    const allScans = await Promise.all([
      runScan('breakout'),
      runScan('pullback'),
      runScan('oversold'),
      runScan('early_trend')
    ]);

    console.log('\n📈 Consolidating & scoring...\n');

    // Consolidate, filter to top sectors, and deduplicate
    const consolidated = consolidateResults(allScans, topSectors);

    // Display formatted results
    const categories = displayResults(consolidated, sectorRankings);

    // Save to JSON
    await saveResults(consolidated, categories, sectorRankings);

    // Upload to scanner-mcp Worker (if configured)
    const savedData = require('./scanner-results.json');
    await uploadResults(savedData);

    // Generate HTML report and upload it
    const { execFileSync } = require('child_process');
    execFileSync(process.execPath, [require('path').join(__dirname, 'generate-report.js')], { stdio: 'inherit' });
    await uploadReport();

  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

main();

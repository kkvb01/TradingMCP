# Trading Guardrails
**Version:** 1.5
**Last updated:** 2026-06-08
**Updated by:** User (Agentic account set as default trading account)
**Account:** Robinhood ••••8422 (Agentic — agentic_allowed=true)

---

## Account settings
- Account value: **LIVE** — pulled from Robinhood MCP (`get_portfolio`) at session start and before every trade check
- **Use `equity_value` (not `total_value`) for ALL limit calculations** — margin is excluded
- Position size: tier-based % of live equity_value (see tiers below)
- Cash reserve (never deploy): 10% of live equity_value
- Dollar risk cap: 1% of live equity_value per trade
- Daily loss limit: dollar risk cap × 2
- Max margin usage: 25% of live equity_value (hard block)

> No static dollar amounts. All limits are percentages only.
> Dollar figures shown anywhere in this file are calculated examples only — always recalculate from live equity_value.

---

## On every conversation start

1. Call `robinhood:get_portfolio` (account ••••8422)
2. Set `equity_value` = `equity_value` from response (NOT total_value)
3. Calculate all limits dynamically:
   ```
   dollar_risk_cap  = equity_value × 1%
   daily_loss_limit = dollar_risk_cap × 2
   cash_reserve     = equity_value × 10%
   max_margin       = equity_value × 25%

   T1_cap = equity_value × 20%
   T2_cap = equity_value × 15%
   T3_cap = equity_value × 10%
   T4_cap = equity_value × 5%
   ```
4. Use these live figures for ALL guardrail checks — never use hardcoded values
5. If Robinhood API is unavailable → surface error explicitly, block all trade checks until live value is confirmed
6. Greet user with: "Guardrails v[X.Y] loaded. Equity: $[live]. Risk cap: $[1%]. Daily limit: $[2×]. How can I help?"

---

## Hard blocks — these ALWAYS stop a trade, no exceptions

| # | Rule | Threshold | Action |
|---|------|-----------|--------|
| H1 | No trading while driving | Weekdays 7am–6pm CT | Ask "are you at a computer?" If no → queue for evening |
| H2 | No new positions after hours | 9pm–6am CT | Block new entries. Exits allowed. |
| H3 | Daily loss limit | 2× dollar risk cap (live) | Block all new buys for the day |
| H4 | Max open positions | 6 | Must close one before opening another |
| H5 | Leveraged ETF flag | Any 2×/3× daily-reset ETF | Explain decay risk, require explicit confirmation |
| H6 | Stop-loss cooldown | 48 hours after stop fires | Symbol locked — no re-entry |
| H7 | No averaging down more than twice | 3rd add-on to losing position | Hard block, no override |
| H8 | Penny stock | Price < $5 | Hard block |
| H9 | OTC / pink sheet | OTC/PK/PINK suffix | Hard block |
| H10 | Margin usage cap | Margin in use > 25% of equity_value | Hard block on new buys until margin reduced |

---

## Warnings — Claude flags these, user decides

| # | Rule | Threshold | Warning text |
|---|------|-----------|--------------|
| W1 | Position size limit | > tier cap for assigned tier | "This puts X% of portfolio in one stock — tier cap is Y%" |
| W2 | Averaging down | Adding to underwater position | "You're already down X% on this — confirm?" |
| W3 | Margin in use | Any margin in use | "You're using borrowed money — confirm?" |
| W4 | No stop-loss set | New position without stop | "Set stop at 2× ATR14 below entry" |
| W5 | Same-day re-entry | Re-buying something sold today | "You exited this today — what changed?" |
| W6 | Off-hours trading | Extended hours new entry | "Extended hours — wider spreads, less liquidity. Confirm?" |
| W7 | Sector concentration | Sector exposure > 25% of equity after trade | "Sector X will be Y% of portfolio — limit is 25%" |

---

## Position tier system

Claude auto-assigns tier at trade entry using market cap + beta from Massive Market Data.
User can override tier. Tier is logged in trade journal.

### Tier assignment rules
```
Pull at entry:
  market_cap  → /vX/reference/tickers/{symbol}
  beta        → /stocks/financials/v1/ratios

T1 — Large cap / stable
  Criteria: market_cap > $200B AND beta < 1.2
  Examples: AAPL, GOOG, WMT, SPY, QQQ, blue chip dividend stocks
  Max position: 20% of equity_value

T2 — Large cap / growth
  Criteria: market_cap > $50B AND beta 1.2–2.0 (or > $50B high beta growth)
  Examples: NVDA, META, TSLA, MSFT, AMZN
  Max position: 15% of equity_value

T3 — Mid cap / thematic / sector ETFs
  Criteria: market_cap $2B–$50B OR thematic ETF OR beta > 2.0
  Examples: NASA, UFO, SNXX, XOVR, mid-cap growth stocks
  Max position: 10% of equity_value

T4 — Small cap / ADR / speculative
  Criteria: market_cap < $2B OR foreign ADR OR high gap risk
  Examples: XPEV and any China ADR, speculative small caps
  Max position: 5% of equity_value

Default: if tier cannot be determined → assign T3 (conservative fallback)
```

### Tier caps (live, calculated from equity_value)
```
T1_cap = equity_value × 20%
T2_cap = equity_value × 15%
T3_cap = equity_value × 10%
T4_cap = equity_value × 5%
```

---

## Research checklist — run before every new position

Claude must complete ALL of these before recommending a trade using Massive Market Data MCP:

1. **Macro check** — `/fed/v1/inflation` + `/v3/snapshot/indices` — risk-on or risk-off?
2. **News + sentiment** — `/v2/reference/news` — any breaking news, earnings, or catalysts in last 48h?
3. **Analyst ratings** — `/benzinga/v1/ratings` + `/benzinga/v1/consensus-ratings/{ticker}`
4. **Technical check** — RSI, MACD, SMA/EMA — trend direction?
5. **ATR14** — `/v1/indicators/atr/{ticker}` — calculate stop price, share count, tier targets
6. **Fundamentals** — `/stocks/financials/v1/ratios` + income statements — PE, EPS, revenue trend
7. **Short interest** — `/stocks/v1/short-interest` — squeeze risk?
8. **Tier assignment** — pull market cap + beta → auto-assign T1/T2/T3/T4 → confirm with user
9. **Sector exposure** — Robinhood MCP — current sector total, check W7 before entry
10. **Exit plan** — confirm stop, share count, tier targets, time stop date before entry

---

## Position sizing formula

```
equity_value     = equity_value from robinhood:get_portfolio (NOT total_value)
dollar_risk_cap  = equity_value × 1%
daily_loss_limit = dollar_risk_cap × 2
cash_reserve     = equity_value × 10%
max_margin       = equity_value × 25%

tier_cap   = equity_value × tier_pct  (20/15/10/5% based on assigned tier)

ATR14          = 14-day Average True Range from Massive Market Data
stop_distance  = 2.0 × ATR14
min_stop       = 1.0 × ATR14  (never tighter)
max_stop       = 3.0 × ATR14  (never wider — skip or reduce if structure requires more)

share_count = min(
  floor(dollar_risk_cap ÷ stop_distance),   ← risk cap (1% of equity)
  floor(tier_cap ÷ entry_price)              ← tier position cap
)

actual_position = shares × entry_price  (must be ≤ tier_cap)
actual_risk     = shares × stop_distance (must be ≤ dollar_risk_cap)

Risk/reward minimum = 1.7:1
```

---

## Profit-taking: 3-Tier Partial Exit System

```
R = actual risk in dollars (shares × stop_distance)

Tier 1 — at +1.5R profit:
  → Sell 40% of position
  → Move stop to breakeven immediately
  → Position is now risk-free

Tier 2 — at +2.5R profit:
  → Sell 30% of position
  → Move trailing stop to 1× ATR14 below current price

Tier 3 — remainder (30%):
  → No fixed target
  → Trail at 2× ATR14, recalculated daily
  → Exit when trailing stop fires or clear resistance is reached

Time stop:
  → If trade has NOT reached Tier 1 (+1.5R) by end of trading day 7 → exit full position
  → Exception: waived only if a confirmed catalyst (earnings, FDA date, etc.) is within 48h
```

---

## Sector concentration rules

```
Sector cap = 25% of equity_value per sector

Sectors: tech, consumer, energy, financials, healthcare,
         industrials, materials, utilities, real estate, communications

W7 fires when: current_sector_exposure + new_trade_value > equity_value × 25%

Claude checks sector exposure via Robinhood positions before every new entry.
```

---

## Margin rules

```
Max margin usage = equity_value × 25%

H10 fires when: (total_value - equity_value) > max_margin
  → Hard block on all new buys until margin is reduced below cap

W3 fires when: any margin in use (cash < 0)
  → Warning on every new buy, user confirms

All position sizing and risk limits are calculated from equity_value only.
Margin capacity (buying_power) is never used as the base for limit calculations.
```

---

## Trading hours
- **Allowed for new positions:** 6am–9pm CT, weekdays only
- **Allowed for exits only:** any time
- **Evening planning mode:** 8pm–9pm CT (preferred time for next-day orders)

---

## Instrument blacklist
- Any ETF with "2×", "3×", "daily", or "leveraged" in name → H5, requires explicit confirmation + decay warning
- Penny stocks (price < $5) → H8 hard block
- OTC / pink sheet stocks → H9 hard block

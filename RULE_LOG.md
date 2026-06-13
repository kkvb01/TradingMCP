# Rule change log

All proposed, approved, and rejected rule changes are recorded here.  
Claude writes to this file only after explicit user approval.

---

## Format

```
## [DATE] [STATUS] Rule change
**Proposed by:** User / Claude
**Rule affected:** H1 / W3 / new rule / tool update
**Change:** What was proposed
**Validation result:** Conflicts found / no conflicts / math check
**Decision:** Approved / Rejected / Modified
**Reason:** Why approved or rejected
**New GUARDRAILS.md version:** X.Y
```

---

## Log entries

### 2026-06-05 — APPROVED — Initial rulebook created
**Proposed by:** User (with Claude assistance)  
**Change:** Full guardrail system created from trading history analysis  
**Validation result:** No conflicts — first version  
**Decision:** Approved  
**Reason:** Initial setup based on 3-week trade history analysis  
**GUARDRAILS.md version:** 1.0

---

### 2026-06-06 — APPROVED — Updated data source from Alpha Vantage to Massive Market Data
**Proposed by:** User  
**Rule affected:** Research checklist (tool references)  
**Change:** Replaced Alpha Vantage MCP references with Massive Market Data MCP (Polygon.io). Updated all research checklist steps with exact API endpoints. Added new research steps for analyst ratings (`/benzinga/v1/ratings`), short interest (`/stocks/v1/short-interest`), corporate guidance (`/benzinga/v1/guidance`), and macro data (`/fed/v1/inflation`). Removed Nasdaq Data Link as redundant — Massive Market Data covers macro natively.  
**Validation result:** No conflicts. Massive Market Data is a superset of Alpha Vantage capabilities. Math unchanged.  
**Decision:** Approved  
**Reason:** User already has Polygon.io/Massive Market Data account. Simpler stack, more capable.  
**GUARDRAILS.md version:** 1.1

---

### 2026-06-07 — APPROVED — ATR-based dynamic stops + 3-Tier profit taking system
**Proposed by:** Claude (at user request)  
**Rule affected:** Position sizing formula (replacement) + new Profit-taking section + Research checklist (addition)  
**Change:**  
1. Replaced fixed 7% stop-loss with ATR14-based dynamic stop (2.0× ATR14 default, min 1.0×, max 3.0×). Position size is now dynamically calculated: shares = min(floor($389 ÷ stop distance), floor($5,550 ÷ entry price)). Dollar risk cap of $389 remains as hard ceiling.  
2. Added 3-Tier Partial Exit System: Tier 1 at +1.5R (sell 40%, move stop to breakeven), Tier 2 at +2.5R (sell 30%, trail at 1× ATR), Tier 3 remainder trails at 2× ATR14 daily with no fixed target.  
3. Added Time Stop: exit full position if Tier 1 not reached by end of day 7. Exception: waived if confirmed catalyst within 48h.  
4. Added ATR14 pull (step 5) to research checklist. Checklist expanded from 9 to 10 steps.  
**Validation result:** No conflicts with H1–H7 or W1–W6. Math check passed — dollar risk preserved at $389 cap. Position size cap added to formula to prevent low-ATR stocks from exceeding $5,550 limit (W1 catches this but cap is now built into formula). R/R improves from 1.7R minimum to 1.95R minimum expected value per winner. Sanity check passed.  
**Decision:** Approved  
**Reason:** ATR-based stops adapt to each stock's actual volatility, preventing noise-triggered stops on high-volatility names and oversized stops on low-volatility names. 3-Tier exit system locks in profit early while keeping upside on runners. Time stop frees capital from stalled trades. All changes are strictly additive to profitability.  
**GUARDRAILS.md version:** 1.2

---

*Future entries will be added here as rules are proposed and approved.*

---

### 2026-06-07 — APPROVED — Live account value replaces hardcoded dollar amounts
**Proposed by:** User  
**Rule affected:** Account settings, Position sizing formula, Hard blocks (H3, W1), Session start behavior  
**Change:** Removed all hardcoded dollar amounts from GUARDRAILS.md. Account value is now pulled live from Robinhood MCP (`robinhood:get_portfolio`) at every session start and before every trade check. All limits (position size, dollar risk cap, daily loss limit, cash reserve) are calculated dynamically from live total_value. Added explicit session start procedure with API unavailability handling — if Robinhood API is down, all trade checks are blocked until live value is confirmed. H3 and W1 thresholds updated to reference live percentages instead of fixed dollar amounts.  
**Validation result:** No conflicts with any existing rule. Math structure identical — percentages unchanged, applied to live value instead of hardcoded figure. Sanity check passed. Edge case noted and handled: API unavailable → block trade checks.  
**Decision:** Approved  
**Reason:** Hardcoded account value drifts over time and causes incorrect limit calculations. Live pull ensures guardrails always reflect real account state.  
**GUARDRAILS.md version:** 1.3

---

### 2026-06-07 — APPROVED — Tier-based position sizing + margin-aware limits + sector cap
**Proposed by:** User (with Claude recommendation)
**Rule affected:** W1 (position size), Position sizing formula, new H10 (margin cap), new W7 (sector cap), account value base
**Change:**
1. Replaced flat 15% position size with 4-tier system: T1 large cap stable (20%), T2 large cap growth (15%), T3 mid cap/thematic (10%), T4 small cap/ADR/speculative (5%). Claude auto-assigns tier at entry using market cap + beta from Massive Market Data. User can override.
2. All limits now calculated from `equity_value` (not `total_value`) — margin excluded from base. Protects against limits inflating on borrowed money.
3. Dollar risk cap simplified from `equity × 15% × 7%` to `equity × 1%` — identical math, cleaner expression. ($371 vs $404 on current account — 4.7% more conservative.)
4. Added H10: hard block when margin usage exceeds 25% of equity_value. Prevents runaway borrowing.
5. Added W7: sector concentration cap at 25% of equity_value per sector. Claude checks before every new entry.
6. Research checklist updated: step 8 now includes tier auto-assignment, step 9 now includes sector exposure check.
7. Guardrail engine and trade analyzer updated to accept stock_tier, sector, sector_exposure params.
**Validation result:** No conflicts with H1–H9 or W1–W6. Math check passed. Dollar risk cap nearly identical ($371 vs $404). Existing violations noted: AAPL (32% of equity, T1 cap 20%) and NVDA (25% of equity, T2 cap 15%) both over tier caps. Tech sector at 64% of equity — W7 fires immediately on current portfolio. Both noted but not force-closed — user manages timing.
**Decision:** Approved
**Reason:** One-size-fits-all position sizing is inappropriate across different stock volatility profiles. Tier system correctly allows larger positions in stable large caps while capping risk on speculative names. Equity-based limits prevent margin from distorting risk calculations. Sector cap adds professional-grade concentration control.
**GUARDRAILS.md version:** 1.4

---

### 2026-06-08 — APPROVED — Default trading account changed to Agentic account
**Proposed by:** User
**Rule affected:** Account settings, Session start procedure
**Change:** Default trading account updated from ••••7904 (main margin account, agentic_allowed=false) to ••••8422 (Agentic cash account, agentic_allowed=true). All guardrail checks, portfolio pulls, and order placement now reference ••••8422. Main account ••••7904 remains for reference only — Claude cannot place orders there. Agentic account is a cash account — no margin, H10 margin cap is effectively N/A but W3 retained for awareness. Current equity in Agentic account: $20,333.
**Validation result:** No conflicts. Account number update is cosmetic to rules — all percentage-based math unchanged. Cash account means margin rules (H10) won't fire but are harmless to keep. H4 note: 7 positions currently in Agentic account — already over the 6-position limit.
**Decision:** Approved
**Reason:** Claude can only place orders in agentic_allowed=true accounts. Updating default to correct account is required for order placement to work.
**GUARDRAILS.md version:** 1.5

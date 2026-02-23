# Tasks — DeFindex Distribution

## Milestone 0: Setup and Documentation
- [x] Create `refactor_plan.md` — 2026-02-23 — done
- [x] Create `TASKS.md` — 2026-02-23 — done
- [x] Create backup `src/index.backup.ts` — 2026-02-23 — done

**Verify:** Files exist, project compiles as before

## Milestone 1: Refactor — Extract shared utilities
- [ ] Create `src/utils.ts` with extracted types, functions, constants
- [ ] Refactor `src/index.ts` to import from `utils.ts`

**Verify:** `pnpm transfer <csv>` works identically to before

## Milestone 2: Analyze script (`src/analyze.ts`)
- [ ] Implement CSV parser for lost funds format
- [ ] Group by vault, count users, sum losses
- [ ] Show summary table in console
- [ ] Generate `analysis_<timestamp>.json`
- [ ] Add `analyze` script to `package.json`

**Verify:** `pnpm analyze "./DeFindex Lost Funds - per_user_per_vault.csv"` produces JSON with 12 vaults, ~920 records

## Milestone 3: Deposit script (`src/deposit.ts`)
- [ ] Read analysis JSON
- [ ] For each vault: verify balance, deposit, capture minted dfTokens
- [ ] Calculate proportional distribution: `dfTokens_user = (delta_user / total_vault) * dfTokens_minted`
- [ ] Generate `deposit_log_<ts>.csv`
- [ ] Generate `distribution_<ts>.csv`
- [ ] Add `deposit` script to `package.json`

**Verify:** `pnpm deposit <analysis.json>` deposits correctly, CSV sums match

## Milestone 4: Distribute script (`src/distribute.ts`)
- [ ] Read distribution CSV
- [ ] Group by vault, verify balances
- [ ] Batch transfers (10) via router contract
- [ ] Show statistics table
- [ ] Generate `distributor_<ts>_log.csv`
- [ ] Add `distribute` script to `package.json`

**Verify:** `pnpm distribute <distribution.csv>` transfers correctly, log complete

## Milestone 5: Final documentation
- [ ] Rewrite `plan.md` with final flow
- [ ] Mark all tasks done in `TASKS.md`

**Verify:** `plan.md` reflects current state

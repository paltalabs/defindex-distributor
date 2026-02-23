# Tasks — DeFindex Distribution

## Milestone 0: Setup and Documentation

- [x] Create `refactor_plan.md` — 2026-02-23 — done
- [x] Create `TASKS.md` — 2026-02-23 — done
- [x] Create backup `src/index.backup.ts` — 2026-02-23 — done

**Verify:** Files exist, project compiles as before

## Milestone 1: Refactor — Extract shared utilities

- [x] Create `src/utils.ts` with extracted types, functions, constants — 2026-02-23 — done
- [x] Refactor `src/index.ts` to import from `utils.ts` — 2026-02-23 — done

**Verify:** `pnpm transfer <csv>` works identically to before — `npx tsc --noEmit` passes

## Milestone 2: Analyze script (`src/analyze.ts`)

- [x] Implement CSV parser for lost funds format (handles quoted fields) — 2026-02-23 — done
- [x] Group by vault, count users, sum losses — 2026-02-23 — done
- [x] Show summary table in console — 2026-02-23 — done
- [x] Generate `analysis_<timestamp>.json` — 2026-02-23 — done
- [x] Add `analyze` script to `package.json` — 2026-02-23 — done

**Verify:** `pnpm analyze "./DeFindex Lost Funds - per_user_per_vault.csv"` produces JSON with 12 vaults, ~920 records

## Milestone 3: Deposit script (`src/deposit.ts`)

- [x] Read analysis JSON — 2026-02-23 — done
- [x] For each vault: verify balance, deposit, capture minted dfTokens — 2026-02-23 — done
- [x] Calculate proportional distribution: `dfTokens_user = (delta_user / total_vault) * dfTokens_minted` — 2026-02-23 — done
- [x] Generate `deposit_log_<ts>.csv` — 2026-02-23 — done
- [x] Generate `distribution_<ts>.csv` — 2026-02-23 — done
- [x] Add `deposit` script to `package.json` — 2026-02-23 — done

**Verify:** `pnpm deposit <analysis.json>` deposits correctly, CSV sums match

## Milestone 4: Distribute script (`src/distribute.ts`)

- [x] Read distribution CSV — 2026-02-23 — done
- [x] Group by vault, verify balances — 2026-02-23 — done
- [x] Batch transfers (10) via router contract — 2026-02-23 — done
- [x] Show statistics table — 2026-02-23 — done
- [x] Generate `distributor_<ts>_log.csv` — 2026-02-23 — done
- [x] Add `distribute` script to `package.json` — 2026-02-23 — done

**Verify:** `pnpm distribute <distribution.csv>` transfers correctly, log complete

## Milestone 5: Final documentation

- [x] Rewrite `plan.md` with final flow — 2026-02-23 — done
- [x] Mark all tasks done in `TASKS.md` — 2026-02-23 — done
- [x] update Readme.md explaining the whole repo

**Verify:** `plan.md` reflects current state
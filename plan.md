# DeFindex Lost Funds Distribution — Final Flow

## Overview

Complete pipeline to restore funds to ~920 users across 12 DeFindex vaults affected by the hack.

## Prerequisites

1. Obtain the lost funds CSV (`DeFindex Lost Funds - per_user_per_vault.csv`)
2. Swap assets manually to each vault's underlying token
3. Set environment variables: `STELLAR_SECRET_KEY`, `SOROBAN_RPC`, `HORIZON_RPC`

## Step 1: Analyze

```bash
pnpm analyze "./DeFindex Lost Funds - per_user_per_vault.csv"
```

- Parses the CSV (handles quoted fields with commas)
- Groups records by `vault_id`
- Uses `underlying_delta` (absolute value) as the loss amount in stroops
- Displays a summary table (vault, user count, total loss)
- Outputs `analysis_<timestamp>.json`

## Step 2: Deposit

```bash
pnpm deposit <analysis_timestamp.json>
```

For each of the 12 vaults:
1. Queries `get_assets()` to identify the underlying token
2. Checks source account balance of the underlying asset
3. Calls `deposit()` with the total loss amount for that vault
4. Reads dfToken balance before/after to determine `dfTokens_minted`
5. Calculates proportional distribution: `dfTokens_user = (user_delta * dfTokens_minted) / total_vault_loss`

Outputs:
- `deposit_log_<ts>.csv` — vault, amount deposited, dfTokens minted, txHash, timestamp
- `distribution_<ts>.csv` — vault, user, underlying lost, dfTokens to receive

## Step 3: Distribute

```bash
pnpm distribute <distribution_timestamp.csv>
```

1. Parses the distribution CSV
2. Verifies dfToken balances per vault
3. Batches transfers (10 per transaction) via the Stellar Router contract
4. Continues on failure (logs failed batches, proceeds with remaining)
5. Displays per-vault statistics

Outputs:
- `distributor_<ts>_log.csv` — vault, user, amount, txHash, batch, timestamp, status

## Project Structure

```
src/
├── utils.ts          # Shared types, constants, Stellar/router utilities
├── analyze.ts        # Step 1: CSV analysis
├── deposit.ts        # Step 2: Vault deposits
├── distribute.ts     # Step 3: dfToken distribution
├── index.ts          # Legacy single-vault transfer (backward compat)
├── index.backup.ts   # Pre-refactor backup
├── send.ts           # XLM send utility
├── mergeAccountMnemonic.ts
└── mergeAccountSecret.ts
```

## Scripts

| Command | Description |
|---|---|
| `pnpm analyze <csv>` | Analyze lost funds CSV |
| `pnpm deposit <json>` | Deposit into vaults |
| `pnpm distribute <csv>` | Distribute dfTokens |
| `pnpm transfer <csv>` | Legacy single-vault transfer |
| `pnpm send <amount> <dest>` | Send XLM |

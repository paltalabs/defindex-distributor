# DeFindex Distributor

CLI toolkit for managing DeFindex vault distributions. Includes a complete pipeline: **analyze losses, deposit into vaults, and distribute dfTokens** to users. Supports both **mainnet** and **testnet**.

## Setup

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Copy and configure environment variables:
   ```bash
   cp .env.example .env
   ```

   Key variables:
   ```
   STELLAR_NETWORK=testnet          # "testnet" or "public" (default: public)
   SOROBAN_RPC=https://soroban-testnet.stellar.org
   HORIZON_RPC=https://horizon-testnet.stellar.org
   STELLAR_SECRET_KEY=S...          # Account holding funds for deposits/transfers
   ROUTER_CONTRACT=CAG5...          # Optional, defaults to mainnet router
   ```

## Testnet Demo Flow

End-to-end demo that deploys vaults, creates test users, and runs the full distribution pipeline on testnet.

### 1. Deploy vaults and generate test data

```bash
STELLAR_NETWORK=testnet pnpm demo
```

- Deploys 3 vaults (alternating XTAR/USDC) via the DeFindex factory
- Creates 10 users per vault, funded via friendbot
- Mints USDC/XTAR for the manager and users via [Soroswap faucet](https://api.soroswap.finance/api/faucet)
- Generates a CSV with simulated loss data

**Output:** `output/demo/demo_testnet_<timestamp>.csv`

### 2. Analyze the demo CSV

```bash
pnpm analyze output/demo/demo_testnet_<timestamp>.csv
```

- Auto-detects the CSV format (demo or lost funds)
- Groups records by vault and computes total loss per vault

**Output:** `output/analysis/analysis_<timestamp>.json`

### 3. Mint tokens to cover deposits

```bash
STELLAR_NETWORK=testnet pnpm mint output/demo/demo_testnet_<timestamp>.csv
```

- Accepts either a demo CSV (reads asset column directly) or an analysis JSON
- Checks current balances per asset, calculates deficit
- Calls the Soroswap faucet repeatedly (2,500 tokens per call) until covered

### 4. Deposit into vaults

```bash
STELLAR_NETWORK=testnet pnpm deposit output/analysis/analysis_<timestamp>.json
```

- For each vault: deposits the total loss amount and measures minted dfTokens
- Calculates proportional per-user dfToken allocation

**Outputs:**
- `output/deposits/deposit_log_<ts>.csv`
- `output/deposits/distribution_<ts>.csv`

### 5. Distribute dfTokens to users

```bash
STELLAR_NETWORK=testnet pnpm distribute output/deposits/distribution_<ts>.csv
```

- Batch-transfers dfTokens to all users (10 per transaction)
- Continues on batch failure, logs results

**Output:** `output/distributions/distributor_<ts>_log.csv`

## Mainnet Distribution Pipeline

For restoring funds to affected DeFindex vault users after the hack.

### Step 1: Analyze

```bash
pnpm analyze "DeFindex Lost Funds - per_user_per_vault.csv"
```

**Input CSV columns:** `vault_id`, `user_address`, `df_tokens`, `pps_before`, `pps_after`, `underlying_before`, `underlying_after`, `underlying_amount`, `Amount`

### Step 2: Deposit

```bash
pnpm deposit output/analysis/analysis_<timestamp>.json
```

For each vault:
1. Queries `get_assets()` to identify the underlying token
2. Verifies the source account has sufficient balance
3. Executes `deposit()` with the total loss amount
4. Measures dfTokens minted (balance diff before/after)
5. Calculates per-user allocation: `dfTokens_user = (user_loss * dfTokens_minted) / total_vault_loss`

### Step 3: Distribute

```bash
pnpm distribute output/deposits/distribution_<ts>.csv
```

- Verifies dfToken balances per vault before starting
- Batches 10 transfers per transaction
- Continues on batch failure, shows per-vault statistics at the end

## Other Scripts

| Command | Description |
|---------|-------------|
| `pnpm transfer <csv>` | Legacy single-vault dfToken transfer (CSV: `address,amount`) |
| `pnpm send <amount> <dest>` | Send XLM to a destination address |
| `pnpm merge:secret` | Merge account via `MERGE_SECRET` env var |
| `pnpm merge:mnemonic` | Merge account via `MNEMONIC` env var (BIP39) |

## Project Structure

```
src/
├── utils.ts                # Shared types, network config, Stellar/router utilities
├── analyze.ts              # CSV analysis (supports demo + lost funds formats)
├── deposit.ts              # Vault deposits + distribution calculation
├── distribute.ts           # Batch dfToken transfers
├── demo.ts                 # Testnet demo: deploy vaults, create users, generate CSV
├── mint.ts                 # Testnet token minter via Soroswap faucet
├── index.ts                # Legacy single-vault transfer
├── send.ts                 # XLM send utility
├── mergeAccountMnemonic.ts
└── mergeAccountSecret.ts

output/                     # All script outputs (gitignored)
├── demo/                   # demo_testnet_*.csv
├── analysis/               # analysis_*.json
├── deposits/               # deposit_log_*.csv, distribution_*.csv
└── distributions/          # distributor_*_log.csv
```

## All Scripts

| Command | Description |
|---------|-------------|
| `pnpm demo` | Deploy testnet vaults, create users, generate demo CSV |
| `pnpm mint <csv\|json>` | Mint testnet tokens via Soroswap faucet |
| `pnpm analyze <csv>` | Analyze lost funds / demo CSV |
| `pnpm deposit <json>` | Deposit into vaults, generate distribution CSV |
| `pnpm distribute <csv>` | Batch-transfer dfTokens to users |
| `pnpm transfer <csv>` | Legacy single-vault transfer |
| `pnpm send <amount> <dest>` | Send XLM |
| `pnpm merge:secret` | Merge account via secret key |
| `pnpm merge:mnemonic` | Merge account via mnemonic |

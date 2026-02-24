# DeFindex Distributor

CLI toolkit for managing value distributions across DeFindex Vaults . Includes a complete pipeline: **deposit total assets into vaults and distribute dfTokens (DeFindex Vault Tokens)** to users. Supports both **mainnet** and **testnet**.


## Deploy defindex-distributor contract
```
make test
make build
stellar keys generate alice --network testnet --fund
stellar contract deploy \
  --wasm target/wasm32v1-none/release/defindex_distributor.wasm \
  --source-account alice \
  --network testnet \
  --alias defindex-distributor
```
Contract ID will be in `~/.config/stellar/contract-ids/defindex-distributor.json`

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
   Note: Here, the `ROUTER_CONTRACT` is a contract that allows multiple Soroban calls in one. See https://github.com/Creit-Tech/Stellar-Router-Contract 

   TODO: ROUTER ADDRESSES SHOULD BE:
   ROUTER_CONTRACT_TESTNET=CBKHVXEU65QYABUIV7N2YP3W6XD6ZGBYKHT3IIXJKB7IEF45INS3765H
   ROUTER_CONTRACT_MAINNET=(COMPLETE)


## Distribution Pipeline

To distribute funds to users through DeFindex Vaults.

### Step 1: Analyze

```bash
pnpm analyze "defindex_funds_to_distribute.csv"
```

**Input CSV columns:** `asset`, `vault`, `user`, `amount`
Note: Amounts should be in the vault underlying asset (asset), and in the minimum asset unit (like stroops for XLM)

Example:
```csv
asset,vault,user,amount
CCZGLAUBDKJSQK72QOZHVU7CUWKW45OZWYWCLL27AEK74U2OIBK6LXF2,CDHZFQZWSU7GSHUBWFEL2FJ7R2RNVHI3RPY5QMCQ3MGJXOSHSTSW5PE7,GCGI4UWY3JDN2NH4L33Y7GHOGFTV3WTGAPPCQONZJOPOL5BSSCVS6UQI,7952002150
CCZGLAUBDKJSQK72QOZHVU7CUWKW45OZWYWCLL27AEK74U2OIBK6LXF2,CDHZFQZWSU7GSHUBWFEL2FJ7R2RNVHI3RPY5QMCQ3MGJXOSHSTSW5PE7,GCUJW46S35TBIOS2R42LLK4W3O2HRHMQBXGLNSTVTUYCZWN5BML3H7XI,4303465857
CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F,CD237PTITFIAS752WB3D4DFQY3FVLCGHBZMVQN7LNOYNZME7TVZLG52N,GBE467YLF5SHGJ4ANZSHSVBOE5E5HWKZGFNVSVHEI26UAH6YCBTOCE6S,7467554674
CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F,CD237PTITFIAS752WB3D4DFQY3FVLCGHBZMVQN7LNOYNZME7TVZLG52N,GAQQS2PKUUURN4BYCZ5CVYMCSY47UXZEAYJXWOWHOSRHHN7H5B5KTI7T,4925972025
CCZGLAUBDKJSQK72QOZHVU7CUWKW45OZWYWCLL27AEK74U2OIBK6LXF2,CD3UK4W7LFIFLTTTNZEEMGPJNQRZZGA4SHCAWJEXFRFO65EC6NRLOYBA,GD2MH7N2A7NSW7SMKVYEKN5SFOTLER7MXNXCCRYP6RJIUSHIV4BKCJER,9712903229
CCZGLAUBDKJSQK72QOZHVU7CUWKW45OZWYWCLL27AEK74U2OIBK6LXF2,CD3UK4W7LFIFLTTTNZEEMGPJNQRZZGA4SHCAWJEXFRFO65EC6NRLOYBA,GDYAQ7CAIKDHAXLBWXP7TGIPPR3NE3JMPWASTYFXO7MXKOUOKFD2PEEX,5982203100
```

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


## Testnet Demo Flow

End-to-end demo that deploys vaults, creates test users, and runs the full distribution pipeline on testnet.

### 1. Deploy vaults and generate test data

```bash
STELLAR_NETWORK=testnet pnpm demo
```
TODO:
Step 3: Creating 10 users per vault...
  Vault CCZN6MFG... (XTAR):
    Funded 5/10 users (+ XTAR minted)
    Funded 10/10 users (+ XTAR minted)
Here users just need to be funded by Friendbot. XTAR doesnt need to be minted

- Deploys 3 vaults (alternating XTAR/USDC) via the DeFindex Factory
- Creates 10 users per vault, funded via friendbot
- Mints USDC/XTAR for the manager and users via [Soroswap faucet](https://api.soroswap.finance/api/faucet)
- Generates a CSV with simulated loss data

**Output:** `output/demo/demo_testnet_<timestamp>.csv`
TODO: script should say CSV written to: output/demo/demo_testnet_2026-02-24T12-34-48-153Z.csv

### 2. Analyze the demo CSV and generate JSON

```bash
pnpm analyze output/demo/demo_testnet_<timestamp>.csv
```

- Auto-detects the CSV format 
- Groups records by vault and computes total amounts to be distributed per vault

**Output:** `output/analysis/analysis_<timestamp>.json`

### 3. Optional: Mint test tokens to cover deposits
TODO: Explain why this step

```bash
STELLAR_NETWORK=testnet pnpm mint output/demo/demo_testnet_<timestamp>.csv
```

- Accepts either a demo CSV (reads asset column directly) or an analysis JSON
- Checks current balances per asset, calculates deficit
- Calls the Soroswap faucet repeatedly (2,500 tokens per call) until covered

### 4. Deposit funds into vaults
TODO: Users: 10 | Total Loss: 59759095866 stroops
dont talk about loss!

```bash
STELLAR_NETWORK=testnet pnpm deposit output/analysis/analysis_<timestamp>.json
```

- For each vault: deposits the total  amount and gets minted dfTokens
- Calculates proportional per-user dfToken allocation

TODO: Explain   Distribution sum: 59759094861 | Remainder (dust): 5

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

TODO: For all users Check underlying asset before and underlying asset after the distribution


for each batch:

Batch 1/3 (10 transfers to vault CBMH54RDM74BOIFJPTZ5MOLCBJSOWTRDR4KCCZDAQSGQZODLOEWPEXLD):

user, df_tokens_now, underlying_asset_now, underlying_asset_to_distribute, df_tokens_to_distribute

...
Sending transaction
  Transaction submitted: c892fc3304aafb5d3c94aa445174c0186ed94f1277f66e98fc7824c91b489a92
  Waiting for confirmation...
  Batch 1 completed: c892fc3304aafb5d3c94aa445174c0186ed94f1277f66e98fc7824c91b489a92

  Batch 1 result:
  user, df_tokens_to_distributed, df_tokens_new, underlying_asset_new
  (This underlying_asset_new should be calculated at this point )



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

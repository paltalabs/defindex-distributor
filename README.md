# DeFindex Distributor

Smart contract + CLI to distribute dfTokens (DeFindex Vault Tokens) to users in a transparent and secure way.

The Distributor enables fund distribution in **campaigns or events** for DeFindex users: it deposits assets into a vault and distributes the resulting dfTokens to recipients from a CSV, as if each user had deposited directly. The smart contract ensures that each user receives the corresponding amount of dfTokens verifiably on-chain.

TODO: csv has amounts in underlying asset

## How it works

1. The script reads a CSV with recipients and amounts per vault
2. Groups by vault and splits into batches (to respect Soroban's instruction budget)
3. For each batch, calls the `distribute` contract which in a single transaction:
   - Deposits the batch total into the vault
   - Receives minted dfTokens
   - Distributes them pro-rata to each recipient
4. Verifies balances before/after and generates a CSV log with the results

TODO: agregar prerequisitos
## Mainnet Usage

### 1. Setup

```bash
pnpm i
cp .env.example .env
```

Edit `.env` with mainnet values:

```env
STELLAR_SECRET_KEY=S...                          # Account with funds to deposit
SOROBAN_RPC=https://soroban-rpc.mainnet.stellar.gateway.fm  # Mainnet RPC
HORIZON_RPC=https://horizon.stellar.org
STELLAR_NETWORK=public
```

### 2. Prepare the CSV

The CSV must have the columns: `vault`, `asset`, `user`, `amount`

- `vault`: DeFindex vault address
- `asset`: vault's underlying asset address (token to deposit)
- `user`: recipient address
- `amount`: amount in the asset's minimum unit (stroops)

```csv
vault,asset,user,amount
CDHZFQZWSU7GSHUBWFEL2FJ7R2RNVHI3RPY5QMCQ3MGJXOSHSTSW5PE7,CCZGLAUBDKJSQK72QOZHVU7CUWKW45OZWYWCLL27AEK74U2OIBK6LXF2,GCGI4UWY3JDN2NH4L33Y7GHOGFTV3WTGAPPCQONZJOPOL5BSSCVS6UQI,7952002150
CDHZFQZWSU7GSHUBWFEL2FJ7R2RNVHI3RPY5QMCQ3MGJXOSHSTSW5PE7,CCZGLAUBDKJSQK72QOZHVU7CUWKW45OZWYWCLL27AEK74U2OIBK6LXF2,GCUJW46S35TBIOS2R42LLK4W3O2HRHMQBXGLNSTVTUYCZWN5BML3H7XI,4303465857
```

### 3. Run the distribution

```bash
pnpm distribute path/to/file.csv
```

The script will:
- Show the status of each batch and vault
- Compare balances before/after for each user
- Generate a log at `output/distributor/distributor_<timestamp>.csv`

## Testnet Usage

To test on testnet, first run the demo scripts that create test vaults and users.

### 1. Setup for testnet

```bash
cp .env.example .env
```

`.env` comes configured for testnet by default.

TODO: 
SOROBAN_RPC=https://soroban-testnet.stellar.org
HORIZON_RPC=https://horizon-testnet.stellar.org

should be 4 variables , 2 for mainnet, 2 for testnet

### 2. Run the demo

```bash
STELLAR_NETWORK=testnet pnpm demo
```

This will:
- Fund the manager account via Friendbot
- Mint USDC/XTAR tokens via the Soroswap faucet
- Deploy 3 test vaults via the DeFindex Factory
TODO: Vaults should be set with a Blend strategy, and a real blend testnet pool (check defindex testnet)
after first deposit, should do the rebalance to the strategy

- Create 10 users per vault
- Generate a test CSV at `output/demo/demo_testnet_<timestamp>.csv`

### 3. Mint tokens if needed

If the manager account doesn't have enough funds for the deposits:

```bash
STELLAR_NETWORK=testnet pnpm mint output/demo/demo_testnet_<timestamp>.csv
```

### 4. Distribute

```bash
STELLAR_NETWORK=testnet pnpm distribute output/demo/demo_testnet_<timestamp>.csv
```
TODO: log should be refreshed after each tx
## Deploying the Distributor contract

```bash
make test
make build
stellar keys generate alice --network testnet --fund
stellar contract deploy \
  --wasm target/wasm32v1-none/release/defindex_distributor.wasm \
  --source-account alice \
  --network testnet \
  --alias defindex-distributor
```

The Contract ID will be stored at `~/.config/stellar/contract-ids/defindex-distributor.json`

## Project structure

```
src/
├── utils.ts            # Network config, Stellar SDK helpers
├── useDistributor.ts   # Main script: deposit + distribute via contract
├── demo.ts             # Testnet demo: deploy vaults, create users, generate CSV
└── mint.ts             # Mint testnet tokens via Soroswap faucet

contracts/
└── defindex-distributor/  # Soroban smart contract (Rust)

output/                 # Script outputs (gitignored)
├── demo/               # demo_testnet_*.csv
└── distributor/        # distributor_*.csv (distribution logs)
```

## Scripts

| Command | Description |
|---|---|
| `pnpm demo` | Deploy testnet vaults, create users, generate test CSV |
| `pnpm mint <csv>` | Mint testnet tokens via Soroswap faucet |
| `pnpm distribute <csv>` | Distribute dfTokens to users |

# DeFindex Distributor

Smart contract + CLI to distribute dfTokens (DeFindex Vault Tokens) to users in a transparent and secure way.

The Distributor enables fund distribution in **campaigns or events** for DeFindex users: it deposits assets into a vault and distributes the resulting dfTokens to recipients from a CSV that contains asset, vault, user and amount; as if each user had deposited directly. The smart contract ensures that each user receives the corresponding amount of dfTokens verifiably on-chain.

## How it works

1. The script reads a CSV with recipients and amounts per vault
2. Groups by vault and splits into batches (to respect Soroban's instruction limit)
3. For each batch, calls the `distribute` contract which in a single transaction:
   - Caller sends the total underlying amount to the distributor contract
   - Distributor deposits the total amount in the vault and receives minted dfTokens
   - Distributes dfTokens pro-rata to each recipient
4. Verifies balances before/after and generates incremental CSV + log files with the results

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [pnpm](https://pnpm.io/) package manager
- [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli) (only needed for deploying the smart contract)

## Mainnet Usage

### 1. Setup

```bash
pnpm i
cp .env.example .env
```

Edit `.env` with mainnet values:

```env
STELLAR_NETWORK=mainnet
STELLAR_SECRET_KEY_MAINNET=S...
SOROBAN_RPC_MAINNET=https://soroban-rpc.mainnet.stellar.gateway.fm
HORIZON_RPC_MAINNET=https://horizon.stellar.org
```

### 2. Prepare the CSV

The CSV must have the columns: `asset`, `vault`, `user`, `amount` (order doesn't matter, parsed by header name).

- `asset`: vault's underlying asset address (token to deposit)
- `vault`: DeFindex vault address
- `user`: recipient address
- `amount`: amount in the asset's minimum unit (stroops, 7 decimals)

```csv
asset,vault,user,amount
CCZGLAUBDKJSQK72QOZHVU7CUWKW45OZWYWCLL27AEK74U2OIBK6LXF2,CDHZFQZWSU7GSHUBWFEL2FJ7R2RNVHI3RPY5QMCQ3MGJXOSHSTSW5PE7,GCGI4UWY3JDN2NH4L33Y7GHOGFTV3WTGAPPCQONZJOPOL5BSSCVS6UQI,7952002150
CCZGLAUBDKJSQK72QOZHVU7CUWKW45OZWYWCLL27AEK74U2OIBK6LXF2,CDHZFQZWSU7GSHUBWFEL2FJ7R2RNVHI3RPY5QMCQ3MGJXOSHSTSW5PE7,GCUJW46S35TBIOS2R42LLK4W3O2HRHMQBXGLNSTVTUYCZWN5BML3H7XI,4303465857
```

### 3. Run the distribution

```bash
pnpm distribute path/to/file.csv
```

The script will:

- Show the status of each batch and vault
- Compare balances before/after for each user
- Write incremental logs to `output/distributor/distributor_<timestamp>.csv` and `.log`

## Testnet Usage

To test on testnet, run the demo script that creates test vaults and users.

### 1. Setup for testnet

```bash
pnpm i
cp .env.example .env
```

`.env` comes configured for testnet by default.

### 2. Run the demo

```bash
pnpm demo
```

This will:

- Fund the manager account via Friendbot
- Mint Blend USDC tokens via ephemeral accounts
- Fetch blend strategy addresses from the DeFindex repo
- Create 2 vaults (USDC + XLM) with blend strategies via the DeFindex API
- Create a random number of users per vault (between 5 and 20)
- Generate a test CSV at `output/demo/demo_testnet_<timestamp>.csv`
- Auto-run mint if additional tokens are needed (XLM via Friendbot, Blend tokens via ephemeral accounts)

### 3. Distribute

```bash
pnpm distribute output/demo/demo_testnet_<timestamp>.csv
```

## Environment Variables

All environment variables are suffixed by network (`_TESTNET` or `_MAINNET`). The `STELLAR_NETWORK` variable determines which suffix is used.

```env
STELLAR_NETWORK=testnet              # "testnet" or "mainnet"

STELLAR_SECRET_KEY_TESTNET=S...      # Account secret key
SOROBAN_RPC_TESTNET=https://soroban-testnet.stellar.org
HORIZON_RPC_TESTNET=https://horizon-testnet.stellar.org

STELLAR_SECRET_KEY_MAINNET=
SOROBAN_RPC_MAINNET=
HORIZON_RPC_MAINNET=

DEFINDEX_API_KEY=                    # Optional: DeFindex API key for demo vault creation
MINT_BLEND_TOKENS_URL=               # Optional: Blend faucet URL for demo token minting
```

## Deploying the Distributor contract (development)

```bash
make test
make build # build and optimize
stellar keys generate alice --network testnet --fund
stellar contract deploy \
  --wasm target/wasm32v1-none/release/defindex_distributor.wasm \
  --source-account alice \
  --network testnet \
  --alias defindex-distributor
```

The Contract ID will be stored at `~/.config/stellar/contract-ids/defindex-distributor.json`

Optional: replace the address in src/addresses.ts
```
NEW_ADDR=$(cat ~/.config/stellar/contract-ids/defindex-distributor.json | python3 -c "import sys,json; print(json.load(sys.stdin)['ids']['Test SDF Network ; September 2015'])") && \
sed -i "s/export const DISTRIBUTOR_TESTNET = \".*\"/export const DISTRIBUTOR_TESTNET = \"$NEW_ADDR\"/" src/addresses.ts
```

## Project structure

```
src/
├── utils.ts          # Network config, env helpers, Stellar SDK helpers
├── addresses.ts      # Contract addresses and API URLs
├── distribute.ts     # Main script: deposit + distribute via contract
├── demo.ts           # Testnet demo: create vaults via DeFindex API, generate CSV
├── mint.ts           # Mint testnet tokens (Blend faucet, Soroswap, Friendbot)
└── logger.ts         # Incremental CSV + log file writer

contracts/
└── defindex-distributor/  # Soroban smart contract (Rust)

output/                    # Script outputs (gitignored)
├── demo/                  # demo_testnet_*.csv
└── distributor/           # distributor_*.csv + distributor_*.log
```

## Scripts

| Command | Description |
| --- | --- |
| `pnpm demo` | Create testnet vaults with blend strategies, generate test CSV |
| `pnpm mint <csv>` | Mint testnet tokens (Soroswap faucet + XLM via Friendbot) |
| `pnpm distribute <csv>` | Distribute dfTokens to users with incremental logging |

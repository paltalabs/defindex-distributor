# dfTokens Transfer Campaigns

CLI tool to batch transfer dfTokens from a Soroswap USDC Vault to multiple recipients.

## Features

- Reads recipients and USDC amounts from a CSV file
- Automatically converts USDC amounts to dfToken amounts using vault's exchange rate
- Batches transfers (10 per transaction) using the Stellar Router contract
- Shows dry-run summary before executing transfers

## Setup

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Configure environment variables in `.env`:
   ```
   SOROBAN_RPC=https://soroban.stellar.org
   HORIZON_RPC=https://horizon.stellar.org
   STELLAR_SECRET_KEY=S...  # Account holding dfTokens (for transfer/send)
   MERGE_SECRET=S...        # Secret key of account to merge (for merge:secret)
   MNEMONIC="word1 word2..."  # 12/24 word mnemonic (for merge:mnemonic)
   ```

## Scripts

### Transfer dfTokens (`pnpm transfer`)

Batch transfer dfTokens from the Soroswap USDC Vault to multiple recipients.

```bash
pnpm transfer <accounts.csv>
```

**Required env vars:** `STELLAR_SECRET_KEY`, `SOROBAN_RPC`, `HORIZON_RPC`

#### CSV Format

```csv
address,amount
GABC...,100
GDEF...,50
```

- `address`: Stellar public key (G...) or contract address (C...)
- `amount`: USDC amount (human-readable, e.g., `100` for 100 USDC)

---

### Send XLM (`pnpm send`)

Send XLM from your account to a destination address.

```bash
pnpm send <amount> <destination>
```

**Example:**
```bash
pnpm send 10 GABC...
```

**Required env vars:** `STELLAR_SECRET_KEY`, `HORIZON_RPC`

---

### Merge Account from Secret (`pnpm merge:secret`)

Merge an account into a destination using a secret key. This closes the source account and transfers all XLM to the destination.

```bash
pnpm merge:secret
```

**Required env vars:** `MERGE_SECRET`, `HORIZON_RPC`

---

### Merge Account from Mnemonic (`pnpm merge:mnemonic`)

Merge an account derived from a mnemonic phrase (BIP39) into a destination. Uses the first derived account (index 0).

```bash
pnpm merge:mnemonic
```

**Required env vars:** `MNEMONIC`, `HORIZON_RPC`

## How It Works

1. Parses the CSV file
2. Fetches vault data (total supply, managed funds, locked fees) in 2 optimized RPC calls
3. Converts each USDC amount to the equivalent dfToken amount
4. Checks source account balance
5. Shows transfer summary (dry-run)
6. Executes batched transfers via the Stellar Router contract

## Configuration

| Constant | Value | Description |
|----------|-------|-------------|
| `SOROSWAP_USDC_VAULT` | `CA2FIP...` | Vault/dfToken contract address |
| `STELLAR_ROUTER_CONTRACT` | `CDAW42...` | Router for batching invocations |
| `BATCH_SIZE` | 10 | Transfers per transaction |

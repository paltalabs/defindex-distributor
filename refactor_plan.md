# Refactor Plan — DeFindex Lost Funds Distribution

## Overview

This project implements a complete flow to calculate and user funds:
**Analyze CSV → Deposit into vaults → Calculate proportional dfTokens → Batch transfer → Generate logs**

## Architecture

### Scripts and Responsibilities

| Script | Command | Purpose |
|---|---|---|
| `src/analyze.ts` | `pnpm analyze <csv>` | Parse the lost funds CSV, group by vault, generate analysis JSON |
| `src/deposit.ts` | `pnpm deposit <analysis.json>` | Deposit underlying assets into each vault, capture minted dfTokens, generate distribution CSV |
| `src/distribute.ts` | `pnpm distribute <distribution.csv>` | Batch-transfer dfTokens to affected users via router contract |
| `src/index.ts` | `pnpm transfer <csv>` | Legacy single-vault transfer script (preserved for backward compat) |
| `src/utils.ts` | — (library) | Shared types, constants, and utility functions |

### Flow Diagram

```
[1. Manual Swap]          Assets are swapped to underlying tokens outside the script
        ↓
[2. pnpm analyze]         Parse CSV → analysis_<ts>.json
        ↓
[3. pnpm deposit]         For each vault: deposit() → capture minted dfTokens
        ↓                  Output: deposit_log_<ts>.csv + distribution_<ts>.csv
[4. pnpm distribute]      Read distribution CSV → batch transfer dfTokens (10/batch)
        ↓                  Output: distributor_<ts>_log.csv
[5. Verify]               Check logs, balances, and tx hashes
```

### Shared Utilities (`src/utils.ts`)

**Types:**
- `Invocation` — Router contract invocation descriptor
- `StrategyReport` — Vault strategy report structure
- `TransferRecord` — Simple address + amount record

**Functions:**
- `simulateContractCall()` — Single contract simulation via RPC
- `simulateMultipleInvocations()` — Batched simulation via router
- `buildRouterTransaction()` — Build + simulate + sign a router tx
- `sendTransaction()` — Submit tx and poll for confirmation
- `batchArray()` — Split array into fixed-size chunks
- `createVaultInvocation()` — Build an Invocation for any vault (parametrized)

**Constants:**
- `STELLAR_ROUTER_CONTRACT` — Router contract address
- `BATCH_SIZE` — Transfers per batch (10)
- `rpcServer` — Soroban RPC server instance

## CSV Formats

### Input: Lost Funds CSV
```
vault_id,user_address,df_tokens,pps_before,pps_after,underlying_before,underlying_after,underlying_delta,Amount
CBNK...,GDVL...,1865162100605,1.105133558,0.9504424463,2061253228838,1772729229657,-288523999181,"-$28,852.40"
```

### Output: Analysis JSON (`analysis_<ts>.json`)
```json
{
  "timestamp": "2026-02-23T...",
  "source_csv": "DeFindex Lost Funds - per_user_per_vault.csv",
  "total_users": 920,
  "total_vaults": 12,
  "vaults": {
    "CBNK...": {
      "total_loss": 288523999181,
      "user_count": 319,
      "users": [
        { "address": "GDVL...", "underlying_delta": 288523999181 }
      ]
    }
  }
}
```

### Output: Deposit Log (`deposit_log_<ts>.csv`)
```
vault_id,amount_deposited,df_tokens_minted,tx_hash,timestamp
```

### Output: Distribution CSV (`distribution_<ts>.csv`)
```
vault_id,user_address,underlying_lost,df_tokens_to_receive
```

### Output: Distribution Log (`distributor_<ts>_log.csv`)
```
vault_id,user_address,df_tokens_transferred,tx_hash,batch_number,timestamp,status
```

## Vaults

12 vaults identified in the CSV:

| Vault ID | Records |
|---|---|
| CBNKCU3HGFKHFOF7JTGXQCNKE3G3DXS5RDBQUKQMIIECYKXPIOUGB2S3 | 319 |
| CC767WIU5QGJMXYHDDYJAJEF2YWPHOXOZDWD3UUAZVS4KQPRXCKPT2YZ | 292 |
| CBUJZL5QAD5TOPD7JMCBQ3RHR6RZWY34A4QF7UHILTDH2JF2Z3VJGY2Y | 227 |
| CA2FIPJ7U6BG3N7EOZFI74XPJZOEOD4TYWXFVCIO5VDCHTVAGS6F4UKK | 45 |
| CD4JGS6BB5NZVSNKRNI43GUC6E3OBYLCLBQZJVTZLDVHQ5KDAOHVOIQF | 19 |
| CBDZYJVQJQT7QJ7ZTMGNGZ7RR3DF32LERLZ26A2HLW5FNJ4OOZCLI3OG | 7 |
| CDRSZ4OGRVUU5ONTI6C6UNF5QFJ3OGGQCNTC5UXXTZQFVRTILJFSVG5D | 3 |
| CCKTLDG6I2MMJCKFWXXBXMA42LJ3XN2IOW6M7TK6EWNPJTS736ETFF2N | 3 |
| CCDRFMZ7CH364ATQ5YSVTEJ3G3KPNFVM6TTC6N4T5REHWJS6LGVFP7MY | 3 |
| CDTCSXSKRIFYLDMMF3UABU63LEXSAR2CRCJVSL2PUJGVLNCQWU7XGWCN | 1 |
| CDSM6RP3GP6MSV7PXN7OSXCJ5EGMSLGLYFJ4QEPPMQWABD5JU5UPAOZM | 1 |
| CDIHXKZ4PFKAIONK52JAR6ZNMP62F3UP7XTIBSJTQLMLHQ44PQ5Q2H3J | 1 |

## Configuration

- **Network:** Stellar Mainnet
- **Router:** `CDAW42JDSDEI2DXEPP4E7OAYNCRUA4LGCZHXCJ4BV5WVI4O4P77FO4UV`
- **Batch Size:** 10 transfers per transaction
- **Env vars:** `STELLAR_SECRET_KEY`, `SOROBAN_RPC`, `HORIZON_RPC`

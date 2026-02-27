#!/usr/bin/env bash
set -euo pipefail

REPO="paltalabs/defindex-distributor"

usage() {
  echo "Usage: $0 <network> <stellar-identity> [release-tag]"
  echo ""
  echo "Deploy defindex-distributor from a GitHub Release wasm."
  echo ""
  echo "Arguments:"
  echo "  network           testnet or mainnet"
  echo "  stellar-identity  Stellar identity (key name in stellar keys)"
  echo "  release-tag       GitHub release tag (default: latest)"
  echo ""
  echo "Examples:"
  echo "  $0 testnet user"
  echo "  $0 testnet user main_defindex-distributor_pkg0.0.0_cli22.8.1"
  exit 1
}

# ── Validate arguments ──
[[ $# -lt 2 ]] && usage

NETWORK="$1"
IDENTITY="$2"
RELEASE_TAG="${3:-}"

if [[ "$NETWORK" != "testnet" && "$NETWORK" != "mainnet" ]]; then
  echo "Error: network must be 'testnet' or 'mainnet', got '$NETWORK'"
  exit 1
fi

# ── Check prerequisites ──
if ! command -v gh &>/dev/null; then
  echo "Error: gh CLI not found. Install it from https://cli.github.com"
  exit 1
fi

if ! gh auth status &>/dev/null; then
  echo "Error: gh CLI not authenticated. Run 'gh auth login' first."
  exit 1
fi

if ! command -v stellar &>/dev/null; then
  echo "Error: stellar CLI not found. Install it from https://github.com/stellar/stellar-cli"
  exit 1
fi

# ── Temporary directory with cleanup ──
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# ── Download wasm from release ──
echo "Downloading wasm from release..."
if [[ -n "$RELEASE_TAG" ]]; then
  gh release download "$RELEASE_TAG" --repo "$REPO" --pattern '*.wasm' --dir "$TMPDIR"
else
  gh release download --repo "$REPO" --pattern '*.wasm' --dir "$TMPDIR"
fi

WASM_FILE="$(ls "$TMPDIR"/*.wasm 2>/dev/null | head -1)"
if [[ -z "$WASM_FILE" ]]; then
  echo "Error: no .wasm file found in the release"
  exit 1
fi

echo "Downloaded: $(basename "$WASM_FILE")"

# ── Deploy contract ──
echo "Deploying to $NETWORK..."
MAX_ATTEMPTS=3
CONTRACT_ID=""
for attempt in $(seq 1 $MAX_ATTEMPTS); do
  CONTRACT_ID=$(stellar contract deploy \
    --wasm "$WASM_FILE" \
    --source-account "$IDENTITY" \
    --network "$NETWORK") && break
  echo "Attempt $attempt/$MAX_ATTEMPTS failed."
  if [[ $attempt -lt $MAX_ATTEMPTS ]]; then
    echo "Retrying in 5s..."
    sleep 5
  else
    echo "❌ All $MAX_ATTEMPTS attempts failed. Exiting."
    exit 1
  fi
done

echo ""
echo "=== Deploy successful ==="
echo "Contract ID: $CONTRACT_ID"
echo ""

if [[ "$NETWORK" == "testnet" ]]; then
  echo "Stellar Expert: https://stellar.expert/explorer/testnet/contract/$CONTRACT_ID"
else
  echo "Stellar Expert: https://stellar.expert/explorer/public/contract/$CONTRACT_ID"
fi

echo ""
echo "Update src/addresses.ts manually with the new contract ID."

import { Address, Keypair } from "@stellar/stellar-sdk";
import { config } from "dotenv";
import * as fs from "fs";
import * as path from "path";
import {
  getNetwork,
  getNetworkConfig,
  simulateContractCall,
} from "./utils";

config();

const FAUCET_AMOUNT = 25_000_000_000n; // 2,500 tokens (7 decimals) per faucet call

// Types
interface VaultAnalysis {
  total_loss: string;
  user_count: number;
  users: { address: string; underlying_amount: string }[];
}

interface AnalysisInput {
  timestamp: string;
  source_csv: string;
  total_users: number;
  total_vaults: number;
  vaults: Record<string, VaultAnalysis>;
}

async function mintSoroswapToken(address: string, tokenContract: string): Promise<void> {
  const { soroswapFaucetUrl } = getNetworkConfig();
  if (!soroswapFaucetUrl) throw new Error("Soroswap faucet not available on this network");

  const url = `${soroswapFaucetUrl}?address=${address}&contract=${tokenContract}`;
  const response = await fetch(url, { method: "POST" });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Soroswap faucet failed: ${text}`);
  }
}

async function getTokenBalance(tokenContract: string, publicKey: string): Promise<bigint> {
  try {
    const result = await simulateContractCall(
      tokenContract, "balance",
      [new Address(publicKey).toScVal()],
      publicKey
    );
    return BigInt(result as string | number);
  } catch {
    return 0n;
  }
}

// Parse asset needs from analysis JSON (vault → get_assets RPC call)
async function assetNeedsFromAnalysis(
  analysis: AnalysisInput,
  sourcePublicKey: string
): Promise<Record<string, bigint>> {
  const assetNeeds: Record<string, bigint> = {};
  const vaultIds = Object.keys(analysis.vaults);

  console.log("Resolving vault assets via RPC...");
  for (const vaultId of vaultIds) {
    const vault = analysis.vaults[vaultId];
    const totalLoss = BigInt(vault.total_loss);

    const assetAddresses = await simulateContractCall(
      vaultId, "get_assets", [], sourcePublicKey
    ) as { address: string }[];

    if (!assetAddresses || assetAddresses.length === 0) {
      console.error(`  Vault ${vaultId}: could not get assets, skipping`);
      continue;
    }

    const asset = assetAddresses[0].address;
    assetNeeds[asset] = (assetNeeds[asset] || 0n) + totalLoss;
    console.log(`  ${vaultId.substring(0, 8)}... → ${asset.substring(0, 8)}... needs ${totalLoss}`);
  }

  return assetNeeds;
}

// Parse asset needs directly from demo CSV (has asset column)
function assetNeedsFromDemoCSV(filePath: string): Record<string, bigint> {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n");

  if (lines.length < 2) throw new Error("CSV must have a header and at least one data row");

  const header = lines[0].toLowerCase().split(",").map((h) => h.trim());
  const assetIdx = header.indexOf("asset");
  const amountIdx = header.indexOf("amount");

  if (assetIdx === -1 || amountIdx === -1) {
    throw new Error('CSV must have "asset" and "amount" columns');
  }

  const assetNeeds: Record<string, bigint> = {};

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = line.split(",").map((v) => v.trim());
    const asset = values[assetIdx];
    const amount = BigInt(values[amountIdx]);

    assetNeeds[asset] = (assetNeeds[asset] || 0n) + (amount < 0n ? -amount : amount);
  }

  console.log("Parsed asset needs from CSV:");
  for (const [asset, needed] of Object.entries(assetNeeds)) {
    console.log(`  ${asset.substring(0, 8)}... needs ${needed}`);
  }

  return assetNeeds;
}

async function main() {
  const network = getNetwork();
  if (network !== "testnet") {
    console.error("ERROR: This script is for testnet only. Set STELLAR_NETWORK=testnet");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: pnpm mint <analysis.json | demo.csv>");
    console.error("");
    console.error("Accepts either an analysis JSON or a demo CSV (with asset column).");
    console.error("Checks balances per asset and mints via Soroswap faucet to cover deposits.");
    process.exit(1);
  }

  const secretKey = process.env.STELLAR_SECRET_KEY;
  if (!secretKey) throw new Error("STELLAR_SECRET_KEY environment variable is required");
  if (!process.env.SOROBAN_RPC) throw new Error("SOROBAN_RPC environment variable is required");

  const sourceKeypair = Keypair.fromSecret(secretKey);
  const sourcePublicKey = sourceKeypair.publicKey();

  const inputPath = path.resolve(args[0]);
  const ext = path.extname(inputPath).toLowerCase();

  console.log("=".repeat(60));
  console.log("DeFindex Testnet Token Minter");
  console.log("=".repeat(60));
  console.log(`Account: ${sourcePublicKey}`);
  console.log(`Input: ${path.basename(inputPath)}`);
  console.log("");

  // Determine asset needs based on file type
  let assetNeeds: Record<string, bigint>;

  if (ext === ".csv") {
    assetNeeds = assetNeedsFromDemoCSV(inputPath);
  } else {
    const analysis: AnalysisInput = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
    console.log(`Vaults: ${analysis.total_vaults}`);
    assetNeeds = await assetNeedsFromAnalysis(analysis, sourcePublicKey);
  }
  console.log("");

  // Check balances and mint
  const assets = Object.keys(assetNeeds);

  for (const asset of assets) {
    const needed = assetNeeds[asset];
    const currentBalance = await getTokenBalance(asset, sourcePublicKey);
    const deficit = needed - currentBalance;

    console.log("-".repeat(60));
    console.log(`Asset: ${asset}`);
    console.log(`  Needed:  ${needed} (${(Number(needed) / 1e7).toFixed(2)} tokens)`);
    console.log(`  Balance: ${currentBalance} (${(Number(currentBalance) / 1e7).toFixed(2)} tokens)`);

    if (deficit <= 0n) {
      console.log(`  Status: OK — sufficient balance`);
      continue;
    }

    console.log(`  Deficit: ${deficit} (${(Number(deficit) / 1e7).toFixed(2)} tokens)`);

    const mintsNeeded = Number((deficit + FAUCET_AMOUNT - 1n) / FAUCET_AMOUNT);
    console.log(`  Faucet calls needed: ${mintsNeeded} (${(Number(FAUCET_AMOUNT) / 1e7).toFixed(0)} tokens each)`);
    console.log("");

    for (let i = 0; i < mintsNeeded; i++) {
      process.stdout.write(`  Minting ${i + 1}/${mintsNeeded}...`);
      try {
        await mintSoroswapToken(sourcePublicKey, asset);
        console.log(" OK");
      } catch (error) {
        console.log(` FAILED: ${error}`);
        console.error("  Stopping mints for this asset.");
        break;
      }

      // Small delay between calls
      if (i < mintsNeeded - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    // Verify final balance
    const finalBalance = await getTokenBalance(asset, sourcePublicKey);
    const stillMissing = needed - finalBalance;
    console.log(`  Final balance: ${finalBalance} (${(Number(finalBalance) / 1e7).toFixed(2)} tokens)`);
    if (stillMissing > 0n) {
      console.warn(`  WARNING: Still missing ${stillMissing} stroops`);
    } else {
      console.log(`  Status: OK`);
    }
    console.log("");
  }

  console.log("=".repeat(60));
  console.log("Minting complete. Next steps:");
  console.log(`  1. pnpm analyze <csv>           (if not done yet)`);
  console.log(`  2. pnpm deposit <analysis.json>`);
  console.log("=".repeat(60));
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

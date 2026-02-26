import * as StellarSdk from "@stellar/stellar-sdk";
import { Address, Keypair, TransactionBuilder, Contract, rpc, nativeToScVal } from "@stellar/stellar-sdk";
import { config } from "dotenv";
import * as fs from "fs";
import * as path from "path";
import {
  getNetwork,
  getNetworkConfig,
  getNetworkPassphrase,
  getEnvVar,
  getSecretKey,
  getRpcServer,
  simulateContractCall,
  sendTransaction,
} from "./utils";
import { TESTNET_BLEND_USDC, TESTNET_BLND_USDC, TESTNET_BLEND_WETH, TESTNET_BLEND_WBTC } from "./addresses";

config();

const FAUCET_AMOUNT = 25_000_000_000n; // 2,500 tokens (7 decimals) per faucet call

// Known XLM wrapper contract on testnet (Soroswap wrapped native)
const TESTNET_XLM_CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

// Friendbot gives 10,000 XLM; we transfer 98.5% = 9,850 XLM
const XLM_PER_FRIENDBOT = 10_000_0000000n; // 10,000 XLM in stroops
const XLM_TRANSFER_RATIO = 985n; // 98.5% (out of 1000)
const XLM_TRANSFER_PER_ACCOUNT = (XLM_PER_FRIENDBOT * XLM_TRANSFER_RATIO) / 1000n;

// Types
interface VaultAnalysis {
  amount: string;
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

const BLEND_TOKEN_ADDRESSES = new Set([
  TESTNET_BLEND_USDC,
  TESTNET_BLND_USDC,
  TESTNET_BLEND_WETH,
  TESTNET_BLEND_WBTC,
]);

// Blend USDC mint gives 1,000 tokens per call
const BLEND_MINT_USDC_AMOUNT = 1000_0000000n;

function isNativeXLM(assetAddress: string): boolean {
  return assetAddress === TESTNET_XLM_CONTRACT;
}

function isBlendToken(assetAddress: string): boolean {
  return BLEND_TOKEN_ADDRESSES.has(assetAddress);
}

async function fundWithFriendbot(publicKey: string): Promise<void> {
  const { friendbotUrl } = getNetworkConfig();
  if (!friendbotUrl) throw new Error("Friendbot not available on this network");

  const url = `${friendbotUrl}?addr=${publicKey}`;
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    if (text.includes("createAccountAlreadyExist") || text.includes("already funded")) return;
    throw new Error(`Friendbot failed for ${publicKey}: ${text}`);
  }
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

async function mintXLMViaFriendbot(
  managerPublicKey: string,
  deficit: bigint
): Promise<void> {
  const numAccounts = Number((deficit + XLM_TRANSFER_PER_ACCOUNT - 1n) / XLM_TRANSFER_PER_ACCOUNT);
  console.log(`  XLM minting: creating ${numAccounts} ephemeral accounts`);
  console.log(`  Each transfers ~${Number(XLM_TRANSFER_PER_ACCOUNT) / 1e7} XLM to manager`);
  console.log("");

  for (let i = 0; i < numAccounts; i++) {
    const tempKeypair = Keypair.random();
    const tempPublicKey = tempKeypair.publicKey();

    process.stdout.write(`  Account ${i + 1}/${numAccounts}: funding...`);
    try {
      await fundWithFriendbot(tempPublicKey);
      process.stdout.write(" transferring...");

      // Build a native payment from temp account to manager
      const account = await getRpcServer().getAccount(tempPublicKey);
      const transferAmount = Number(XLM_TRANSFER_PER_ACCOUNT) / 1e7;

      const tx = new TransactionBuilder(account, {
        fee: "200",
        networkPassphrase: getNetworkPassphrase(),
      })
        .addOperation(
          StellarSdk.Operation.payment({
            destination: managerPublicKey,
            asset: StellarSdk.Asset.native(),
            amount: transferAmount.toFixed(7),
          })
        )
        .setTimeout(120)
        .build();

      tx.sign(tempKeypair);
      await sendTransaction(tx);
      console.log(" OK");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(` FAILED: ${msg}`);
      console.error("  Stopping XLM minting.");
      break;
    }

    if (i < numAccounts - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/* 
  For testnet demo purposes, we mint blend tokens for users via a simple API endpoint that we control.
  this function recieves a user address and calls the API to mint:
  - 1000 USDC
  - 5000 BLND
  - 0.5 wETH
  - 0.05 wBTC
  
  The API is protected by a secret URL that is only used in this demo script, so it cannot be used by external users.
*/
async function mintBlendTokens(keypair: Keypair): Promise<void> {
  const mintUrl = process.env.MINT_BLEND_TOKENS_URL;
  if (!mintUrl) {
    console.warn("MINT_BLEND_TOKENS_URL not set, skipping blend token minting");
    return;
  }

  const address = keypair.publicKey();
  const url = `${mintUrl}getAssets?userId=${address}`;
  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Minting blend tokens failed for ${address}: ${text}`);
  }

  const xdrString = await response.text();
  if (!xdrString || xdrString.trim().length === 0) {
    throw new Error(`Blend faucet returned empty response for ${address}`);
  }

  const parsed = TransactionBuilder.fromXDR(xdrString.trim(), getNetworkPassphrase());
  if (parsed instanceof StellarSdk.FeeBumpTransaction) {
    throw new Error("FeeBumpTransaction not supported");
  }
  parsed.sign(keypair);
  await sendTransaction(parsed);
}

async function buildAndSendSorobanTx(
  sourceKeypair: Keypair,
  operation: StellarSdk.xdr.Operation
): Promise<string> {
  const sourcePublicKey = sourceKeypair.publicKey();
  const account = await getRpcServer().getAccount(sourcePublicKey);

  const txBuilder = new TransactionBuilder(account, {
    fee: "2000",
    networkPassphrase: getNetworkPassphrase(),
  });

  txBuilder.addOperation(operation);
  txBuilder.setTimeout(300);
  const tx = txBuilder.build();

  const simulation = await getRpcServer().simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Simulation failed: ${simulation.error}`);
  }

  const preparedTx = rpc.assembleTransaction(tx, simulation).build();
  preparedTx.sign(sourceKeypair);
  return sendTransaction(preparedTx);
}

async function mintBlendViaEphemeralAccounts(
  managerPublicKey: string,
  tokenAddress: string,
  deficit: bigint
): Promise<void> {
  const numAccounts = Number((deficit + BLEND_MINT_USDC_AMOUNT - 1n) / BLEND_MINT_USDC_AMOUNT);
  console.log(`  Blend minting: creating ${numAccounts} ephemeral accounts`);
  console.log(`  Each mints ~1,000 tokens and transfers to manager`);
  console.log("");

  const tokenContract = new Contract(tokenAddress);

  for (let i = 0; i < numAccounts; i++) {
    const tempKeypair = Keypair.random();
    const tempPublicKey = tempKeypair.publicKey();

    process.stdout.write(`  Account ${i + 1}/${numAccounts}: funding...`);
    try {
      await fundWithFriendbot(tempPublicKey);

      process.stdout.write(" minting...");
      await mintBlendTokens(tempKeypair);

      const balance = await getTokenBalance(tokenAddress, tempPublicKey);
      if (balance <= 0n) {
        console.log(" no balance received, skipping");
        continue;
      }

      process.stdout.write(` transferring ${Number(balance) / 1e7}...`);
      const transferOp = tokenContract.call(
        "transfer",
        new Address(tempPublicKey).toScVal(),
        new Address(managerPublicKey).toScVal(),
        nativeToScVal(balance, { type: "i128" })
      );
      await buildAndSendSorobanTx(tempKeypair, transferOp);
      console.log(" OK");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(` FAILED: ${msg}`);
      console.error("  Stopping Blend minting.");
      break;
    }

    if (i < numAccounts - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
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
    const totalAmount = BigInt(vault.amount);

    const assetAddresses = await simulateContractCall(
      vaultId, "get_assets", [], sourcePublicKey
    ) as { address: string }[];

    if (!assetAddresses || assetAddresses.length === 0) {
      console.error(`  Vault ${vaultId}: could not get assets, skipping`);
      continue;
    }

    const asset = assetAddresses[0].address;
    assetNeeds[asset] = (assetNeeds[asset] || 0n) + totalAmount;
    console.log(`  ${vaultId.substring(0, 8)}... → ${asset.substring(0, 8)}... needs ${totalAmount}`);
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
    console.error("Checks balances per asset and mints via Soroswap faucet or Friendbot (XLM).");
    process.exit(1);
  }

  const secretKey = await getSecretKey();

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
    const xlm = isNativeXLM(asset);

    // For XLM we check the Soroban token balance (wrapped native)
    const currentBalance = await getTokenBalance(asset, sourcePublicKey);
    const deficit = needed - currentBalance;

    console.log("-".repeat(60));
    const blend = isBlendToken(asset);
    const label = xlm ? " (native XLM)" : blend ? " (Blend token)" : "";
    console.log(`Asset: ${asset}${label}`);
    console.log(`  Needed:  ${needed} (${(Number(needed) / 1e7).toFixed(2)} tokens)`);
    console.log(`  Balance: ${currentBalance} (${(Number(currentBalance) / 1e7).toFixed(2)} tokens)`);

    if (deficit <= 0n) {
      console.log(`  Status: OK — sufficient balance`);
      continue;
    }

    console.log(`  Deficit: ${deficit} (${(Number(deficit) / 1e7).toFixed(2)} tokens)`);

    if (xlm) {
      // Mint XLM via Friendbot ephemeral accounts
      await mintXLMViaFriendbot(sourcePublicKey, deficit);
    } else if (isBlendToken(asset)) {
      // Mint via ephemeral accounts (Blend faucet has per-address limits)
      await mintBlendViaEphemeralAccounts(sourcePublicKey, asset, deficit);
    } else {
      // Mint via Soroswap faucet
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

        if (i < mintsNeeded - 1) {
          await new Promise((r) => setTimeout(r, 1000));
        }
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
  console.log("Minting complete.");
  console.log("=".repeat(60));
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

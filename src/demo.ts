import * as StellarSdk from "@stellar/stellar-sdk";
import { Address, Keypair, TransactionBuilder, Contract, rpc, nativeToScVal } from "@stellar/stellar-sdk";
import { config } from "dotenv";
import * as fs from "fs";
import { execSync } from "child_process";
import {
  getNetwork,
  getNetworkPassphrase,
  getNetworkConfig,
  getEnvVar,
  getSecretKey,
  getRpcServer,
  sendTransaction,
  simulateContractCall,
  getOutputPath,
} from "./utils";
import { DEFINDEX_API_URL, TESTNET_CONTRACTS_URL, TESTNET_BLEND_USDC, TESTNET_XLM } from "./addresses";

config();

// ── Testnet Constants ──
const USERS_PER_VAULT_MINIMUM = 5;
const USERS_PER_VAULT_MAXIMUM = 20;
const BUDGET_PER_VAULT = 5_000_0000000;

// Seed deposit amount (in stroops, 7 decimals) — small amount to initialize vault
const SEED_AMOUNT = 100_0000000; // 100 tokens

// ── Types ──
interface TestnetContracts {
  ids: {
    USDC_blend_strategy: string;
    XLM_blend_strategy: string;
    defindex_factory: string;
    [key: string]: string;
  };
  hashes: Record<string, string>;
}

interface VaultConfig {
  name: string;
  symbol: string;
  assetAddress: string;
  assetSymbol: string;
  strategyAddress: string;
  strategyName: string;
}

interface CreateVaultResponse {
  xdr: string;
  predictedVaultAddress: string;
  warning?: string;
}

// ── Helpers ──

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

async function mintBlendTokens(keypair: Keypair): Promise<void> {
  const mintUrl = process.env.MINT_BLEND_TOKENS_URL;
  if (!mintUrl) {
    throw new Error("MINT_BLEND_TOKENS_URL not set. Required to mint Blend USDC for vault seed deposits.");
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

async function mintBlendToManager(
  managerKeypair: Keypair,
tokenAddress: string
): Promise<void> {
  console.log(`  Minting blend to manager.`);
  await mintBlendTokens(managerKeypair);

  const managerPublicKey = managerKeypair.publicKey();
  const balance = await getTokenBalance(tokenAddress, managerPublicKey);
  if (balance <= 0n) {
    throw new Error("Ephemeral account received no tokens from Blend faucet");
  }

}

async function fetchTestnetContracts(): Promise<TestnetContracts> {
  const response = await fetch(TESTNET_CONTRACTS_URL);
  if (!response.ok) throw new Error(`Failed to fetch testnet contracts: ${response.statusText}`);
  return response.json() as Promise<TestnetContracts>;
}

async function createVaultViaAPI(
  managerPublicKey: string,
  vaultConfig: VaultConfig,
  network: string
): Promise<CreateVaultResponse> {
  const apiKey = process.env.DEFINDEX_API_KEY || "";
  const url = `${DEFINDEX_API_URL}/factory/create-vault-auto-invest?network=${network}`;

  const body = {
    caller: managerPublicKey,
    roles: {
      emergencyManager: managerPublicKey,
      rebalanceManager: managerPublicKey,
      feeReceiver: managerPublicKey,
      manager: managerPublicKey,
    },
    name: vaultConfig.name,
    symbol: vaultConfig.symbol,
    vaultFee: 0,
    upgradable: false,
    assets: [
      {
        address: vaultConfig.assetAddress,
        symbol: vaultConfig.assetSymbol,
        amount: SEED_AMOUNT,
        strategies: [
          {
            address: vaultConfig.strategyAddress,
            name: vaultConfig.strategyName,
            amount: SEED_AMOUNT,
          },
        ],
      },
    ],
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DeFindex API error (${response.status}): ${text}`);
  }

  return response.json() as Promise<CreateVaultResponse>;
}

async function signAndSendXdr(xdrString: string, keypair: Keypair): Promise<string> {
  const parsed = TransactionBuilder.fromXDR(xdrString, getNetworkPassphrase());
  if (parsed instanceof StellarSdk.FeeBumpTransaction) {
    throw new Error("FeeBumpTransaction not supported");
  }
  parsed.sign(keypair);
  return sendTransaction(parsed);
}

// ── Main ──
async function main() {
  const network = getNetwork();
  if (network !== "testnet") {
    console.error("ERROR: This script is for testnet only. Set STELLAR_NETWORK=testnet");
    process.exit(1);
  }

  const secretKey = await getSecretKey();

  const managerKeypair = Keypair.fromSecret(secretKey);
  const managerPublicKey = managerKeypair.publicKey();

  console.log("=".repeat(60));
  console.log("DeFindex Testnet Demo");
  console.log("=".repeat(60));
  console.log(`Manager: ${managerPublicKey}`);
  console.log(`Network: testnet`);
  console.log(`Users per vault: ${USERS_PER_VAULT_MINIMUM}–${USERS_PER_VAULT_MAXIMUM} (random per vault)`);
  console.log("");

  // Step 1: Fund manager via friendbot
  console.log("Step 1: Funding manager account...");
  try {
    await fundWithFriendbot(managerPublicKey);
    console.log("  Manager account funded via friendbot (or already exists)");
  } catch (error) {
    console.error("  Failed to fund manager:", error);
    throw error;
  }

  // Step 2: Mint USDC + XTAR for manager (needed for vault seed deposits)
  console.log("");
  console.log("Step 2: Checking manager token balances...");
  for (const { name, contract } of [
    { name: "USDC", contract: TESTNET_BLEND_USDC },
  ]) {
    let balance = 0n;
    try {
      const bal = await simulateContractCall(
        contract, "balance",
        [new Address(managerPublicKey).toScVal()],
        managerPublicKey
      );
      balance = BigInt(bal as string | number);
    } catch {
      // No balance yet
    }

    console.log(`  ${name} balance: ${balance} (${Number(balance) / 1e7} tokens)`);
    const seedNeeded = BigInt(SEED_AMOUNT);
    if (balance < seedNeeded) {
      console.log(`  Need at least ${Number(seedNeeded) / 1e7} tokens for seed deposit. Minting via Blend faucet...`);
      try {
        await mintBlendToManager(managerKeypair, contract);
        const bal = await simulateContractCall(
          contract, "balance",
          [new Address(managerPublicKey).toScVal()],
          managerPublicKey
        );
        balance = BigInt(bal as string | number);
        console.log(`  ${name} minted. Balance: ${balance} (${Number(balance) / 1e7} tokens)`);
      } catch (error) {
        console.warn(`  Warning: Failed to mint ${name} for manager:`, error);
      }
    }
  }
  console.log("");

  // Step 3: Fetch testnet strategy addresses
  console.log("Step 3: Fetching testnet strategy addresses...");
  const contracts = await fetchTestnetContracts();
  const usdcBlendStrategy = contracts.ids.USDC_blend_strategy;
  const xlmBlendStrategy = contracts.ids.XLM_blend_strategy;
  console.log(`  USDC Blend Strategy: ${usdcBlendStrategy}`);
  console.log(`  XLM Blend Strategy:  ${xlmBlendStrategy}`);
  console.log("");

  // Step 4: Create vaults via DeFindex API
  const vaultConfigs: VaultConfig[] = [
    {
      name: "Demo USDC Vault",
      symbol: "dfUSDC",
      assetAddress: TESTNET_BLEND_USDC,
      assetSymbol: "USDC",
      strategyAddress: usdcBlendStrategy,
      strategyName: "USDC_blend_strategy",
    },
    {
      name: "Demo XLM Vault",
      symbol: "dfXLM",
      assetAddress: TESTNET_XLM,
      assetSymbol: "XLM",
      strategyAddress: xlmBlendStrategy,
      strategyName: "XLM_blend_strategy",
    },
  ];

  console.log(`Step 4: Creating ${vaultConfigs.length} vaults via DeFindex API...`);
  const vaults: { address: string; asset: string; assetName: string }[] = [];

  for (let i = 0; i < vaultConfigs.length; i++) {
    const vc = vaultConfigs[i];
    console.log(`  Creating vault ${i + 1}/${vaultConfigs.length} (${vc.name})...`);

    try {
      const apiResponse = await createVaultViaAPI(managerPublicKey, vc, network);
      console.log(`    Predicted address: ${apiResponse.predictedVaultAddress}`);
      if (apiResponse.warning) {
        console.log(`    Warning: ${apiResponse.warning}`);
      }

      console.log("    Signing and submitting transaction...");
      const txHash = await signAndSendXdr(apiResponse.xdr, managerKeypair);
      console.log(`    TX confirmed: ${txHash}`);

      vaults.push({
        address: apiResponse.predictedVaultAddress,
        asset: vc.assetAddress,
        assetName: vc.assetSymbol,
      });
    } catch (error) {
      console.error(`    Failed to create vault:`, error);
      throw error;
    }
  }
  console.log("");

  // Step 5: Create users per vault (random count between min and max)
  console.log(`Step 5: Creating users per vault (${USERS_PER_VAULT_MINIMUM}–${USERS_PER_VAULT_MAXIMUM} random)...`);
  const usersByVault: Record<string, { publicKey: string; keypair: Keypair }[]> = {};

  for (const vault of vaults) {
    const n = USERS_PER_VAULT_MINIMUM + Math.floor(Math.random() * (USERS_PER_VAULT_MAXIMUM - USERS_PER_VAULT_MINIMUM + 1));
    console.log(`  Vault ${vault.address.substring(0, 8)}... (${vault.assetName}): ${n} users`);
    usersByVault[vault.address] = [];

    for (let j = 0; j < n; j++) {
      const userKeypair = Keypair.random();
      const userPublicKey = userKeypair.publicKey();
      usersByVault[vault.address].push({ publicKey: userPublicKey, keypair: userKeypair });

      if ((j + 1) % 5 === 0 || j === n - 1) {
        console.log(`    Created ${j + 1}/${n} users`);
      }
    }
  }
  console.log("");

  // Step 6: Generate CSV
  // Budget per vault: 500 tokens (7 decimals). Random split across users.
  console.log(`Step 6: Generating demo CSV (${BUDGET_PER_VAULT / 1e7} tokens budget per vault)...`);
  const csvRows: string[] = ["asset,vault,user,amount"];

  for (const vault of vaults) {
    const users = usersByVault[vault.address];
    // Generate random weights and normalize to fit budget
    const weights = users.map(() => Math.random());
    const totalWeight = weights.reduce((s, w) => s + w, 0);

    for (let idx = 0; idx < users.length; idx++) {
      const amount = Math.max(
        1_0000000, // minimum 1 token
        Math.floor((weights[idx] / totalWeight) * BUDGET_PER_VAULT)
      );
      csvRows.push(`${vault.asset},${vault.address},${users[idx].publicKey},${amount}`);
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const csvFilename = `demo_testnet_${timestamp}.csv`;
  const csvPath = getOutputPath("demo", csvFilename);
  fs.writeFileSync(csvPath, csvRows.join("\n"));
  console.log(`  CSV written to: ${csvPath}`);
  console.log("");

  // Step 7: Check if minting is needed and auto-run mint
  console.log("Step 7: Checking if additional minting is needed...");
  try {
    execSync(`npx tsx src/mint.ts ${csvPath}`, { stdio: "inherit" });
  } catch (error) {
    console.warn("  Warning: Auto-mint encountered errors. You may need to run pnpm mint manually.");
  }
  console.log("");

  // Done
  console.log("=".repeat(60));
  console.log("Demo Complete");
  console.log("=".repeat(60));
  console.log(`CSV: ${csvPath}`);
  console.log(`Vaults created: ${vaults.length}`);
  for (const vault of vaults) {
    const userCount = usersByVault[vault.address]?.length ?? 0;
    console.log(`  ${vault.address} (${vault.assetName}) — ${userCount} users`);
  }
  console.log("");
  console.log("Next steps:");
  console.log(`  pnpm distribute ${csvPath}`);
  console.log("=".repeat(60));
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

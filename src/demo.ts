import * as StellarSdk from "@stellar/stellar-sdk";
import { Address, xdr, Keypair, Contract, TransactionBuilder, rpc, nativeToScVal } from "@stellar/stellar-sdk";
import { config } from "dotenv";
import * as fs from "fs";
import {
  getNetwork,
  getNetworkPassphrase,
  getNetworkConfig,
  rpcServer,
  sendTransaction,
  simulateContractCall,
  getOutputPath,
} from "./utils";

config();

// ── Testnet Constants ──
const NUM_VAULTS = 3;
const USERS_PER_VAULT = 10;

// Soroswap testnet tokens
const TESTNET_XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TESTNET_USDC = "CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F";
const TESTNET_XTAR = "CCZGLAUBDKJSQK72QOZHVU7CUWKW45OZWYWCLL27AEK74U2OIBK6LXF2";

// DeFindex testnet
const DEFINDEX_FACTORY = "CDSCWE4GLNBYYTES2OCYDFQA2LLY4RBIAX6ZI32VSUXD7GO6HRPO4A32";
const SOROSWAP_ROUTER = "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH";

// ── Helpers ──

async function fundWithFriendbot(publicKey: string): Promise<void> {
  const { friendbotUrl } = getNetworkConfig();
  if (!friendbotUrl) throw new Error("Friendbot not available on this network");

  const url = `${friendbotUrl}?addr=${publicKey}`;
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    // Already funded is OK
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
    throw new Error(`Soroswap faucet failed for ${address}: ${text}`);
  }
}

async function buildAndSendTx(
  sourceKeypair: Keypair,
  operation: StellarSdk.xdr.Operation
): Promise<string> {
  const sourcePublicKey = sourceKeypair.publicKey();
  const account = await rpcServer.getAccount(sourcePublicKey);

  const txBuilder = new TransactionBuilder(account, {
    fee: "2000",
    networkPassphrase: getNetworkPassphrase(),
  });

  txBuilder.addOperation(operation);
  txBuilder.setTimeout(300);
  const tx = txBuilder.build();

  const simulation = await rpcServer.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Simulation failed: ${simulation.error}`);
  }

  const preparedTx = rpc.assembleTransaction(tx, simulation).build();
  preparedTx.sign(sourceKeypair);

  return sendTransaction(preparedTx);
}

// ── Factory: create_defindex_vault ──

function buildCreateVaultOperation(
  managerAddress: string,
  assetAddress: string,
  factoryContract: Contract
): StellarSdk.xdr.Operation {
  // roles: Map<u32, Address> — 0=EmergencyManager, 1=FeeReceiver, 2=Manager, 3=RebalanceManager
  const rolesMap = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: nativeToScVal(0, { type: "u32" }),
      val: new Address(managerAddress).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal(1, { type: "u32" }),
      val: new Address(managerAddress).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal(2, { type: "u32" }),
      val: new Address(managerAddress).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal(3, { type: "u32" }),
      val: new Address(managerAddress).toScVal(),
    }),
  ]);

  // vault_fee: u32 (0 basis points)
  const vaultFee = nativeToScVal(0, { type: "u32" });

  // assets: Vec<AssetStrategySet>
  // Each AssetStrategySet = { address: Address, strategies: Vec<Strategy> }
  const assets = xdr.ScVal.scvVec([
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("address"),
        val: new Address(assetAddress).toScVal(),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("strategies"),
        val: xdr.ScVal.scvVec([]),
      }),
    ]),
  ]);

  // soroswap_router
  const router = new Address(SOROSWAP_ROUTER).toScVal();

  // name_symbol: Map<String, String>
  const assetName = assetAddress === TESTNET_USDC ? "USDC" : assetAddress === TESTNET_XTAR ? "XTAR" : "XLM";
  const nameSymbol = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvString("name"),
      val: xdr.ScVal.scvString(`Demo ${assetName} Vault`),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvString("symbol"),
      val: xdr.ScVal.scvString(`df${assetName}`),
    }),
  ]);

  // upgradable: bool
  const upgradable = xdr.ScVal.scvBool(false);

  return factoryContract.call(
    "create_defindex_vault",
    rolesMap,
    vaultFee,
    assets,
    router,
    nameSymbol,
    upgradable
  );
}

// ── Main ──
async function main() {
  const network = getNetwork();
  if (network !== "testnet") {
    console.error("ERROR: This script is for testnet only. Set STELLAR_NETWORK=testnet");
    process.exit(1);
  }

  const secretKey = process.env.STELLAR_SECRET_KEY;
  if (!secretKey) throw new Error("STELLAR_SECRET_KEY environment variable is required");
  if (!process.env.SOROBAN_RPC) throw new Error("SOROBAN_RPC environment variable is required");

  const managerKeypair = Keypair.fromSecret(secretKey);
  const managerPublicKey = managerKeypair.publicKey();

  console.log("=".repeat(60));
  console.log("DeFindex Testnet Demo");
  console.log("=".repeat(60));
  console.log(`Manager: ${managerPublicKey}`);
  console.log(`Network: testnet`);
  console.log(`Vaults to create: ${NUM_VAULTS}`);
  console.log(`Users per vault: ${USERS_PER_VAULT}`);
  console.log("");

  // Step 1: Fund manager via friendbot + mint USDC
  console.log("Step 1: Funding manager account...");
  try {
    await fundWithFriendbot(managerPublicKey);
    console.log("  Manager account funded via friendbot (or already exists)");
  } catch (error) {
    console.error("  Failed to fund manager:", error);
    throw error;
  }

  // Check and mint tokens for manager (USDC + XTAR)
  for (const { name, contract } of [
    { name: "USDC", contract: TESTNET_USDC },
    { name: "XTAR", contract: TESTNET_XTAR },
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

    if (balance > 0n) {
      console.log(`  Manager already has ${name} balance: ${balance}`);
    } else {
      console.log(`  Manager has no ${name}. Minting via Soroswap faucet...`);
      try {
        await mintSoroswapToken(managerPublicKey, contract);
        const bal = await simulateContractCall(
          contract, "balance",
          [new Address(managerPublicKey).toScVal()],
          managerPublicKey
        );
        balance = BigInt(bal as string | number);
        console.log(`  ${name} minted. Balance: ${balance}`);
      } catch (error) {
        console.warn(`  Warning: Failed to mint ${name} for manager:`, error);
        console.warn(`  ${name} vault deposits may fail. You can mint manually later.`);
      }
    }
  }
  console.log("");

  // Step 2: Deploy vaults
  console.log(`Step 2: Deploying ${NUM_VAULTS} vaults...`);
  const factoryContract = new Contract(DEFINDEX_FACTORY);
  const vaults: { address: string; asset: string; assetName: string }[] = [];

  for (let i = 0; i < NUM_VAULTS; i++) {
    // Alternate between XTAR and USDC
    const assetAddress = i % 2 === 0 ? TESTNET_XTAR : TESTNET_USDC;
    const assetName = assetAddress === TESTNET_XTAR ? "XTAR" : "USDC";

    console.log(`  Creating vault ${i + 1}/${NUM_VAULTS} (${assetName})...`);

    try {
      const operation = buildCreateVaultOperation(managerPublicKey, assetAddress, factoryContract);
      const txHash = await buildAndSendTx(managerKeypair, operation);
      console.log(`    TX: ${txHash}`);

      // Get the vault address from the transaction result
      const txResult = await rpcServer.getTransaction(txHash);
      if (txResult.status !== "SUCCESS" || !txResult.returnValue) {
        throw new Error(`Transaction did not return a vault address`);
      }

      const vaultAddress = StellarSdk.scValToNative(txResult.returnValue) as string;
      console.log(`    Vault deployed: ${vaultAddress}`);

      vaults.push({ address: vaultAddress, asset: assetAddress, assetName });
    } catch (error) {
      console.error(`    Failed to create vault ${i + 1}:`, error);
      throw error;
    }
  }
  console.log("");

  // Step 3: Seed vaults with initial deposit (avoids min liquidity fee on distribute)
  const SEED_AMOUNT = 2000n;
  console.log("Step 3: Seeding vaults with initial deposit...");

  for (const vault of vaults) {
    let totalSupply = 0n;
    try {
      const result = await simulateContractCall(
        vault.address, "total_supply", [], managerPublicKey
      );
      totalSupply = BigInt(result as string | number);
    } catch {
      // No supply yet
    }

    if (totalSupply > 0n) {
      console.log(`  ${vault.address.substring(0, 8)}... (${vault.assetName}) already has supply: ${totalSupply} — skipping`);
      continue;
    }

    console.log(`  ${vault.address.substring(0, 8)}... (${vault.assetName}) is empty — depositing ${SEED_AMOUNT}...`);
    try {
      const vaultContract = new Contract(vault.address);
      const amountScVal = nativeToScVal(SEED_AMOUNT, { type: "i128" });

      const operation = vaultContract.call(
        "deposit",
        xdr.ScVal.scvVec([amountScVal]),  // amounts_desired
        xdr.ScVal.scvVec([amountScVal]),  // amounts_min
        new Address(managerPublicKey).toScVal(),  // from
        xdr.ScVal.scvBool(false)  // invest
      );

      const txHash = await buildAndSendTx(managerKeypair, operation);
      console.log(`    Seed deposit confirmed: ${txHash}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`    Seed deposit FAILED: ${msg}`);
      console.warn("    Distribute may fail for this vault due to min liquidity fee.");
    }
  }
  console.log("");

  // Step 4: Create and fund users
  console.log(`Step 4: Creating ${USERS_PER_VAULT} users per vault...`);
  const usersByVault: Record<string, { publicKey: string; keypair: Keypair }[]> = {};

  for (const vault of vaults) {
    
    console.log(`  Vault ${vault.address.substring(0, 8)}... (${vault.assetName}):`);
    usersByVault[vault.address] = [];

    for (let j = 0; j < USERS_PER_VAULT; j++) {
      const userKeypair = Keypair.random();
      const userPublicKey = userKeypair.publicKey();
      usersByVault[vault.address].push({ publicKey: userPublicKey, keypair: userKeypair });

      if ((j + 1) % 5 === 0 || j === USERS_PER_VAULT - 1) {
        console.log(`    Funded ${j + 1}/${USERS_PER_VAULT} users }`);
      }
      // Small delay to avoid rate limiting
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log("");

  // Step 5: Generate simulated data
  console.log("Step 5: Generating simulated data...");
  const csvRows: string[] = ["vault,asset,user,amount"];

  for (const vault of vaults) {
    const users = usersByVault[vault.address];
    for (const user of users) {
      // Random amount between 1 and 1,000 (in 7-decimal stroops)
      const amount = Math.floor(Math.random() * 999_0000000 + 1_0000000);
      csvRows.push(`${vault.address},${vault.asset},${user.publicKey},${amount}`);
    }
  }

  // Step 6: Save CSV
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const csvFilename = `demo_testnet_${timestamp}.csv`;
  const csvPath = getOutputPath("demo", csvFilename);
  fs.writeFileSync(csvPath, csvRows.join("\n"));

  console.log("");
  console.log("=".repeat(60));
  console.log("Demo Complete");
  console.log("=".repeat(60));
  console.log(`CSV written to: ${csvFilename}`);
  console.log(`Vaults created: ${vaults.length}`);
  for (const vault of vaults) {
    const userCount = usersByVault[vault.address]?.length ?? 0;
    console.log(`  ${vault.address} (${vault.assetName}) — ${userCount} users`);
  }
  console.log("");
  console.log("Next steps:");
  console.log(`  run: pnpm distribute output/demo/${csvFilename}`);
  console.log("=".repeat(60));
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

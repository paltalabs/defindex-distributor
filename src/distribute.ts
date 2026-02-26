import * as StellarSdk from "@stellar/stellar-sdk";
import { Address, xdr, Keypair, Contract, TransactionBuilder, rpc, nativeToScVal } from "@stellar/stellar-sdk";
import { config } from "dotenv";
import * as fs from "fs";
import * as path from "path";
import {
  getNetwork,
  getNetworkPassphrase,
  getEnvVar,
  getSecretKey,
  getRpcServer,
  sendTransaction,
  simulateContractCall,
  batchArray,
  BATCH_MAX_SIZE,
} from "./utils";
import { Logger } from "./logger";
import { DISTRIBUTOR_MAINNET, DISTRIBUTOR_TESTNET } from "./addresses";

config();

function getDistributorAddress(): string {
  return getNetwork() === "mainnet" ? DISTRIBUTOR_MAINNET : DISTRIBUTOR_TESTNET;
}

// ── Types ──
interface CsvRecord {
  vault: string;
  asset: string;
  user: string;
  amount: bigint;
}

interface VaultGroup {
  asset: string;
  recipients: { user: string; amount: bigint }[];
}

// ── CSV Parsing ──
// Accepts demo CSV format: vault, asset, user, amount
function parseCSV(filePath: string): CsvRecord[] {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`CSV file not found: ${absolutePath}`);
  }

  const content = fs.readFileSync(absolutePath, "utf-8");
  const lines = content.trim().split("\n");

  if (lines.length < 2) {
    throw new Error("CSV must have a header row and at least one data row");
  }

  const header = lines[0].toLowerCase().split(",").map((h) => h.trim());

  const hasRequired = header.includes("asset") && header.includes("vault") && header.includes("user") && header.includes("amount");
  if (!hasRequired) {
    throw new Error(
      'CSV format not recognized. Expected columns: "asset", "vault", "user", "amount"'
    );
  }

  const assetIdx = header.indexOf("asset");
  const vaultIdx = header.indexOf("vault");
  const userIdx = header.indexOf("user");
  const amountIdx = header.indexOf("amount");

  const records: CsvRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = line.split(",").map((v) => v.trim());
    const amount = BigInt(values[amountIdx]);
    if (amount <= 0n) {
      console.warn(`Skipping row ${i + 1}: zero or negative amount`);
      continue;
    }

    records.push({
      asset: values[assetIdx],
      vault: values[vaultIdx],
      user: values[userIdx],
      amount,
    });
  }

  return records;
}

function groupByVault(records: CsvRecord[]): Map<string, VaultGroup> {
  const groups = new Map<string, VaultGroup>();

  for (const record of records) {
    let group = groups.get(record.vault);
    if (!group) {
      group = { asset: record.asset, recipients: [] };
      groups.set(record.vault, group);
    }
    group.recipients.push({ user: record.user, amount: record.amount });
  }

  return groups;
}

// ── Balance Fetching ──
async function getDfTokenBalance(vaultId: string, userAddress: string, callerPublicKey: string): Promise<bigint> {
  try {
    const result = await simulateContractCall(
      vaultId,
      "balance",
      [new Address(userAddress).toScVal()],
      callerPublicKey
    );
    return BigInt(result as string | number);
  } catch {
    return 0n;
  }
}

async function fetchBalances(
  vaultId: string,
  users: string[],
  callerPublicKey: string
): Promise<Map<string, bigint>> {
  const balances = new Map<string, bigint>();

  for (const user of users) {
    const balance = await getDfTokenBalance(vaultId, user, callerPublicKey);
    balances.set(user, balance);
  }

  return balances;
}

// ── Transaction Building ──
function buildDistributeOperation(
  callerAddress: string,
  assetAddress: string,
  vaultAddress: string,
  recipients: { user: string; amount: bigint }[]
): StellarSdk.xdr.Operation {
  const distributorContract = new Contract(getDistributorAddress());

  // Build Vec<Recipient> where Recipient is a struct { address: Address, amount: i128 }
  const recipientsScVal = xdr.ScVal.scvVec(
    recipients.map((r) =>
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("address"),
          val: new Address(r.user).toScVal(),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("amount"),
          val: nativeToScVal(r.amount, { type: "i128" }),
        }),
      ])
    )
  );

  return distributorContract.call(
    "distribute",
    new Address(callerAddress).toScVal(),
    new Address(assetAddress).toScVal(),
    new Address(vaultAddress).toScVal(),
    recipientsScVal
  );
}

async function buildAndSendTx(
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

  // Add resource buffer to avoid on-chain failures due to resource underestimation
  const successSim = simulation as rpc.Api.SimulateTransactionSuccessResponse;
  if (successSim.minResourceFee) {
    const bufferedFee = Math.ceil(Number(successSim.minResourceFee) * 1.15);
    (successSim as any).minResourceFee = String(bufferedFee);
  }

  const preparedTx = rpc.assembleTransaction(tx, successSim).build();
  preparedTx.sign(sourceKeypair);

  return sendTransaction(preparedTx);
}

// ── Result Parsing ──
function parseContractResult(returnValue: xdr.ScVal): Map<string, bigint> {
  const result = new Map<string, bigint>();
  const tuples = StellarSdk.scValToNative(returnValue) as Array<[string, bigint]>;

  for (const [address, dfTokens] of tuples) {
    result.set(address, BigInt(dfTokens));
  }

  return result;
}

// ── Main ──
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage: pnpm use-distributor <demo.csv>");
    console.error("");
    console.error("CSV columns: vault,asset,user,amount");
    console.error("Calls the Distributor contract to deposit + distribute in one tx per vault.");
    process.exit(1);
  }

  const csvPath = args[0];
  const secretKey = await getSecretKey();

  const sourceKeypair = Keypair.fromSecret(secretKey);
  const sourcePublicKey = sourceKeypair.publicKey();

  console.log("=".repeat(60));
  console.log("DeFindex Distributor (deposit + distribute)");
  console.log("=".repeat(60));
  console.log(`Caller:      ${sourcePublicKey}`);
  console.log(`Network:     ${getNetwork()}`);
  console.log(`Distributor: ${getDistributorAddress()}`);
  console.log(`Input CSV:   ${csvPath}`);
  console.log("");

  // 1. Parse CSV and group by vault
  const records = parseCSV(csvPath);
  const vaultGroups = groupByVault(records);

  console.log(`Total records: ${records.length}`);
  console.log(`Vaults: ${vaultGroups.size}`);
  console.log(`Max batch size: ${BATCH_MAX_SIZE}`);
  console.log("");

  if (records.length === 0) {
    console.log("No valid records to process.");
    return;
  }

  const logger = new Logger("distributor");
  logger.logMessage(`Input CSV: ${csvPath}`);
  logger.logMessage(`Caller: ${sourcePublicKey}`);
  logger.logMessage(`Distributor: ${getDistributorAddress()}`);

  let successCount = 0;
  let failedCount = 0;
  let totalDfReceived = 0n;
  let totalDelta = 0n;

  // 2. Process each vault
  for (const [vaultId, group] of vaultGroups) {
    const totalAmount = group.recipients.reduce((sum, r) => sum + r.amount, 0n);
    const users = group.recipients.map((r) => r.user);
    const batches = batchArray(group.recipients, BATCH_MAX_SIZE);

    logger.logMessage("-".repeat(60));
    logger.logMessage(`Vault: ${vaultId}`);
    logger.logMessage(`Asset: ${group.asset}`);
    logger.logMessage(`Recipients: ${group.recipients.length} | Total amount: ${totalAmount}`);
    logger.logMessage(`Batches: ${batches.length} (max batch size: ${BATCH_MAX_SIZE})`);

    // 2a. Pre-fetch dfToken balances (once for all users of this vault)
    logger.logMessage("  Fetching dfToken balances before...");
    const balancesBefore = await fetchBalances(vaultId, users, sourcePublicKey);
    for (const [user, bal] of balancesBefore) {
      logger.logMessage(`    ${user.substring(0, 12)}... balance: ${bal}`);
    }

    // 2b. Process each batch
    const allDfTokensFromContract = new Map<string, bigint>();
    const txHashes = new Map<string, string>();
    const failedUsers = new Set<string>();

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      const batchNum = batchIdx + 1;
      const batchTotal = batch.reduce((sum, r) => sum + r.amount, 0n);

      logger.logMessage(`  Batch ${batchNum}/${batches.length} (${batch.length} recipients, total: ${batchTotal})`);
      logger.logMessage("  Building distribute transaction...");

      const operation = buildDistributeOperation(
        sourcePublicKey,
        group.asset,
        vaultId,
        batch
      );

      try {
        const txHash = await buildAndSendTx(sourceKeypair, operation);
        logger.logMessage(`  TX confirmed: ${txHash}`);

        const txResult = await getRpcServer().getTransaction(txHash);
        if (txResult.status === "SUCCESS" && txResult.returnValue) {
          const batchDfTokens = parseContractResult(txResult.returnValue);
          logger.logMessage(`  Contract returned dfTokens for batch ${batchNum}:`);
          for (const [user, tokens] of batchDfTokens) {
            logger.logMessage(`    ${user.substring(0, 12)}... → ${tokens}`);
            allDfTokensFromContract.set(user, tokens);
            txHashes.set(user, txHash);
          }
        } else {
          logger.logMessage(`  WARNING: TX status=${txResult.status}, no return value`);
          for (const r of batch) {
            txHashes.set(r.user, txHash);
          }
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.logMessage(`  Batch ${batchNum} FAILED: ${errorMsg}`);

        for (const recipient of batch) {
          const before = balancesBefore.get(recipient.user) ?? 0n;
          failedUsers.add(recipient.user);
          failedCount++;
          logger.logEntry({
            vault: vaultId,
            user: recipient.user,
            amount_sent: recipient.amount.toString(),
            df_tokens_received: "0",
            df_balance_before: before.toString(),
            df_balance_after: before.toString(),
            df_balance_delta: "0",
            tx_hash: "",
            batch_number: batchNum,
            status: `failed: ${errorMsg}`,
          });
        }
      }
    }

    // 2c. Post-fetch dfToken balances (once for all users of this vault)
    logger.logMessage("  Fetching dfToken balances after...");
    const balancesAfter = await fetchBalances(vaultId, users, sourcePublicKey);

    // 2d. Build log entries and display comparison table
    logger.logMessage("");
    logger.logMessage("  Results:");
    logger.logMessage("  " + "-".repeat(130));
    logger.logMessage(
      `  ${"User".padEnd(16)} ${"Batch".padStart(5)} ${"Amt Sent".padStart(14)} ${"dfTok Recv".padStart(14)} ${"Bal Before".padStart(14)} ${"Bal After".padStart(14)} ${"Delta".padStart(14)}`
    );
    logger.logMessage("  " + "-".repeat(130));

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      const batchNum = batchIdx + 1;

      for (const recipient of batch) {
        if (failedUsers.has(recipient.user)) continue;

        const before = balancesBefore.get(recipient.user) ?? 0n;
        const after = balancesAfter.get(recipient.user) ?? 0n;
        const delta = after - before;
        const contractDf = allDfTokensFromContract.get(recipient.user) ?? 0n;
        const txHash = txHashes.get(recipient.user) ?? "";

        const deltaMatch = delta === contractDf;
        const marker = deltaMatch ? "" : " MISMATCH";

        logger.logMessage(
          `  ${recipient.user.substring(0, 16)} ${batchNum.toString().padStart(5)} ${recipient.amount.toString().padStart(14)} ${contractDf.toString().padStart(14)} ${before.toString().padStart(14)} ${after.toString().padStart(14)} ${delta.toString().padStart(14)}${marker}`
        );

        successCount++;
        totalDfReceived += contractDf;
        totalDelta += delta;
        logger.logEntry({
          vault: vaultId,
          user: recipient.user,
          amount_sent: recipient.amount.toString(),
          df_tokens_received: contractDf.toString(),
          df_balance_before: before.toString(),
          df_balance_after: after.toString(),
          df_balance_delta: delta.toString(),
          tx_hash: txHash,
          batch_number: batchNum,
          status: "success",
        });
      }
    }

    logger.logMessage("  " + "-".repeat(130));
  }

  // 3. Summary
  const totalEntries = successCount + failedCount;
  logger.logMessage("");
  logger.logMessage("=".repeat(60));
  logger.logMessage("Summary");
  logger.logMessage("=".repeat(60));
  logger.logMessage(`Vaults processed: ${vaultGroups.size}`);
  logger.logMessage(`Recipients: ${totalEntries} (${successCount} ok, ${failedCount} failed)`);
  logger.logMessage(`Total dfTokens received (contract): ${totalDfReceived}`);
  logger.logMessage(`Total dfTokens delta (balance):     ${totalDelta}`);
  if (totalDfReceived !== totalDelta) {
    logger.logMessage(`Discrepancy: ${totalDelta - totalDfReceived}`);
  }
  logger.logMessage("=".repeat(60));
  logger.logMessage(`CSV log: ${logger.csvFilePath}`);
  logger.logMessage(`Full log: ${logger.logFilePath}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

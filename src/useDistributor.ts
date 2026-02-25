import * as StellarSdk from "@stellar/stellar-sdk";
import { Address, xdr, Keypair, Contract, TransactionBuilder, rpc, nativeToScVal } from "@stellar/stellar-sdk";
import { config } from "dotenv";
import * as fs from "fs";
import * as path from "path";
import {
  getNetworkPassphrase,
  rpcServer,
  sendTransaction,
  simulateContractCall,
  getOutputPath,
  batchArray,
  BATCH_SIZE,
} from "./utils";

config();

// ── Constants ──
const DISTRIBUTOR_TESTNET = "CA6LUTIXZN4GYUOQN6EGNQS3WLSMMIRQKEGI36EFK725AEKXQPI6G3VY";
const DISTRIBUTOR_MAINNET = "CD5Q6Z3..."  //Waiting for the actual development of the mainnet version of the contract to be deployed and verified before adding the address here.

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

interface TransferLogEntry {
  vault: string;
  user: string;
  amount_sent: string;
  df_tokens_received: string;
  df_balance_before: string;
  df_balance_after: string;
  df_balance_delta: string;
  tx_hash: string;
  batch_number: number;
  status: string;
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

  const hasRequired = header.includes("vault") && header.includes("asset") && header.includes("user") && header.includes("amount");
  if (!hasRequired) {
    throw new Error(
      'CSV format not recognized. Expected columns: "vault", "asset", "user", "amount"'
    );
  }

  const vaultIdx = header.indexOf("vault");
  const assetIdx = header.indexOf("asset");
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
      vault: values[vaultIdx],
      asset: values[assetIdx],
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
  vaultAddress: string,
  tokenAddress: string,
  recipients: { user: string; amount: bigint }[]
): StellarSdk.xdr.Operation {
  const distributorContract = new Contract(DISTRIBUTOR_TESTNET);

  const recipientsScVal = xdr.ScVal.scvVec(
    recipients.map((r) =>
      xdr.ScVal.scvVec([
        new Address(r.user).toScVal(),
        nativeToScVal(r.amount, { type: "i128" }),
      ])
    )
  );

  return distributorContract.call(
    "distribute",
    new Address(callerAddress).toScVal(),
    new Address(vaultAddress).toScVal(),
    new Address(tokenAddress).toScVal(),
    recipientsScVal
  );
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
  const secretKey = process.env.STELLAR_SECRET_KEY;

  if (!secretKey) throw new Error("STELLAR_SECRET_KEY environment variable is required");
  if (!process.env.SOROBAN_RPC) throw new Error("SOROBAN_RPC environment variable is required");

  const sourceKeypair = Keypair.fromSecret(secretKey);
  const sourcePublicKey = sourceKeypair.publicKey();

  console.log("=".repeat(60));
  console.log("DeFindex Distributor (deposit + distribute)");
  console.log("=".repeat(60));
  console.log(`Caller:      ${sourcePublicKey}`);
  console.log(`Distributor: ${DISTRIBUTOR_TESTNET}`);
  console.log(`Input CSV:   ${csvPath}`);
  console.log("");

  // 1. Parse CSV and group by vault
  const records = parseCSV(csvPath);
  const vaultGroups = groupByVault(records);

  console.log(`Total records: ${records.length}`);
  console.log(`Vaults: ${vaultGroups.size}`);
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log("");

  if (records.length === 0) {
    console.log("No valid records to process.");
    return;
  }

  const transferLog: TransferLogEntry[] = [];

  // 2. Process each vault
  for (const [vaultId, group] of vaultGroups) {
    const totalAmount = group.recipients.reduce((sum, r) => sum + r.amount, 0n);
    const users = group.recipients.map((r) => r.user);
    const batches = batchArray(group.recipients, BATCH_SIZE);

    console.log("-".repeat(60));
    console.log(`Vault: ${vaultId}`);
    console.log(`Asset: ${group.asset}`);
    console.log(`Recipients: ${group.recipients.length} | Total amount: ${totalAmount}`);
    console.log(`Batches: ${batches.length} (batch size: ${BATCH_SIZE})`);
    console.log("");

    // 2a. Pre-fetch dfToken balances (once for all users of this vault)
    console.log("  Fetching dfToken balances before...");
    const balancesBefore = await fetchBalances(vaultId, users, sourcePublicKey);
    for (const [user, bal] of balancesBefore) {
      console.log(`    ${user.substring(0, 12)}... balance: ${bal}`);
    }
    console.log("");

    // 2b. Process each batch
    const allDfTokensFromContract = new Map<string, bigint>();
    const txHashes = new Map<string, string>(); // user -> txHash

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      const batchNum = batchIdx + 1;
      const batchTotal = batch.reduce((sum, r) => sum + r.amount, 0n);

      console.log(`  Batch ${batchNum}/${batches.length} (${batch.length} recipients, total: ${batchTotal})`);
      console.log("  Building distribute transaction...");

      const operation = buildDistributeOperation(
        sourcePublicKey,
        vaultId,
        group.asset,
        batch
      );

      try {
        const txHash = await buildAndSendTx(sourceKeypair, operation);
        console.log(`  TX confirmed: ${txHash}`);

        // Parse contract return value
        const txResult = await rpcServer.getTransaction(txHash);
        if (txResult.status === "SUCCESS" && txResult.returnValue) {
          const batchDfTokens = parseContractResult(txResult.returnValue);
          console.log(`  Contract returned dfTokens for batch ${batchNum}:`);
          for (const [user, tokens] of batchDfTokens) {
            console.log(`    ${user.substring(0, 12)}... → ${tokens}`);
            allDfTokensFromContract.set(user, tokens);
            txHashes.set(user, txHash);
          }
        } else {
          console.warn(`  WARNING: TX status=${txResult.status}, no return value`);
          for (const r of batch) {
            txHashes.set(r.user, txHash);
          }
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`  Batch ${batchNum} FAILED: ${errorMsg}`);

        for (const recipient of batch) {
          const before = balancesBefore.get(recipient.user) ?? 0n;
          transferLog.push({
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

      console.log("");
    }

    // 2c. Post-fetch dfToken balances (once for all users of this vault)
    console.log("  Fetching dfToken balances after...");
    const balancesAfter = await fetchBalances(vaultId, users, sourcePublicKey);

    // 2d. Build log entries and display comparison table
    console.log("");
    console.log("  Results:");
    console.log("  " + "-".repeat(130));
    console.log(
      `  ${"User".padEnd(16)} ${"Batch".padStart(5)} ${"Amt Sent".padStart(14)} ${"dfTok Recv".padStart(14)} ${"Bal Before".padStart(14)} ${"Bal After".padStart(14)} ${"Delta".padStart(14)}`
    );
    console.log("  " + "-".repeat(130));

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      const batchNum = batchIdx + 1;

      for (const recipient of batch) {
        // Skip users already logged as failed in their batch
        const alreadyLogged = transferLog.some(
          (e) => e.vault === vaultId && e.user === recipient.user && e.batch_number === batchNum
        );
        if (alreadyLogged) continue;

        const before = balancesBefore.get(recipient.user) ?? 0n;
        const after = balancesAfter.get(recipient.user) ?? 0n;
        const delta = after - before;
        const contractDf = allDfTokensFromContract.get(recipient.user) ?? 0n;
        const txHash = txHashes.get(recipient.user) ?? "";

        const deltaMatch = delta === contractDf;
        const marker = deltaMatch ? "" : " MISMATCH";

        console.log(
          `  ${recipient.user.substring(0, 16)} ${batchNum.toString().padStart(5)} ${recipient.amount.toString().padStart(14)} ${contractDf.toString().padStart(14)} ${before.toString().padStart(14)} ${after.toString().padStart(14)} ${delta.toString().padStart(14)}${marker}`
        );

        transferLog.push({
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

    console.log("  " + "-".repeat(130));
    console.log("");
  }

  // 3. Write CSV log
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = getOutputPath("distributor", `distributor_${ts}.csv`);
  const logContent = [
    "vault,user,amount_sent,df_tokens_received,df_balance_before,df_balance_after,df_balance_delta,tx_hash,batch_number,status",
    ...transferLog.map(
      (e) =>
        `${e.vault},${e.user},${e.amount_sent},${e.df_tokens_received},${e.df_balance_before},${e.df_balance_after},${e.df_balance_delta},${e.tx_hash},${e.batch_number},"${e.status}"`
    ),
  ].join("\n");
  fs.writeFileSync(logPath, logContent);
  console.log(`Log written to: ${logPath}`);

  // 4. Summary
  const successCount = transferLog.filter((e) => e.status === "success").length;
  const failedCount = transferLog.filter((e) => e.status !== "success").length;
  const totalDfReceived = transferLog
    .filter((e) => e.status === "success")
    .reduce((sum, e) => sum + BigInt(e.df_tokens_received), 0n);
  const totalDelta = transferLog
    .filter((e) => e.status === "success")
    .reduce((sum, e) => sum + BigInt(e.df_balance_delta), 0n);

  console.log("");
  console.log("=".repeat(60));
  console.log("Summary");
  console.log("=".repeat(60));
  console.log(`Vaults processed: ${vaultGroups.size}`);
  console.log(`Recipients: ${transferLog.length} (${successCount} ok, ${failedCount} failed)`);
  console.log(`Total dfTokens received (contract): ${totalDfReceived}`);
  console.log(`Total dfTokens delta (balance):     ${totalDelta}`);
  if (totalDfReceived !== totalDelta) {
    console.log(`Discrepancy: ${totalDelta - totalDfReceived}`);
  }
  console.log("=".repeat(60));
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

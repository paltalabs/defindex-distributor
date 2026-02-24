import * as StellarSdk from "@stellar/stellar-sdk";
import { Address, xdr, Keypair } from "@stellar/stellar-sdk";
import { config } from "dotenv";
import * as fs from "fs";
import * as path from "path";
import {
  BATCH_SIZE,
  Invocation,
  simulateContractCall,
  buildRouterTransaction,
  sendTransaction,
  batchArray,
  rpcServer,
  getOutputPath,
} from "./utils";

config();

// Types
interface DistributionRecord {
  vault_id: string;
  user_address: string;
  underlying_amount: string;
  df_tokens_to_receive: string;
}

interface TransferLogEntry {
  vault_id: string;
  user_address: string;
  df_tokens_transferred: string;
  tx_hash: string;
  batch_number: number;
  timestamp: string;
  status: string;
}

// Parse distribution CSV
function parseDistributionCSV(filePath: string): DistributionRecord[] {
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
  const vaultIdx = header.indexOf("vault_id");
  const userIdx = header.indexOf("user_address");
  const lostIdx = header.indexOf("underlying_amount");
  const dfTokensIdx = header.indexOf("df_tokens_to_receive");

  if (vaultIdx === -1 || userIdx === -1 || dfTokensIdx === -1) {
    throw new Error('CSV must have "vault_id", "user_address", and "df_tokens_to_receive" columns');
  }

  const records: DistributionRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = line.split(",").map((v) => v.trim());

    const dfTokens = BigInt(values[dfTokensIdx]);
    if (dfTokens <= 0n) {
      console.warn(`Skipping row ${i + 1}: zero or negative dfTokens`);
      continue;
    }

    records.push({
      vault_id: values[vaultIdx],
      user_address: values[userIdx],
      underlying_amount: values[lostIdx] ?? "0",
      df_tokens_to_receive: values[dfTokensIdx],
    });
  }

  return records;
}

// Create transfer invocation for a specific vault
function createTransferInvocation(
  vaultId: string,
  from: string,
  to: string,
  amount: bigint
): Invocation {
  return {
    contract: new Address(vaultId),
    method: "transfer",
    args: [
      new Address(from).toScVal(),
      new Address(to).toScVal(),
      StellarSdk.nativeToScVal(amount, { type: "i128" }),
    ],
    can_fail: false,
  };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage: pnpm distribute <distribution.csv>");
    console.error("");
    console.error("CSV columns: vault_id,user_address,underlying_amount,df_tokens_to_receive");
    process.exit(1);
  }

  const csvPath = args[0];
  const secretKey = process.env.STELLAR_SECRET_KEY;

  if (!secretKey) throw new Error("STELLAR_SECRET_KEY environment variable is required");
  if (!process.env.SOROBAN_RPC) throw new Error("SOROBAN_RPC environment variable is required");

  const sourceKeypair = Keypair.fromSecret(secretKey);
  const sourcePublicKey = sourceKeypair.publicKey();

  console.log("=".repeat(60));
  console.log("DeFindex dfToken Distribution");
  console.log("=".repeat(60));
  console.log(`Source Account: ${sourcePublicKey}`);
  console.log(`Distribution CSV: ${csvPath}`);
  console.log("");

  // Parse distribution CSV
  const records = parseDistributionCSV(csvPath);
  console.log(`Total distribution records: ${records.length}`);
  console.log("");

  if (records.length === 0) {
    console.log("No valid records to process.");
    return;
  }

  // Group by vault for summary
  const vaultGroups: Record<string, DistributionRecord[]> = {};
  for (const record of records) {
    if (!vaultGroups[record.vault_id]) {
      vaultGroups[record.vault_id] = [];
    }
    vaultGroups[record.vault_id].push(record);
  }

  // Verify balances per vault
  console.log("Verifying dfToken balances per vault...");
  for (const vaultId of Object.keys(vaultGroups)) {
    const vaultRecords = vaultGroups[vaultId];
    const totalNeeded = vaultRecords.reduce(
      (sum, r) => sum + BigInt(r.df_tokens_to_receive),
      0n
    );

    const balanceResult = await simulateContractCall(
      vaultId,
      "balance",
      [new Address(sourcePublicKey).toScVal()],
      sourcePublicKey
    );
    const balance = BigInt(balanceResult as string | number);

    const status = balance >= totalNeeded ? "OK" : "INSUFFICIENT";
    console.log(
      `  ${vaultId}: balance=${balance}, needed=${totalNeeded} [${status}]`
    );

    if (balance < totalNeeded) {
      console.error(`  WARNING: Cannot distribute for vault ${vaultId}`);
    }
  }
  console.log("");

  // Batch all transfers (across vaults)
  const batches = batchArray(records, BATCH_SIZE);
  console.log(`Total batches: ${batches.length} (${BATCH_SIZE} transfers per batch)`);
  console.log("");

  const transferLog: TransferLogEntry[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`Batch ${i + 1}/${batches.length} (${batch.length} transfers):`);

    const invocations = batch.map((record) =>
      createTransferInvocation(
        record.vault_id,
        sourcePublicKey,
        record.user_address,
        BigInt(record.df_tokens_to_receive)
      )
    );

    // Show batch details
    for (const record of batch) {
      console.log(
        `  -> ${record.user_address} (vault ${record.vault_id.substring(0, 8)}...): ${record.df_tokens_to_receive} dfTokens`
      );
    }

    try {
      const tx = await buildRouterTransaction(sourceKeypair, invocations);
      const txHash = await sendTransaction(tx);
      console.log(`  Batch ${i + 1} completed: ${txHash}`);

      const now = new Date().toISOString();
      for (const record of batch) {
        transferLog.push({
          vault_id: record.vault_id,
          user_address: record.user_address,
          df_tokens_transferred: record.df_tokens_to_receive,
          tx_hash: txHash,
          batch_number: i + 1,
          timestamp: now,
          status: "success",
        });
      }
    } catch (error) {
      console.error(`  Batch ${i + 1} FAILED:`, error);

      const now = new Date().toISOString();
      for (const record of batch) {
        transferLog.push({
          vault_id: record.vault_id,
          user_address: record.user_address,
          df_tokens_transferred: record.df_tokens_to_receive,
          tx_hash: "",
          batch_number: i + 1,
          timestamp: now,
          status: "failed",
        });
      }

      // Don't throw — continue with remaining batches
      console.error(`  Continuing with remaining batches...`);
    }

    console.log("");
  }

  // Write transfer log CSV
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = getOutputPath("distributions", `distributor_${ts}_log.csv`);
  const logContent = [
    "vault_id,user_address,df_tokens_transferred,tx_hash,batch_number,timestamp,status",
    ...transferLog.map(
      (e) =>
        `${e.vault_id},${e.user_address},${e.df_tokens_transferred},${e.tx_hash},${e.batch_number},${e.timestamp},${e.status}`
    ),
  ].join("\n");
  fs.writeFileSync(logPath, logContent);
  console.log(`Transfer log written to: ${logPath}`);

  // Final statistics
  const successCount = transferLog.filter((e) => e.status === "success").length;
  const failedCount = transferLog.filter((e) => e.status === "failed").length;
  const totalTransferred = transferLog
    .filter((e) => e.status === "success")
    .reduce((sum, e) => sum + BigInt(e.df_tokens_transferred), 0n);

  console.log("");
  console.log("=".repeat(60));
  console.log("Distribution Summary");
  console.log("=".repeat(60));
  console.log(`Total transfers: ${transferLog.length}`);
  console.log(`  Successful: ${successCount}`);
  console.log(`  Failed: ${failedCount}`);
  console.log(`Total dfTokens transferred: ${totalTransferred}`);
  console.log(`Batches executed: ${batches.length}`);
  console.log("");

  // Per-vault stats
  console.log("Per-vault statistics:");
  console.log("-".repeat(80));
  for (const vaultId of Object.keys(vaultGroups)) {
    const vaultTransfers = transferLog.filter((e) => e.vault_id === vaultId);
    const vaultSuccess = vaultTransfers.filter((e) => e.status === "success");
    const vaultTotal = vaultSuccess.reduce(
      (sum, e) => sum + BigInt(e.df_tokens_transferred),
      0n
    );
    console.log(
      `  ${vaultId}: ${vaultSuccess.length}/${vaultTransfers.length} OK, ${vaultTotal} dfTokens`
    );
  }
  console.log("=".repeat(60));
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

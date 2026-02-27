import * as StellarSdk from "@stellar/stellar-sdk";
import { Address, xdr, Keypair, Contract, TransactionBuilder, rpc, nativeToScVal } from "@stellar/stellar-sdk";
import { config } from "dotenv";
import * as fs from "fs";
import * as path from "path";
import {
  getNetwork,
  getNetworkPassphrase,
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

// ── Constants ──

const TOKEN_DECIMALS = 7;
const TOKEN_DIVISOR = 10n ** BigInt(TOKEN_DECIMALS);

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

/** Accumulated results from sending all batches for a single vault */
interface BatchResults {
  dfTokensFromContract: Map<string, bigint>;
  underlyingReceived: Map<string, bigint>;
  txHashes: Map<string, string>;
  failedUsers: Set<string>;
  failedCount: number;
}

/** Conversion rate reference for dfToken → underlying */
interface ConversionRate {
  referenceDfTokens: bigint;
  referenceUnderlying: bigint;
}

/** Accumulated counters across all vaults */
interface VaultCounters {
  successCount: number;
  failedCount: number;
  totalUnderlyingSent: bigint;
  totalUnderlyingReceived: bigint;
}

// ── Formatting Helpers ──

/** Converts a raw stroops amount (bigint) to a human-readable string with 7 decimals */
function formatTokenAmount(stroops: bigint): string {
  const whole = stroops / TOKEN_DIVISOR;
  const frac = (stroops < 0n ? -stroops : stroops) % TOKEN_DIVISOR;
  return `${whole}.${frac.toString().padStart(TOKEN_DECIMALS, "0")}`;
}

// ── Config ──

function getDistributorAddress(): string {
  return getNetwork() === "mainnet" ? DISTRIBUTOR_MAINNET : DISTRIBUTOR_TESTNET;
}

// ── CSV Parsing ──

/** Parses a CSV file with columns: vault, asset, user, amount */
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

/** Groups CSV records by vault address */
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

// ── Asset & Conversion Helpers ──

/** Fetches the symbol of a Stellar token contract. Falls back to truncated address. */
async function fetchAssetSymbol(assetAddress: string, callerPublicKey: string): Promise<string> {
  try {
    const result = await simulateContractCall(assetAddress, "symbol", [], callerPublicKey);
    return String(result);
  } catch {
    return assetAddress.substring(0, 8) + "...";
  }
}

/** Calls `get_asset_amounts_per_shares` on a vault to convert dfTokens → underlying (first asset). */
async function getAssetAmountsPerShares(
  vaultId: string,
  dfTokenAmount: bigint,
  callerPublicKey: string,
): Promise<bigint> {
  const result = await simulateContractCall(
    vaultId,
    "get_asset_amounts_per_shares",
    [nativeToScVal(dfTokenAmount, { type: "i128" })],
    callerPublicKey,
  );
  const amounts = result as bigint[];
  return BigInt(amounts[0]);
}

/** Queries the vault for a reference conversion rate using 10 full tokens of dfToken. */
async function fetchConversionRate(
  vaultId: string,
  callerPublicKey: string,
): Promise<ConversionRate> {
  const referenceDfTokens = 10n * TOKEN_DIVISOR;
  const referenceUnderlying = await getAssetAmountsPerShares(vaultId, referenceDfTokens, callerPublicKey);
  return { referenceDfTokens, referenceUnderlying };
}

/** Converts a dfToken amount to underlying using a pre-fetched conversion rate. */
function dfTokensToUnderlying(dfTokens: bigint, rate: ConversionRate): bigint {
  return (dfTokens * rate.referenceUnderlying) / rate.referenceDfTokens;
}

// ── Transaction Building ──

/** Builds the Soroban "distribute" operation for a batch of recipients */
function buildDistributeOperation(
  callerAddress: string,
  assetAddress: string,
  vaultAddress: string,
  recipients: { user: string; amount: bigint }[]
): StellarSdk.xdr.Operation {
  const distributorContract = new Contract(getDistributorAddress());

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

/** Builds, simulates, signs and submits a transaction. Returns the tx hash */
async function buildAndSendTx(
  sourceKeypair: Keypair,
  operation: StellarSdk.xdr.Operation,
  xdrMode: boolean = false
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

  if (xdrMode) {
    const unsignedXdr = preparedTx.toEnvelope().toXDR("base64");
    console.log("\n--- Unsigned XDR ---");
    console.log(unsignedXdr);
  }

  preparedTx.sign(sourceKeypair);

  if (xdrMode) {
    const signedXdr = preparedTx.toEnvelope().toXDR("base64");
    console.log("\n--- Signed XDR ---");
    console.log(signedXdr);
    console.log("");
  }

  return sendTransaction(preparedTx);
}

// ── Result Parsing ──

/** Parses the contract return value into a map of user → dfTokens minted */
function parseContractResult(returnValue: xdr.ScVal): Map<string, bigint> {
  const result = new Map<string, bigint>();
  const tuples = StellarSdk.scValToNative(returnValue) as Array<[string, bigint]>;

  for (const [address, dfTokens] of tuples) {
    result.set(address, BigInt(dfTokens));
  }

  return result;
}

// ── Batch Processing ──

/** Sends all batches for a vault and collects contract results.
 *  Logs failed recipients to the CSV logger. */
async function sendVaultBatches(
  batches: { user: string; amount: bigint }[][],
  vaultId: string,
  group: VaultGroup,
  sourceKeypair: Keypair,
  assetSymbol: string,
  logger: Logger,
  xdrMode: boolean = false,
): Promise<BatchResults> {
  const sourcePublicKey = sourceKeypair.publicKey();
  const dfTokensFromContract = new Map<string, bigint>();
  const underlyingReceivedMap = new Map<string, bigint>();
  const txHashes = new Map<string, string>();
  const failedUsers = new Set<string>();
  let failedCount = 0;

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const batchNum = batchIdx + 1;
    const batchTotal = batch.reduce((sum, r) => sum + r.amount, 0n);

    logger.logMessage(`  Batch ${batchNum}/${batches.length} (${batch.length} recipients, total: ${batchTotal})`);
    logger.logMessage("  Building distribute transaction...");

    const operation = buildDistributeOperation(sourcePublicKey, group.asset, vaultId, batch);

    try {
      const txHash = await buildAndSendTx(sourceKeypair, operation, xdrMode);
      logger.logMessage(`  TX confirmed: ${txHash}`);

      const txResult = await getRpcServer().getTransaction(txHash);
      if (txResult.status === "SUCCESS" && txResult.returnValue) {
        const batchDfTokens = parseContractResult(txResult.returnValue);

        // Fetch conversion rate right after this batch
        const rate = await fetchConversionRate(vaultId, sourcePublicKey);
        logger.logMessage(`  Batch ${batchNum} rate: 10 dfTokens = ${formatTokenAmount(rate.referenceUnderlying)} ${assetSymbol}`);

        logger.logMessage(`  Contract returned dfTokens for batch ${batchNum}:`);
        for (const [user, tokens] of batchDfTokens) {
          const underlying = dfTokensToUnderlying(tokens, rate);
          logger.logMessage(`    ${user.substring(0, 12)}... → ${tokens} dfTokens (≈ ${formatTokenAmount(underlying)} ${assetSymbol})`);
          dfTokensFromContract.set(user, tokens);
          underlyingReceivedMap.set(user, underlying);
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
        failedUsers.add(recipient.user);
        failedCount++;
        logger.logEntry({
          vault: vaultId,
          user: recipient.user,
          asset_symbol: assetSymbol,
          amount_sent: recipient.amount.toString(),
          df_tokens_received: "0",
          underlying_received: "0",
          tx_hash: "",
          batch_number: batchNum,
          status: `failed: ${errorMsg}`,
        });
      }
    }
  }

  return { dfTokensFromContract, underlyingReceived: underlyingReceivedMap, txHashes, failedUsers, failedCount };
}

// ── Results Table ──

/** Prints the results comparison table and logs each successful recipient to CSV */
function logResultsTable(
  batches: { user: string; amount: bigint }[][],
  vaultId: string,
  failedUsers: Set<string>,
  dfTokensFromContract: Map<string, bigint>,
  underlyingReceivedMap: Map<string, bigint>,
  txHashes: Map<string, string>,
  assetSymbol: string,
  logger: Logger,
): { successCount: number; totalUnderlyingSent: bigint; totalUnderlyingReceived: bigint } {
  const sym = assetSymbol;
  const header =
    `  ${"User".padEnd(16)} ${"Batch".padStart(5)} ` +
    `${(sym + " Sent(strps)").padStart(20)} ` +
    `${"dfTokens Recv(strps)".padStart(22)} ` +
    `${(sym + " Recv(calc)").padStart(18)} ` +
    `${"Sent/Recv Δ".padStart(18)}`;
  const SEP = "  " + "-".repeat(header.length);

  logger.logMessage("");
  logger.logMessage("  Results:");
  logger.logMessage(SEP);
  logger.logMessage(header);
  logger.logMessage(SEP);

  let successCount = 0;
  let totalUnderlyingSent = 0n;
  let totalUnderlyingReceived = 0n;

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const batchNum = batchIdx + 1;

    for (const recipient of batch) {
      if (failedUsers.has(recipient.user)) continue;

      const contractDf = dfTokensFromContract.get(recipient.user) ?? 0n;
      const txHash = txHashes.get(recipient.user) ?? "";
      const underlyingReceived = underlyingReceivedMap.get(recipient.user) ?? 0n;
      const delta = underlyingReceived - recipient.amount;

      logger.logMessage(
        `  ${recipient.user.substring(0, 16)} ` +
        `${batchNum.toString().padStart(5)} ` +
        `${recipient.amount.toString().padStart(20)} ` +
        `${contractDf.toString().padStart(22)} ` +
        `${formatTokenAmount(underlyingReceived).padStart(18)} ` +
        `${formatTokenAmount(delta).padStart(18)}`
      );

      successCount++;
      totalUnderlyingSent += recipient.amount;
      totalUnderlyingReceived += underlyingReceived;
      logger.logEntry({
        vault: vaultId,
        user: recipient.user,
        asset_symbol: assetSymbol,
        amount_sent: recipient.amount.toString(),
        df_tokens_received: contractDf.toString(),
        underlying_received: underlyingReceived.toString(),
        tx_hash: txHash,
        batch_number: batchNum,
        status: "success",
      });
    }
  }

  logger.logMessage(SEP);

  return { successCount, totalUnderlyingSent, totalUnderlyingReceived };
}

// ── Summary ──

/** Prints final summary with totals and log file paths */
function logSummary(
  logger: Logger,
  vaultCount: number,
  counters: VaultCounters,
  assetSymbol: string,
): void {
  const totalEntries = counters.successCount + counters.failedCount;
  const diff = counters.totalUnderlyingReceived - counters.totalUnderlyingSent;
  logger.logMessage("");
  logger.logMessage("=".repeat(60));
  logger.logMessage("Summary");
  logger.logMessage("=".repeat(60));
  logger.logMessage(`Vaults processed: ${vaultCount}`);
  logger.logMessage(`Recipients: ${totalEntries} (${counters.successCount} ok, ${counters.failedCount} failed)`);
  logger.logMessage(`Total underlying sent:     ${formatTokenAmount(counters.totalUnderlyingSent)} ${assetSymbol}`);
  logger.logMessage(`Total underlying received: ${formatTokenAmount(counters.totalUnderlyingReceived)} ${assetSymbol}`);
  logger.logMessage(`Difference:                ${formatTokenAmount(diff)} ${assetSymbol}`);
  logger.logMessage("=".repeat(60));
  logger.logMessage(`CSV log: ${logger.csvFilePath}`);
  logger.logMessage(`Full log: ${logger.logFilePath}`);
}

// ── Main ──

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage: pnpm use-distributor <demo.csv> [--xdr]");
    console.error("");
    console.error("CSV columns: vault,asset,user,amount");
    console.error("Calls the Distributor contract to deposit + distribute in one tx per vault.");
    console.error("  --xdr  Print unsigned and signed XDR for each transaction (debugging)");
    process.exit(1);
  }

  const xdrMode = args.includes("--xdr");
  const csvPath = args.find((a) => !a.startsWith("--"))!;
  const secretKey = await getSecretKey();
  const sourceKeypair = Keypair.fromSecret(secretKey);
  const sourcePublicKey = sourceKeypair.publicKey();

  // Print banner
  console.log("=".repeat(60));
  console.log("DeFindex Distributor (deposit + distribute)");
  console.log("=".repeat(60));
  console.log(`Caller:      ${sourcePublicKey}`);
  console.log(`Network:     ${getNetwork()}`);
  console.log(`Distributor: ${getDistributorAddress()}`);
  console.log(`Input CSV:   ${csvPath}`);
  console.log("");

  // Parse CSV and group records by vault
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

  const counters: VaultCounters = {
    successCount: 0,
    failedCount: 0,
    totalUnderlyingSent: 0n,
    totalUnderlyingReceived: 0n,
  };

  let lastAssetSymbol = "";

  // Process each vault: send batches → fetch conversion rate → compare results
  for (const [vaultId, group] of vaultGroups) {
    const totalAmount = group.recipients.reduce((sum, r) => sum + r.amount, 0n);
    const batches = batchArray(group.recipients, BATCH_MAX_SIZE);

    logger.logMessage("-".repeat(60));
    logger.logMessage(`Vault: ${vaultId}`);
    logger.logMessage(`Asset: ${group.asset}`);
    logger.logMessage(`Recipients: ${group.recipients.length} | Total amount: ${totalAmount}`);
    logger.logMessage(`Batches: ${batches.length} (max batch size: ${BATCH_MAX_SIZE})`);

    // Fetch asset symbol
    const assetSymbol = await fetchAssetSymbol(group.asset, sourcePublicKey);
    lastAssetSymbol = assetSymbol;
    logger.logMessage(`  Asset symbol: ${assetSymbol}`);

    // Send all batches for this vault (conversion rate fetched per batch inside)
    const batchResults = await sendVaultBatches(batches, vaultId, group, sourceKeypair, assetSymbol, logger, xdrMode);
    counters.failedCount += batchResults.failedCount;

    // Print results comparison table and log successful entries
    const tableResults = logResultsTable(
      batches, vaultId, batchResults.failedUsers,
      batchResults.dfTokensFromContract, batchResults.underlyingReceived,
      batchResults.txHashes, assetSymbol,
      logger,
    );
    counters.successCount += tableResults.successCount;
    counters.totalUnderlyingSent += tableResults.totalUnderlyingSent;
    counters.totalUnderlyingReceived += tableResults.totalUnderlyingReceived;
  }

  // Print final summary
  logSummary(logger, vaultGroups.size, counters, lastAssetSymbol);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

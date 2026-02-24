import * as StellarSdk from "@stellar/stellar-sdk";
import { Address, xdr, Keypair } from "@stellar/stellar-sdk";
import { config } from "dotenv";
import * as fs from "fs";
import * as path from "path";
import {
  BATCH_SIZE,
  rpcServer,
  Invocation,
  StrategyReport,
  TransferRecord,
  simulateContractCall,
  simulateMultipleInvocations,
  buildRouterTransaction,
  sendTransaction,
  batchArray,
  createVaultInvocation,
} from "./utils";

config();

// Constants
// const DEFINDEX_VAULT = "CC767WIU5QGJMXYHDDYJAJEF2YWPHOXOZDWD3UUAZVS4KQPRXCKPT2YZ"; // SeevcashVault
const DEFINDEX_VAULT = "CA2FIPJ7U6BG3N7EOZFI74XPJZOEOD4TYWXFVCIO5VDCHTVAGS6F4UKK"; // SoroswapVault

// Locked Fees Calculation
function sumLockedFeesFromReport(report: StrategyReport[]): bigint {
  if (!report || !Array.isArray(report)) {
    return BigInt(0);
  }

  try {
    return report.reduce((acc: bigint, strategy: StrategyReport) => {
      const lockedFee = strategy?.locked_fees ?? strategy?.locked_fee ?? strategy?.lockedFee ?? 0;
      return acc + BigInt(lockedFee);
    }, BigInt(0));
  } catch (e) {
    console.warn('Failed to sum locked fees from report:', e);
    return BigInt(0);
  }
}

function calculateLockedFeesDelta(beforeReport: StrategyReport[], afterReport: StrategyReport[]): bigint {
  const lockedFeesBeforeLocking = sumLockedFeesFromReport(beforeReport);
  const lockedFeesAfterLocking = sumLockedFeesFromReport(afterReport);

  const delta = lockedFeesAfterLocking - lockedFeesBeforeLocking;
  return delta >= BigInt(0) ? delta : BigInt(0);
}

// CSV Parsing
function parseCSV(filePath: string): TransferRecord[] {
  const absolutePath = path.resolve(filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`CSV file not found: ${absolutePath}`);
  }

  const content = fs.readFileSync(absolutePath, 'utf-8');
  const lines = content.trim().split('\n');

  if (lines.length < 2) {
    throw new Error('CSV file must have a header row and at least one data row');
  }

  const header = lines[0].toLowerCase().split(',').map(h => h.trim());
  const addressIndex = header.indexOf('address');
  const amountIndex = header.indexOf('amount');

  if (addressIndex === -1 || amountIndex === -1) {
    throw new Error('CSV must have "address" and "amount" columns');
  }

  const records: TransferRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = line.split(',').map(v => v.trim());
    const address = values[addressIndex];
    const amount = parseFloat(values[amountIndex]);

    if (!address || isNaN(amount)) {
      console.warn(`Skipping invalid row ${i + 1}: ${line}`);
      continue;
    }

    if (!StellarSdk.StrKey.isValidEd25519PublicKey(address) && !address.startsWith('C')) {
      console.warn(`Skipping invalid address on row ${i + 1}: ${address}`);
      continue;
    }

    records.push({ address, amount });
  }

  return records;
}

// Get Vault Data for USDC to dfToken Conversion (optimized: 2 RPC calls instead of 5)
async function getVaultData(sourcePublicKey: string): Promise<{
  totalSupply: bigint;
  totalManagedFunds: bigint;
  lockedFeesDelta: bigint;
}> {
  console.log('Fetching vault data...');

  // Call 1: Get manager (needed as caller for report/lock_fees)
  const manager = await simulateContractCall(
    DEFINDEX_VAULT,
    'get_manager',
    [],
    sourcePublicKey
  ) as string;

  // Call 2: Batch all remaining calls via router
  // Order: report -> lock_fees -> total_supply -> fetch_total_managed_funds
  const batchedInvocations: Invocation[] = [
    createVaultInvocation(DEFINDEX_VAULT, 'report'),
    createVaultInvocation(DEFINDEX_VAULT, 'lock_fees', [xdr.ScVal.scvVoid()]),
    createVaultInvocation(DEFINDEX_VAULT, 'total_supply'),
    createVaultInvocation(DEFINDEX_VAULT, 'fetch_total_managed_funds'),
  ];

  const results = await simulateMultipleInvocations(batchedInvocations, manager);

  // Parse results: [0] = report, [1] = lock_fees, [2] = total_supply, [3] = fetch_total_managed_funds
  const beforeReport = results[0] as StrategyReport[];
  const afterReport = results[1] as StrategyReport[];
  const totalSupply = BigInt(results[2] as string | number);
  const totalManagedFundsData = results[3] as { total_amount?: string | number }[];
  const fundEntry = totalManagedFundsData[0];
  const totalManagedFunds = BigInt(
    typeof fundEntry === 'object' && fundEntry?.total_amount !== undefined
      ? fundEntry.total_amount
      : (fundEntry as unknown as string | number)
  );

  const lockedFeesDelta = calculateLockedFeesDelta(beforeReport, afterReport);

  console.log(`  Total Supply: ${totalSupply}`);
  console.log(`  Total Managed Funds: ${totalManagedFunds}`);
  console.log(`  Locked Fees Delta: ${lockedFeesDelta}`);

  return { totalSupply, totalManagedFunds, lockedFeesDelta };
}

// Convert USDC Amount to dfToken Amount
function usdcToDfTokens(
  usdcAmount: bigint,
  totalSupply: bigint,
  totalManagedFunds: bigint,
  lockedFeesDelta: bigint
): bigint {
  const adjustedTotalAmount = totalManagedFunds - lockedFeesDelta;

  if (adjustedTotalAmount <= BigInt(0)) {
    throw new Error('Invalid vault state: adjusted total amount is <= 0');
  }

  if (totalSupply === BigInt(0)) {
    return usdcAmount;
  }

  // Ceiling division: (usdcAmount * totalSupply + adjustedTotalAmount - 1) / adjustedTotalAmount
  return (usdcAmount * totalSupply + adjustedTotalAmount - BigInt(1)) / adjustedTotalAmount;
}

// Create Transfer Invocation
function createTransferInvocation(
  from: string,
  to: string,
  amount: bigint
): Invocation {
  return {
    contract: new Address(DEFINDEX_VAULT),
    method: 'transfer',
    args: [
      new Address(from).toScVal(),
      new Address(to).toScVal(),
      StellarSdk.nativeToScVal(amount, { type: 'i128' }),
    ],
    can_fail: false,
  };
}

// Main Function
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: pnpm transfer <accounts.csv>');
    console.error('');
    console.error('CSV format:');
    console.error('  address,amount');
    console.error('  GABC...,100');
    console.error('  GDEF...,50');
    process.exit(1);
  }

  const csvPath = args[0];
  const secretKey = process.env.STELLAR_SECRET_KEY;

  if (!secretKey) {
    throw new Error('STELLAR_SECRET_KEY environment variable is required');
  }

  if (!process.env.SOROBAN_RPC || !process.env.HORIZON_RPC) {
    throw new Error('SOROBAN_RPC and HORIZON_RPC environment variables are required');
  }

  const sourceKeypair = Keypair.fromSecret(secretKey);
  const sourcePublicKey = sourceKeypair.publicKey();
  console.log("🚀 | main | sourcePublicKey:", sourcePublicKey)

  console.log('='.repeat(60));
  console.log('dfTokens Transfer Campaign');
  console.log('='.repeat(60));
  console.log(`Source Account: ${sourcePublicKey}`);
  console.log(`Vault: ${DEFINDEX_VAULT}`);
  console.log(`Network: Mainnet`);
  console.log('');

  // Parse CSV
  console.log(`Reading CSV: ${csvPath}`);
  const records = parseCSV(csvPath);
  console.log(`Found ${records.length} transfer records`);
  console.log('');

  if (records.length === 0) {
    console.log('No valid records to process.');
    return;
  }

  // Get vault data for conversion
  const { totalSupply, totalManagedFunds, lockedFeesDelta } = await getVaultData(sourcePublicKey);

  // Get source account dfToken balance
  const balanceResult = await simulateContractCall(
    DEFINDEX_VAULT,
    'balance',
    [new Address(sourcePublicKey).toScVal()],
    sourcePublicKey
  );
  const sourceBalance = BigInt(balanceResult as string | number);
  console.log(`  Source dfToken Balance: ${sourceBalance}`);
  console.log('');

  // Convert USDC amounts to dfToken amounts
  console.log('Converting USDC amounts to dfToken amounts...');
  const transfers: { address: string; usdcAmount: bigint; dfTokenAmount: bigint }[] = [];

  for (const record of records) {
    // Assuming USDC has 7 decimals
    const usdcAmountRaw = BigInt(Math.floor(record.amount * 10_000_000));
    const dfTokenAmount = usdcToDfTokens(usdcAmountRaw, totalSupply, totalManagedFunds, lockedFeesDelta);

    transfers.push({
      address: record.address,
      usdcAmount: usdcAmountRaw,
      dfTokenAmount,
    });

    console.log(`  ${record.address}: ${record.amount} USDC -> ${dfTokenAmount} dfTokens`);
  }
  console.log('');

  // Batch transfers
  const batches = batchArray(transfers, BATCH_SIZE);
  console.log(`Would process ${batches.length} batch(es) of up to ${BATCH_SIZE} transfers each`);
  console.log('');

  // Summary
  const totalDfTokens = transfers.reduce((sum, t) => sum + t.dfTokenAmount, BigInt(0));
  const totalUsdc = transfers.reduce((sum, t) => sum + t.usdcAmount, BigInt(0));

  console.log('='.repeat(60));
  console.log('DRY RUN - No transactions will be sent');
  console.log('='.repeat(60));
  console.log('');
  console.log('Transfer Summary:');
  console.log(`  Total Recipients: ${transfers.length}`);
  console.log(`  Total USDC: ${Number(totalUsdc) / 10_000_000} USDC`);
  console.log(`  Total dfTokens: ${totalDfTokens}`);
  console.log(`  Batches Required: ${batches.length}`);
  console.log('');
  console.log(`  Source Balance: ${sourceBalance} dfTokens`);
  if (sourceBalance >= totalDfTokens) {
    console.log(`  Status: SUFFICIENT (${sourceBalance - totalDfTokens} remaining after transfer)`);
  } else {
    console.log(`  Status: INSUFFICIENT (need ${totalDfTokens - sourceBalance} more dfTokens)`);
  }
  console.log('');

  // Show each batch
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`Batch ${i + 1}/${batches.length} (${batch.length} transfers):`);
    for (const transfer of batch) {
      console.log(`  -> ${transfer.address}: ${transfer.dfTokenAmount} dfTokens (${Number(transfer.usdcAmount) / 10_000_000} USDC)`);
    }
    console.log('');
  }

  // Execute transfers
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`Executing Batch ${i + 1}/${batches.length} (${batch.length} transfers)`);

    const invocations = batch.map((transfer) =>
      createTransferInvocation(sourcePublicKey, transfer.address, transfer.dfTokenAmount)
    );

    try {
      const transaction = await buildRouterTransaction(sourceKeypair, invocations);
      const txHash = await sendTransaction(transaction);
      console.log(`  Batch ${i + 1} completed: ${txHash}`);
    } catch (error) {
      console.error(`  Batch ${i + 1} failed:`, error);
      throw error;
    }

    console.log('');
  }

  console.log('='.repeat(60));
  console.log('All transfers completed successfully!');
  console.log('='.repeat(60));
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

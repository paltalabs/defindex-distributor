import * as StellarSdk from "@stellar/stellar-sdk";
import { rpc, Address, xdr, Keypair, Contract, Networks, TransactionBuilder, BASE_FEE } from "@stellar/stellar-sdk";
import { config } from "dotenv";
import * as fs from "fs";
import * as path from "path";

config();

// Constants
// const DEFINDEX_VAULT = "CC767WIU5QGJMXYHDDYJAJEF2YWPHOXOZDWD3UUAZVS4KQPRXCKPT2YZ"; // SeevcashVault
const DEFINDEX_VAULT = "CA2FIPJ7U6BG3N7EOZFI74XPJZOEOD4TYWXFVCIO5VDCHTVAGS6F4UKK"; // SoroswapVault
const STELLAR_ROUTER_CONTRACT = "CDAW42JDSDEI2DXEPP4E7OAYNCRUA4LGCZHXCJ4BV5WVI4O4P77FO4UV";
const BATCH_SIZE = 10;

// Servers
const rpcServer = new rpc.Server(process.env.SOROBAN_RPC as string);

// Types
interface TransferRecord {
  address: string;
  amount: number;
}

interface Invocation {
  contract: Address;
  method: string;
  args: xdr.ScVal[];
  can_fail: boolean;
}

interface StrategyReport {
  locked_fees?: string | number;
  locked_fee?: string | number;
  lockedFee?: string | number;
  [key: string]: unknown;
}

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

// Simulate Multiple Invocations via Router (batched)
async function simulateMultipleInvocations(
  invocations: Invocation[],
  sourcePublicKey: string
): Promise<unknown[]> {
  const account = await rpcServer.getAccount(sourcePublicKey);
  const routerContract = new Contract(STELLAR_ROUTER_CONTRACT);

  const invocationsScVal = xdr.ScVal.scvVec(
    invocations.map((invocation) =>
      xdr.ScVal.scvVec([
        new Address(invocation.contract.toString()).toScVal(),
        xdr.ScVal.scvSymbol(invocation.method),
        xdr.ScVal.scvVec(invocation.args),
        xdr.ScVal.scvBool(invocation.can_fail),
      ])
    )
  );

  const operation = routerContract.call(
    'exec',
    new Address(sourcePublicKey).toScVal(),
    invocationsScVal
  );

  const txBuilder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.PUBLIC,
  });

  txBuilder.addOperation(operation);
  txBuilder.setTimeout(30);
  const tx = txBuilder.build();

  const simulation = await rpcServer.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Batch simulation error: ${simulation.error}`);
  }

  const successSimulation = simulation as rpc.Api.SimulateTransactionSuccessResponse;
  if (!successSimulation.result) {
    throw new Error('Batch simulation returned no result');
  }

  return StellarSdk.scValToNative(successSimulation.result.retval);
}

// Single Contract Simulation
async function simulateContractCall(
  contractId: string,
  method: string,
  params: xdr.ScVal[],
  sourcePublicKey: string
): Promise<unknown> {
  const contract = new Contract(contractId);
  const operation = contract.call(method, ...params);

  const account = await rpcServer.getAccount(sourcePublicKey);

  const txBuilder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.PUBLIC,
  });

  txBuilder.addOperation(operation);
  txBuilder.setTimeout(30);
  const tx = txBuilder.build();

  const simulation = await rpcServer.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Simulation error for ${contractId}.${method}: ${simulation.error}`);
  }

  const successSimulation = simulation as rpc.Api.SimulateTransactionSuccessResponse;
  if (!successSimulation.result) {
    throw new Error(`Simulation for ${contractId}.${method} returned no result`);
  }

  return StellarSdk.scValToNative(successSimulation.result.retval);
}

// Helper to create vault invocation
function createVaultInvocation(method: string, args: xdr.ScVal[] = []): Invocation {
  return {
    contract: new Address(DEFINDEX_VAULT),
    method,
    args,
    can_fail: false,
  };
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
    createVaultInvocation('report'),
    createVaultInvocation('lock_fees', [xdr.ScVal.scvVoid()]),
    createVaultInvocation('total_supply'),
    createVaultInvocation('fetch_total_managed_funds'),
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

// Build Router Transaction
async function buildRouterTransaction(
  sourceKeypair: Keypair,
  invocations: Invocation[]
): Promise<StellarSdk.Transaction> {
  const sourcePublicKey = sourceKeypair.publicKey();
  const account = await rpcServer.getAccount(sourcePublicKey);

  const routerContract = new Contract(STELLAR_ROUTER_CONTRACT);

  const invocationsScVal = xdr.ScVal.scvVec(
    invocations.map((invocation) =>
      xdr.ScVal.scvVec([
        new Address(invocation.contract.toString()).toScVal(),
        xdr.ScVal.scvSymbol(invocation.method),
        xdr.ScVal.scvVec(invocation.args),
        xdr.ScVal.scvBool(invocation.can_fail),
      ])
    )
  );

  const operation = routerContract.call(
    'exec',
    new Address(sourcePublicKey).toScVal(),
    invocationsScVal
  );

  const txBuilder = new TransactionBuilder(account, {
    fee: "2000",
    networkPassphrase: Networks.PUBLIC,
  });

  txBuilder.addOperation(operation);
  txBuilder.setTimeout(300);

  const tx = txBuilder.build();

  // Simulate to get proper resources
  const simulation = await rpcServer.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Transaction simulation failed: ${simulation.error}`);
  }

  const preparedTx = rpc.assembleTransaction(tx, simulation).build();
  preparedTx.sign(sourceKeypair);

  return preparedTx;
}

// Send Transaction and Wait for Confirmation
async function sendTransaction(
  transaction: StellarSdk.Transaction
): Promise<string> {
  const response = await rpcServer.sendTransaction(transaction);

  if (response.status !== "PENDING") {
    const xdrResult = response.errorResult?.toXDR('base64');
    if (xdrResult) {
      const error = xdr.TransactionResult.fromXDR(xdrResult, 'base64').result().switch().name;
      throw new Error(`Transaction failed: ${error}`);
    }
    throw new Error(`Transaction failed with status: ${response.status}`);
  }

  console.log(`  Transaction submitted: ${response.hash}`);
  console.log('  Waiting for confirmation...');

  const txHash = response.hash;
  let status = response.status;

  while (status === "PENDING") {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const txResponse = await rpcServer.getTransaction(txHash);

    if (txResponse.status === "SUCCESS") {
      return txHash;
    } else if (txResponse.status === "FAILED") {
      throw new Error(`Transaction failed: ${txHash}`);
    }
  }

  return txHash;
}

// Batch Array Helper
function batchArray<T>(array: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < array.length; i += batchSize) {
    batches.push(array.slice(i, i + batchSize));
  }
  return batches;
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
  console.log(`Router: ${STELLAR_ROUTER_CONTRACT}`);
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

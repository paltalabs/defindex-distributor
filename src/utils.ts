import * as StellarSdk from "@stellar/stellar-sdk";
import { rpc, Address, xdr, Keypair, Contract, Networks, TransactionBuilder, BASE_FEE } from "@stellar/stellar-sdk";
import { config } from "dotenv";
import * as fs from "fs";
import * as path from "path";

config();

// Network configuration
export type StellarNetwork = "testnet" | "public";

export function getNetwork(): StellarNetwork {
  const network = (process.env.STELLAR_NETWORK || "public").toLowerCase();
  if (network !== "testnet" && network !== "public") {
    throw new Error(`Invalid STELLAR_NETWORK: ${network}. Must be "testnet" or "public"`);
  }
  return network as StellarNetwork;
}

export function getNetworkPassphrase(): string {
  return getNetwork() === "testnet" ? Networks.TESTNET : Networks.PUBLIC;
}

export function getNetworkConfig() {
  const network = getNetwork();
  return {
    network,
    passphrase: getNetworkPassphrase(),
    friendbotUrl: network === "testnet" ? "https://friendbot.stellar.org" : null,
    soroswapFaucetUrl: network === "testnet" ? "https://api.soroswap.finance/api/faucet" : null,
  };
}

// Constants
const MAINNET_ROUTER = "CDAW42JDSDEI2DXEPP4E7OAYNCRUA4LGCZHXCJ4BV5WVI4O4P77FO4UV";
export const STELLAR_ROUTER_CONTRACT = process.env.ROUTER_CONTRACT || MAINNET_ROUTER;
export const BATCH_SIZE = 10;

// Servers
export const rpcServer = new rpc.Server(process.env.SOROBAN_RPC as string);

// Types
export interface TransferRecord {
  address: string;
  amount: number;
}

export interface Invocation {
  contract: Address;
  method: string;
  args: xdr.ScVal[];
  can_fail: boolean;
}

export interface StrategyReport {
  locked_fees?: string | number;
  locked_fee?: string | number;
  lockedFee?: string | number;
  [key: string]: unknown;
}

// Single Contract Simulation
export async function simulateContractCall(
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
    networkPassphrase: getNetworkPassphrase(),
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

// Simulate Multiple Invocations via Router (batched)
export async function simulateMultipleInvocations(
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
    networkPassphrase: getNetworkPassphrase(),
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

// Build Router Transaction
export async function buildRouterTransaction(
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
    networkPassphrase: getNetworkPassphrase(),
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
export async function sendTransaction(
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
export function batchArray<T>(array: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < array.length; i += batchSize) {
    batches.push(array.slice(i, i + batchSize));
  }
  return batches;
}

// Helper to create vault invocation (parametrized by vault address)
export function createVaultInvocation(vaultAddress: string, method: string, args: xdr.ScVal[] = []): Invocation {
  return {
    contract: new Address(vaultAddress),
    method,
    args,
    can_fail: false,
  };
}

// Output directory helper
export function getOutputPath(subdir: string, filename: string): string {
  const dir = path.resolve("output", subdir);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, filename);
}

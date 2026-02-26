import * as StellarSdk from "@stellar/stellar-sdk";
import { rpc, Address, xdr, Keypair, Contract, Networks, TransactionBuilder, BASE_FEE } from "@stellar/stellar-sdk";
import { config } from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { getSecretKey as keychainGet } from "./keychain";

config();

// Constants
const MAINNET_ROUTER = "CDAW42JDSDEI2DXEPP4E7OAYNCRUA4LGCZHXCJ4BV5WVI4O4P77FO4UV";
export const STELLAR_ROUTER_CONTRACT = process.env.ROUTER_CONTRACT || MAINNET_ROUTER;
export const BATCH_MAX_SIZE = 10;

// Network configuration
export type StellarNetwork = "testnet" | "mainnet";

export function getNetwork(): StellarNetwork {
  const network = (process.env.STELLAR_NETWORK || "mainnet").toLowerCase();
  if (network !== "testnet" && network !== "mainnet") {
    throw new Error(`Invalid STELLAR_NETWORK: ${network}. Must be "testnet" or "mainnet"`);
  }
  return network as StellarNetwork;
}

export function getEnvVar(baseName: string): string {
  const suffix = getNetwork().toUpperCase();
  const key = `${baseName}_${suffix}`;
  const value = process.env[key];
  if (!value) {
    throw new Error(`Environment variable ${key} is required (STELLAR_NETWORK=${getNetwork()})`);
  }
  return value;
}

export async function getSecretKey(): Promise<string> {
  const network = getNetwork();
  const fromKeychain = await keychainGet(network);
  if (fromKeychain) return fromKeychain;

  // Fall back to env var (for CI or users who haven't run setup-keys)
  const envKey = `STELLAR_SECRET_KEY_${network.toUpperCase()}`;
  const fromEnv = process.env[envKey];
  if (fromEnv) return fromEnv;

  throw new Error(
    `No secret key found for ${network}. ` +
    `Run "pnpm setup-keys" to store it in the OS keychain, ` +
    `or set ${envKey} in your .env file.`
  );
}

export function getNetworkPassphrase(): string {
  return getNetwork() === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
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

// Servers (lazy — resolved after network is known)
let _rpcServer: rpc.Server | null = null;
export function getRpcServer(): rpc.Server {
  if (!_rpcServer) {
    _rpcServer = new rpc.Server(getEnvVar("SOROBAN_RPC"));
  }
  return _rpcServer;
}

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

  const account = await getRpcServer().getAccount(sourcePublicKey);

  const txBuilder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  });

  txBuilder.addOperation(operation);
  txBuilder.setTimeout(30);
  const tx = txBuilder.build();

  const simulation = await getRpcServer().simulateTransaction(tx);

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
  const account = await getRpcServer().getAccount(sourcePublicKey);
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

  const simulation = await getRpcServer().simulateTransaction(tx);

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
  const account = await getRpcServer().getAccount(sourcePublicKey);

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
  const simulation = await getRpcServer().simulateTransaction(tx);

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
  const response = await getRpcServer().sendTransaction(transaction);

  if (response.status !== "PENDING") {
    const details: string[] = [`Transaction rejected (status: ${response.status})`];
    const xdrResult = response.errorResult?.toXDR('base64');
    if (xdrResult) {
      details.push(`Error XDR: ${xdrResult}`);
      try {
        const parsed = xdr.TransactionResult.fromXDR(xdrResult, 'base64');
        details.push(`Result code: ${parsed.result().switch().name}`);
      } catch { /* ignore */ }
    }
    const fullError = details.join("\n");
    console.error(fullError);
    throw new Error(fullError);
  }

  console.log(`  Transaction submitted: ${response.hash}`);
  console.log('  Waiting for confirmation...');

  const txHash = response.hash;
  let status = response.status;

  while (status === "PENDING") {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const txResponse = await getRpcServer().getTransaction(txHash);

    if (txResponse.status === "SUCCESS") {
      return txHash;
    } else if (txResponse.status === "FAILED") {
      const details: string[] = [`Transaction FAILED: ${txHash}`];

      try {
        const resultXdr = (txResponse as any).resultXdr;
        if (resultXdr) {
          const base64 = typeof resultXdr === "string"
            ? resultXdr
            : resultXdr.toXDR("base64");
          const parsed = xdr.TransactionResult.fromXDR(base64, "base64");
          details.push(`Result XDR: ${base64}`);
          details.push(`Result code: ${parsed.result().switch().name}`);

          const innerResults = parsed.result().value();
          if (Array.isArray(innerResults)) {
            for (const opResult of innerResults) {
              const tr = opResult.tr();
              if (tr) {
                details.push(`Op result: ${tr.switch().name}`);
              }
            }
          }
        }
      } catch (e) {
        details.push(`(could not parse result XDR: ${e})`);
      }

      // Log full result and meta XDR for manual inspection (e.g. Stellar Lab)
      try {
        const resultMeta = (txResponse as any).resultMetaXdr;
        if (resultMeta) {
          const base64Meta = typeof resultMeta === "string"
            ? resultMeta
            : resultMeta.toXDR("base64");
          details.push(`Result Meta XDR: ${base64Meta}`);

          const meta = xdr.TransactionMeta.fromXDR(base64Meta, "base64");
          const v3 = meta.v3();
          if (v3) {
            const diagnosticEvents = v3.sorobanMeta()?.diagnosticEvents();
            if (diagnosticEvents && diagnosticEvents.length > 0) {
              details.push(`Diagnostic events (${diagnosticEvents.length}):`);
              for (const evt of diagnosticEvents) {
                try {
                  details.push(`  ${StellarSdk.scValToNative(evt.event().body().v0().data())}`);
                } catch {
                  details.push(`  ${evt.toXDR("base64").substring(0, 200)}...`);
                }
              }
            }
          }
        }
      } catch {
        // meta parsing is best-effort
      }

      // Log the envelope XDR for inspection
      try {
        const envelopeXdr = (txResponse as any).envelopeXdr;
        if (envelopeXdr) {
          const base64Env = typeof envelopeXdr === "string"
            ? envelopeXdr
            : envelopeXdr.toXDR("base64");
          details.push(`Envelope XDR: ${base64Env}`);
        }
      } catch {
        // best-effort
      }

      const fullError = details.join("\n");
      console.error(fullError);
      throw new Error(fullError);
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

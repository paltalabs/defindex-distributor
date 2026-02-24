import * as StellarSdk from "@stellar/stellar-sdk";
import { Address, xdr, Keypair } from "@stellar/stellar-sdk";
import { config } from "dotenv";
import * as fs from "fs";
import * as path from "path";
import {
  Invocation,
  StrategyReport,
  simulateContractCall,
  simulateMultipleInvocations,
  buildRouterTransaction,
  sendTransaction,
  createVaultInvocation,
  getOutputPath,
} from "./utils";

config();

// Types
interface VaultAnalysis {
  total_loss: string;
  user_count: number;
  users: { address: string; underlying_amount: string }[];
}

interface AnalysisInput {
  timestamp: string;
  source_csv: string;
  total_users: number;
  total_vaults: number;
  vaults: Record<string, VaultAnalysis>;
}

interface DepositLogEntry {
  vault_id: string;
  amount_deposited: string;
  df_tokens_minted: string;
  tx_hash: string;
  timestamp: string;
}

interface DistributionEntry {
  vault_id: string;
  user_address: string;
  underlying_amount: string;
  df_tokens_to_receive: string;
}

// Locked Fees helpers (same as index.ts)
function sumLockedFeesFromReport(report: StrategyReport[]): bigint {
  if (!report || !Array.isArray(report)) return 0n;
  try {
    return report.reduce((acc: bigint, strategy: StrategyReport) => {
      const lockedFee = strategy?.locked_fees ?? strategy?.locked_fee ?? strategy?.lockedFee ?? 0;
      return acc + BigInt(lockedFee);
    }, 0n);
  } catch {
    return 0n;
  }
}

function calculateLockedFeesDelta(before: StrategyReport[], after: StrategyReport[]): bigint {
  const delta = sumLockedFeesFromReport(after) - sumLockedFeesFromReport(before);
  return delta >= 0n ? delta : 0n;
}

// Get vault data for dfToken conversion
async function getVaultData(vaultId: string, sourcePublicKey: string): Promise<{
  totalSupply: bigint;
  totalManagedFunds: bigint;
  lockedFeesDelta: bigint;
}> {
  console.log(`  Fetching vault data for ${vaultId}...`);

  const manager = await simulateContractCall(
    vaultId, 'get_manager', [], sourcePublicKey
  ) as string;

  const batchedInvocations: Invocation[] = [
    createVaultInvocation(vaultId, 'report'),
    createVaultInvocation(vaultId, 'lock_fees', [xdr.ScVal.scvVoid()]),
    createVaultInvocation(vaultId, 'total_supply'),
    createVaultInvocation(vaultId, 'fetch_total_managed_funds'),
  ];

  const results = await simulateMultipleInvocations(batchedInvocations, manager);

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

  console.log(`    Total Supply: ${totalSupply}`);
  console.log(`    Total Managed Funds: ${totalManagedFunds}`);
  console.log(`    Locked Fees Delta: ${lockedFeesDelta}`);

  return { totalSupply, totalManagedFunds, lockedFeesDelta };
}

// Build deposit invocation
function createDepositInvocation(
  vaultId: string,
  amounts: bigint[],
  amountsMin: bigint[],
  from: string
): Invocation {
  return {
    contract: new Address(vaultId),
    method: 'deposit',
    args: [
      xdr.ScVal.scvVec(amounts.map(a => StellarSdk.nativeToScVal(a, { type: 'i128' }))),
      xdr.ScVal.scvVec(amountsMin.map(a => StellarSdk.nativeToScVal(a, { type: 'i128' }))),
      new Address(from).toScVal(),
      xdr.ScVal.scvBool(false), // invest flag
    ],
    can_fail: false,
  };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage: pnpm deposit <analysis.json>");
    console.error("");
    console.error("Reads the analysis JSON and deposits into each vault.");
    console.error("Generates deposit_log and distribution CSVs.");
    process.exit(1);
  }

  const analysisPath = path.resolve(args[0]);
  const secretKey = process.env.STELLAR_SECRET_KEY;

  if (!secretKey) throw new Error("STELLAR_SECRET_KEY environment variable is required");
  if (!process.env.SOROBAN_RPC) throw new Error("SOROBAN_RPC environment variable is required");

  const sourceKeypair = Keypair.fromSecret(secretKey);
  const sourcePublicKey = sourceKeypair.publicKey();

  console.log("=".repeat(60));
  console.log("DeFindex Vault Deposits");
  console.log("=".repeat(60));
  console.log(`Source Account: ${sourcePublicKey}`);
  console.log(`Analysis File: ${analysisPath}`);
  console.log("");

  // Read analysis
  const analysis: AnalysisInput = JSON.parse(fs.readFileSync(analysisPath, "utf-8"));
  console.log(`Vaults to process: ${analysis.total_vaults}`);
  console.log(`Total users: ${analysis.total_users}`);
  console.log("");

  const depositLog: DepositLogEntry[] = [];
  const distribution: DistributionEntry[] = [];
  const vaultIds = Object.keys(analysis.vaults);

  for (const vaultId of vaultIds) {
    const vault = analysis.vaults[vaultId];
    const totalLoss = BigInt(vault.total_loss);

    console.log("-".repeat(60));
    console.log(`Vault: ${vaultId}`);
    console.log(`  Users: ${vault.user_count} | Total Loss: ${totalLoss} stroops`);

    // Check source balance of underlying asset
    const assetAddresses = await simulateContractCall(
      vaultId, 'get_assets', [], sourcePublicKey
    ) as { address: string }[];

    if (!assetAddresses || assetAddresses.length === 0) {
      console.error(`  ERROR: Could not get assets for vault ${vaultId}, skipping`);
      continue;
    }

    console.log(`  Underlying assets: ${assetAddresses.map(a => a.address).join(', ')}`);

    // Check balance of first underlying asset
    const underlyingAsset = assetAddresses[0].address;
    const balanceResult = await simulateContractCall(
      underlyingAsset,
      'balance',
      [new Address(sourcePublicKey).toScVal()],
      sourcePublicKey
    );
    const assetBalance = BigInt(balanceResult as string | number);
    console.log(`  Source balance of underlying: ${assetBalance}`);

    if (assetBalance < totalLoss) {
      console.error(`  WARNING: Insufficient balance. Have ${assetBalance}, need ${totalLoss}`);
      console.error(`  Skipping vault ${vaultId}`);
      continue;
    }

    // Get vault data before deposit (for later comparison)
    const preVaultData = await getVaultData(vaultId, sourcePublicKey);

    // Get dfToken balance before deposit
    const preBalance = BigInt(
      (await simulateContractCall(
        vaultId, 'balance',
        [new Address(sourcePublicKey).toScVal()],
        sourcePublicKey
      )) as string | number
    );
    console.log(`  dfToken balance before deposit: ${preBalance}`);

    // Build deposit amounts (one per asset in the vault)
    const depositAmounts = assetAddresses.map((_, idx) =>
      idx === 0 ? totalLoss : 0n
    );
    const depositAmountsMin = depositAmounts.map(() => 0n); // no slippage protection for now

    // Build and send deposit transaction
    console.log(`  Depositing ${totalLoss} into vault...`);

    const depositInvocation = createDepositInvocation(
      vaultId, depositAmounts, depositAmountsMin, sourcePublicKey
    );

    try {
      const tx = await buildRouterTransaction(sourceKeypair, [depositInvocation]);
      const txHash = await sendTransaction(tx);

      // Get dfToken balance after deposit
      const postBalance = BigInt(
        (await simulateContractCall(
          vaultId, 'balance',
          [new Address(sourcePublicKey).toScVal()],
          sourcePublicKey
        )) as string | number
      );

      const dfTokensMinted = postBalance - preBalance;
      console.log(`  dfToken balance after deposit: ${postBalance}`);
      console.log(`  dfTokens minted: ${dfTokensMinted}`);
      console.log(`  TX Hash: ${txHash}`);

      // Log deposit
      const now = new Date().toISOString();
      depositLog.push({
        vault_id: vaultId,
        amount_deposited: totalLoss.toString(),
        df_tokens_minted: dfTokensMinted.toString(),
        tx_hash: txHash,
        timestamp: now,
      });

      // Calculate proportional distribution
      for (const user of vault.users) {
        const userDelta = BigInt(user.underlying_amount);
        // dfTokens_user = (userDelta / totalLoss) * dfTokensMinted
        // Using integer math: (userDelta * dfTokensMinted) / totalLoss
        const userDfTokens = (userDelta * dfTokensMinted) / totalLoss;

        distribution.push({
          vault_id: vaultId,
          user_address: user.address,
          underlying_amount: user.underlying_amount,
          df_tokens_to_receive: userDfTokens.toString(),
        });
      }

      // Verify distribution sum matches minted
      const distributionSum = vault.users.reduce((sum, user) => {
        const userDelta = BigInt(user.underlying_amount);
        return sum + (userDelta * dfTokensMinted) / totalLoss;
      }, 0n);

      const remainder = dfTokensMinted - distributionSum;
      console.log(`  Distribution sum: ${distributionSum} | Remainder (dust): ${remainder}`);

    } catch (error) {
      console.error(`  DEPOSIT FAILED for vault ${vaultId}:`, error);
      console.error(`  Skipping distribution for this vault.`);
    }

    console.log("");
  }

  // Write deposit log CSV
  const ts = new Date().toISOString().replace(/[:.]/g, "-");

  const depositLogPath = getOutputPath("deposits", `deposit_log_${ts}.csv`);
  const depositLogContent = [
    "vault_id,amount_deposited,df_tokens_minted,tx_hash,timestamp",
    ...depositLog.map(
      (e) => `${e.vault_id},${e.amount_deposited},${e.df_tokens_minted},${e.tx_hash},${e.timestamp}`
    ),
  ].join("\n");
  fs.writeFileSync(depositLogPath, depositLogContent);
  console.log(`Deposit log written to: ${depositLogPath}`);

  // Write distribution CSV
  const distributionPath = getOutputPath("deposits", `distribution_${ts}.csv`);
  const distributionContent = [
    "vault_id,user_address,underlying_amount,df_tokens_to_receive",
    ...distribution.map(
      (e) => `${e.vault_id},${e.user_address},${e.underlying_amount},${e.df_tokens_to_receive}`
    ),
  ].join("\n");
  fs.writeFileSync(distributionPath, distributionContent);
  console.log(`Distribution CSV written to: ${distributionPath}`);

  // Summary
  console.log("");
  console.log("=".repeat(60));
  console.log("Deposit Summary");
  console.log("=".repeat(60));
  console.log(`Vaults deposited: ${depositLog.length}/${vaultIds.length}`);
  console.log(`Distribution records: ${distribution.length}`);

  for (const entry of depositLog) {
    console.log(`  ${entry.vault_id}: deposited ${entry.amount_deposited} → ${entry.df_tokens_minted} dfTokens`);
  }

  console.log("=".repeat(60));
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

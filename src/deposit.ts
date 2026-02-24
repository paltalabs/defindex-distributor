import * as StellarSdk from "@stellar/stellar-sdk";
import { Address, xdr, Keypair } from "@stellar/stellar-sdk";
import { config } from "dotenv";
import * as fs from "fs";
import * as path from "path";
import {
  Invocation,
  simulateContractCall,
  buildRouterTransaction,
  sendTransaction,
  getOutputPath,
} from "./utils";

config();

// Types
interface VaultAnalysis {
  amount: string;
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
      xdr.ScVal.scvBool(true),
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
    console.log(`Processing vault ${vaultId} with ${vault.user_count} users and total amount ${vault.amount}...`);
    const totalToDistribute = BigInt(vault.amount);

    console.log("-".repeat(60));
    console.log(`Vault: ${vaultId}`);
    console.log(`  Users: ${vault.user_count} | Total to distribute: ${totalToDistribute} stroops`);

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

    if (assetBalance < totalToDistribute) {
      console.error(`  WARNING: Insufficient balance. Have ${assetBalance}, need ${totalToDistribute}`);
      console.error(`  Skipping vault ${vaultId}`);
      continue;
    }

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
      idx === 0 ? totalToDistribute : 0n
    );
    const depositAmountsMin = depositAmounts.map((amount) => amount - 1n); // Accept 1 stroop slippage per asset 

    // Build and send deposit transaction
    console.log(`  Depositing ${totalToDistribute} into vault...`);

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
        amount_deposited: totalToDistribute.toString(),
        df_tokens_minted: dfTokensMinted.toString(),
        tx_hash: txHash,
        timestamp: now,
      });

      // Calculate proportional distribution
      for (const user of vault.users) {
        const userPart = BigInt(user.underlying_amount);
        // dfTokens_user = (userPart / totalToDistribute) * dfTokensMinted
        // Using integer math: (userPart * dfTokensMinted) / totalToDistribute
        const userDfTokens = (userPart * dfTokensMinted) / totalToDistribute;

        distribution.push({
          vault_id: vaultId,
          user_address: user.address,
          underlying_amount: user.underlying_amount,
          df_tokens_to_receive: userDfTokens.toString(),
        });
      }

      // Verify distribution sum matches minted
      const distributionSum = vault.users.reduce((sum, user) => {
        const userPart = BigInt(user.underlying_amount);
        return sum + (userPart * dfTokensMinted) / totalToDistribute;
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

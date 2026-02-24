import * as fs from "fs";
import * as path from "path";
import { getOutputPath } from "./utils";

// Types
interface LostFundsRecord {
  vault_id: string;
  user_address: string;
  df_tokens: string;
  pps_before: string;
  pps_after: string;
  underlying_before: string;
  underlying_after: string;
  underlying_amount: string;
  amount: string;
}

interface VaultAnalysis {
  amount: string;
  user_count: number;
  users: { address: string; underlying_amount: string }[];
}

interface AnalysisOutput {
  timestamp: string;
  source_csv: string;
  total_users: number;
  total_vaults: number;
  vaults: Record<string, VaultAnalysis>;
}

// Parse CSV handling quoted fields with commas
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

type CsvFormat = "lost_funds" | "demo";

function detectCsvFormat(header: string[]): CsvFormat {
  if (header.includes("vault") && header.includes("asset") && header.includes("user")) {
    return "demo";
  }
  if (header.includes("vault_id") && header.includes("user_address")) {
    return "lost_funds";
  }
  throw new Error(
    'Unrecognized CSV format. Expected columns: "vault_id,user_address,...,underlying_amount" (lost funds) or "vault,asset,user,amount" (demo)'
  );
}

function parseCSV(filePath: string): LostFundsRecord[] {
  const absolutePath = path.resolve(filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`CSV file not found: ${absolutePath}`);
  }

  const content = fs.readFileSync(absolutePath, "utf-8");
  const lines = content.trim().split("\n");

  if (lines.length < 2) {
    throw new Error("CSV file must have a header row and at least one data row");
  }

  const header = parseCSVLine(lines[0]).map((h) => h.toLowerCase());
  const format = detectCsvFormat(header);
  console.log(`Detected CSV format: ${format}`);

  if (format === "demo") {
    return parseDemoCSV(header, lines);
  }
  return parseLostFundsCSV(header, lines);
}

function parseDemoCSV(header: string[], lines: string[]): LostFundsRecord[] {
  const vaultIdx = header.indexOf("vault");
  const userIdx = header.indexOf("user");
  const amountIdx = header.indexOf("amount");

  const records: LostFundsRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCSVLine(line);

    records.push({
      vault_id: values[vaultIdx],
      user_address: values[userIdx],
      df_tokens: "",
      pps_before: "",
      pps_after: "",
      underlying_before: "",
      underlying_after: "",
      underlying_amount: values[amountIdx],
      amount: values[amountIdx],
    });
  }

  return records;
}

function parseLostFundsCSV(header: string[], lines: string[]): LostFundsRecord[] {
  const vaultIdx = header.indexOf("vault_id");
  const userIdx = header.indexOf("user_address");
  const dfTokensIdx = header.indexOf("df_tokens");
  const ppsBIdx = header.indexOf("pps_before");
  const ppsAIdx = header.indexOf("pps_after");
  const underBIdx = header.indexOf("underlying_before");
  const underAIdx = header.indexOf("underlying_after");
  const deltaIdx = header.indexOf("underlying_amount");
  const amountIdx = header.indexOf("amount");

  if (vaultIdx === -1 || userIdx === -1 || deltaIdx === -1) {
    throw new Error(
      'CSV must have "vault_id", "user_address", and "underlying_amount" columns'
    );
  }

  const records: LostFundsRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCSVLine(line);

    records.push({
      vault_id: values[vaultIdx],
      user_address: values[userIdx],
      df_tokens: values[dfTokensIdx] ?? "",
      pps_before: values[ppsBIdx] ?? "",
      pps_after: values[ppsAIdx] ?? "",
      underlying_before: values[underBIdx] ?? "",
      underlying_after: values[underAIdx] ?? "",
      underlying_amount: values[deltaIdx],
      amount: values[amountIdx] ?? "",
    });
  }

  return records;
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage: pnpm analyze <csv_file>");
    console.error("");
    console.error("Supported CSV formats:");
    console.error("  Lost funds: vault_id,user_address,df_tokens,...,underlying_amount,Amount");
    console.error("  Demo:       vault,asset,user,amount");
    process.exit(1);
  }

  const csvPath = args[0];
  console.log("=".repeat(60));
  console.log("DeFindex Lost Funds Analysis");
  console.log("=".repeat(60));
  console.log(`Source CSV: ${csvPath}`);
  console.log("");

  // Parse CSV
  const records = parseCSV(csvPath);
  console.log(`Total records parsed: ${records.length}`);
  console.log("");

  // Group by vault
  const vaults: Record<string, VaultAnalysis> = {};

  for (const record of records) {
    if (!vaults[record.vault_id]) {
      vaults[record.vault_id] = {
        amount: "0",
        user_count: 0,
        users: [],
      };
    }

    const vault = vaults[record.vault_id];
    // underlying_amount is negative, we store absolute value
    const delta = BigInt(record.underlying_amount);
    const absDelta = delta < 0n ? -delta : delta;

    vault.amount = (BigInt(vault.amount) + absDelta).toString();
    vault.user_count += 1;
    vault.users.push({
      address: record.user_address,
      underlying_amount: absDelta.toString(),
    });
  }

  // Display summary table
  console.log("Vault Summary:");
  console.log("-".repeat(100));
  console.log(
    `${"Vault ID".padEnd(58)} ${"Users".padStart(6)} ${"Total amount (stroops)".padStart(25)}`
  );
  console.log("-".repeat(100));

  const vaultIds = Object.keys(vaults).sort(
    (a, b) => vaults[b].user_count - vaults[a].user_count
  );

  let grandTotalAmount = 0n;
  let grandTotalUsers = 0;

  for (const vaultId of vaultIds) {
    const vault = vaults[vaultId];
    grandTotalAmount += BigInt(vault.amount);
    grandTotalUsers += vault.user_count;

    console.log(
      `${vaultId.padEnd(58)} ${vault.user_count.toString().padStart(6)} ${vault.amount.padStart(25)}`
    );
  }

  console.log("-".repeat(100));
  console.log(
    `${"TOTAL".padEnd(58)} ${grandTotalUsers.toString().padStart(6)} ${grandTotalAmount.toString().padStart(25)}`
  );
  console.log("");

  // Build output
  const output: AnalysisOutput = {
    timestamp: new Date().toISOString(),
    source_csv: path.basename(csvPath),
    total_users: grandTotalUsers,
    total_vaults: vaultIds.length,
    vaults,
  };

  // Write JSON
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = getOutputPath("analysis", `analysis_${timestamp}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(`Analysis written to: ${outputPath}`);
  console.log("");
  console.log("=".repeat(60));
  console.log(`Vaults: ${vaultIds.length} | Users: ${grandTotalUsers} | Total Amount: ${grandTotalAmount} stroops`);
  console.log("=".repeat(60));
}

main();

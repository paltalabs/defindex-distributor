import * as fs from "fs";
import { getOutputPath } from "./utils";

export interface TransferLogEntry {
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

const CSV_HEADER =
  "vault,user,amount_sent,df_tokens_received,df_balance_before,df_balance_after,df_balance_delta,tx_hash,batch_number,status";

export class Logger {
  private csvPath: string;
  private logPath: string;
  private entryCount = 0;

  constructor(subdir: string) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    this.csvPath = getOutputPath(subdir, `${subdir}_${ts}.csv`);
    this.logPath = getOutputPath(subdir, `${subdir}_${ts}.log`);

    fs.writeFileSync(this.csvPath, CSV_HEADER + "\n");
    fs.writeFileSync(this.logPath, `[${new Date().toISOString()}] Logger started\n`);
  }

  logEntry(entry: TransferLogEntry): void {
    const csvLine = [
      entry.vault,
      entry.user,
      entry.amount_sent,
      entry.df_tokens_received,
      entry.df_balance_before,
      entry.df_balance_after,
      entry.df_balance_delta,
      entry.tx_hash,
      entry.batch_number,
      `"${entry.status}"`,
    ].join(",");

    fs.appendFileSync(this.csvPath, csvLine + "\n");

    const readable = `[${entry.status.toUpperCase()}] ${entry.user.substring(0, 12)}... | sent=${entry.amount_sent} dfTok=${entry.df_tokens_received} delta=${entry.df_balance_delta} tx=${entry.tx_hash || "N/A"} batch=${entry.batch_number}`;
    fs.appendFileSync(this.logPath, readable + "\n");

    this.entryCount++;
  }

  logMessage(msg: string, fileMsg?: string): void {
    console.log(msg);
    fs.appendFileSync(this.logPath, `[${new Date().toISOString()}] ${fileMsg ?? msg}\n`);
  }

  get csvFilePath(): string {
    return this.csvPath;
  }

  get logFilePath(): string {
    return this.logPath;
  }

  get totalEntries(): number {
    return this.entryCount;
  }
}

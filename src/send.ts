import "dotenv/config";
import {
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  Horizon,
} from "@stellar/stellar-sdk";
import { getNetworkPassphrase } from "./utils";

const HORIZON_URL = process.env.HORIZON_RPC as string;

function parseArgs(): { amount: string; destination: string } {
  const [, , amount, destination] = process.argv;

  if (!amount || !destination) {
    console.error("Usage: pnpm send <amount> <destination>");
    process.exit(1);
  }

  if (isNaN(Number(amount)) || Number(amount) <= 0) {
    console.error("Error: amount must be a positive number");
    process.exit(1);
  }

  return { amount, destination };
}

function loadKeypair(): Keypair {
  const secretKey = process.env.STELLAR_SECRET_KEY;

  if (!secretKey) {
    console.error("Error: STELLAR_SECRET_KEY not found in environment");
    process.exit(1);
  }

  return Keypair.fromSecret(secretKey);
}

async function sendXLM(
  amount: string,
  destination: string
): Promise<Horizon.HorizonApi.SubmitTransactionResponse> {
  const keypair = loadKeypair();
  console.log("🚀 | sendXLM | keypair:", keypair.publicKey())
  const server = new Horizon.Server(HORIZON_URL);

  const account = await server.loadAccount(keypair.publicKey());

  const transaction = new TransactionBuilder(account, {
    fee: "2000",
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(
      Operation.payment({
        destination,
        asset: Asset.native(),
        amount,
      })
    )
    .setTimeout(300)
    .build();

  transaction.sign(keypair);

  const tx = await server.submitTransaction(transaction);
  console.log("🚀 | sendXLM | tx:", tx)

  return tx
}

async function main(): Promise<void> {
  const { amount, destination } = parseArgs();

  console.log(`Sending ${amount} XLM to ${destination}...`);

  const result = await sendXLM(amount, destination);
  console.log("Transaction successful!");
  console.log(`Hash: ${result.hash}`);
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error("Transaction failed:", error.message);
  } else {
    console.error("Transaction failed:", error);
  }
  process.exit(1);
});

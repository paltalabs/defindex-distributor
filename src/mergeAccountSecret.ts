import {
    Horizon,
    Keypair,
    Operation,
    TransactionBuilder,
  } from "@stellar/stellar-sdk";
  import { config } from "dotenv";
  import { getNetworkPassphrase } from "./utils";
  config();

  async function main() {
    const server = new Horizon.Server(process.env.HORIZON_RPC as string)
    const secret = process.env.MERGE_SECRET as string;

    if (!secret) {
        throw new Error('MERGE_SECRET environment variable is required');
    }

    const sourceKeypair = Keypair.fromSecret(secret);
    const sourcePublicKey = sourceKeypair.publicKey();
    console.log("🚀 | main | sourcePublicKey:", sourcePublicKey)
  
    try {
      // Load the account to be merged
      const account = await server.loadAccount(
        sourceKeypair.publicKey()
      );
  
      // Create the merge transaction
      const transaction = new TransactionBuilder(account, {
        fee: "2000",
        networkPassphrase: getNetworkPassphrase(),
      })
        .addOperation(
          Operation.accountMerge({
            destination: "GAHF3QTOKBQ6HZ2J3XS4KMFV5E5IBDESG3A4JGCLBLOUKTEYGERIPPER",
          })
        )
        .setTimeout(500)
        .build();
  
      // Sign the transaction with the source account's keypair
      transaction.sign(sourceKeypair);
  
      // // Submit the transaction
      const response = await server.submitTransaction(transaction);
  
      console.log(`Account ${sourceKeypair.publicKey()} merged successfully!`);
      console.log("Transaction Response:", response);
    } catch (error) {
      console.error(`Error merging account ${sourceKeypair.publicKey()}:`, error);
    }
  }
  
  main().catch((error) => console.error("Error in main:", error));

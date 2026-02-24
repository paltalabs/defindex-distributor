import {
    Horizon,
    Keypair,
    Operation,
    TransactionBuilder,
  } from "@stellar/stellar-sdk";
  import * as bip39 from "bip39";
  import { derivePath } from "ed25519-hd-key";
  import { config } from "dotenv";
  import { getNetworkPassphrase } from "./utils";
  config();

  function keypairFromMnemonic(mnemonic: string, accountIndex = 0): Keypair {
    if (!bip39.validateMnemonic(mnemonic)) {
      throw new Error("Invalid mnemonic phrase");
    }
    const seed = bip39.mnemonicToSeedSync(mnemonic).toString("hex");
    const path = `m/44'/148'/${accountIndex}'`;
    const { key } = derivePath(path, seed);
    return Keypair.fromRawEd25519Seed(Buffer.from(key));
  }

  async function main() {
    const server = new Horizon.Server(process.env.HORIZON_RPC as string)
    const mnemonic = process.env.MNEMONIC as string;

    if (!mnemonic) {
        throw new Error('MNEMONIC environment variable is required');
    }

    const sourceKeypair = keypairFromMnemonic(mnemonic, 0);
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

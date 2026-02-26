/**
 * One-time setup: store your Stellar secret key in the OS keychain.
 *
 * Usage:
 *   pnpm setup-keys              # store key for current STELLAR_NETWORK
 *   pnpm setup-keys testnet      # store testnet key
 *   pnpm setup-keys mainnet      # store mainnet key
 *   pnpm setup-keys --delete     # delete key for current STELLAR_NETWORK
 *   pnpm setup-keys --show       # print stored public key (never the secret)
 */
import * as readline from "readline";
import { Keypair } from "@stellar/stellar-sdk";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "bip39";
import { derivePath } from "ed25519-hd-key";
import { config } from "dotenv";
import { getNetwork } from "./utils";
import { getSecretKey, storeSecretKey, deleteSecretKey } from "./keychain";

config();

// Stellar's registered BIP44 coin type (SLIP-0010 Ed25519)
const STELLAR_DERIVATION_PATH = "m/44'/148'/0'";

function keypairFromMnemonic(mnemonic: string): Keypair {
  const seed = mnemonicToSeedSync(mnemonic);
  const { key } = derivePath(STELLAR_DERIVATION_PATH, seed.toString("hex"));
  return Keypair.fromRawEd25519Seed(key);
}

async function prompt(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    if (hidden) {
      process.stdout.write(question);
      process.stdin.setRawMode(true);
      let input = "";
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", function handler(ch: string) {
        if (ch === "\n" || ch === "\r" || ch === "\u0003") {
          process.stdin.setRawMode(false);
          process.stdin.removeListener("data", handler);
          process.stdout.write("\n");
          rl.close();
          resolve(input);
        } else if (ch === "\u007f") {
          input = input.slice(0, -1);
        } else {
          input += ch;
        }
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

async function promptChoice(question: string, choices: string[]): Promise<number> {
  console.log(question);
  choices.forEach((c, i) => console.log(`  (${i + 1}) ${c}`));
  while (true) {
    const answer = await prompt("> ");
    const n = parseInt(answer, 10);
    if (n >= 1 && n <= choices.length) return n - 1;
    console.log(`Please enter a number between 1 and ${choices.length}.`);
  }
}

async function resolveKeypair(network: string): Promise<{ kp: Keypair; mnemonic?: string }> {
  const choice = await promptChoice(
    `\nHow do you want to set up your ${network} key?`,
    [
      "Enter an existing secret key (S...)",
      "Enter an existing seed phrase (BIP39 mnemonic)",
      "Generate a new seed phrase for me",
    ]
  );

  if (choice === 0) {
    const secret = await prompt("Secret key (S...): ", true);
    let kp: Keypair;
    try {
      kp = Keypair.fromSecret(secret);
    } catch {
      console.error("Invalid secret key.");
      process.exit(1);
    }
    return { kp };
  }

  if (choice === 1) {
    const mnemonic = await prompt("Seed phrase (12 or 24 words): ", true);
    if (!validateMnemonic(mnemonic)) {
      console.error("Invalid seed phrase. Make sure all words are from the BIP39 word list.");
      process.exit(1);
    }
    const kp = keypairFromMnemonic(mnemonic);
    return { kp };
  }

  // Generate new mnemonic
  const mnemonic = generateMnemonic(128); // 12 words
  const kp = keypairFromMnemonic(mnemonic);
  return { kp, mnemonic };
}

async function main() {
  const args = process.argv.slice(2);
  const networkArg = args.find((a) => a === "testnet" || a === "mainnet");
  const doDelete = args.includes("--delete");
  const doShow = args.includes("--show");

  const network = networkArg ?? getNetwork();

  if (doDelete) {
    await deleteSecretKey(network);
    console.log(`Deleted ${network} key from keychain.`);
    return;
  }

  if (doShow) {
    const existing = await getSecretKey(network);
    if (!existing) {
      console.log(`No ${network} key stored in keychain.`);
    } else {
      const kp = Keypair.fromSecret(existing);
      console.log(`${network} public key: ${kp.publicKey()}`);
    }
    return;
  }

  // Check for existing key
  const existing = await getSecretKey(network);
  if (existing) {
    const kp = Keypair.fromSecret(existing);
    console.log(`A ${network} key is already stored (public key: ${kp.publicKey()}).`);
    const overwrite = await prompt("Overwrite? [y/N] ");
    if (overwrite.toLowerCase() !== "y") {
      console.log("Aborted.");
      return;
    }
  }

  const { kp, mnemonic } = await resolveKeypair(network);

  await storeSecretKey(network, kp.secret());
  console.log(`\nStored. Public key: ${kp.publicKey()}`);

  if (mnemonic) {
    console.log("\n" + "=".repeat(60));
    console.log("WRITE DOWN YOUR SEED PHRASE — it will not be stored:");
    console.log("=".repeat(60));
    console.log(mnemonic);
    console.log("=".repeat(60));
    console.log("Anyone with this phrase can access your funds. Keep it safe.");
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});

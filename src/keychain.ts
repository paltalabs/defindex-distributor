import { Entry } from "@napi-rs/keyring";

const SERVICE = "defindex-distributor";

function entry(network: string): Entry {
  return new Entry(SERVICE, `stellar-secret-${network}`);
}

export async function getSecretKey(network: string): Promise<string | null> {
  try {
    return entry(network).getPassword();
  } catch {
    return null;
  }
}

export async function storeSecretKey(network: string, key: string): Promise<void> {
  entry(network).setPassword(key);
}

export async function deleteSecretKey(network: string): Promise<void> {
  entry(network).deletePassword();
}

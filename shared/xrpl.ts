import { Client, Wallet, convertStringToHex } from "xrpl";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

export const XRPL_WS = process.env.XRPL_WS ?? "wss://s.altnet.rippletest.net:51233";
export const EXPLORER = "https://testnet.xrpl.org";

// Test stablecoin. Standard 3-letter code issued by our own issuer account.
// Swap for the real RLUSD testnet issuer later if it's available.
export const CURRENCY = "USD";

export const SECRETS_PATH = ".secrets/accounts.json";
export const PUBLIC_PATH = "shared/accounts.public.json";

export type Role =
  | "issuer"
  | "treasury"
  | "agent"
  | "policy"
  | "operator"
  | "intel"
  | "gateway"
  | "supplierA"
  | "supplierB";

export type Accounts = Record<Role, { address: string; seed: string }>;

export async function connect(): Promise<Client> {
  const client = new Client(XRPL_WS);
  await client.connect();
  return client;
}

export function saveAccounts(accounts: Accounts): void {
  mkdirSync(".secrets", { recursive: true });
  writeFileSync(SECRETS_PATH, JSON.stringify(accounts, null, 2));
  const pub = Object.fromEntries(
    Object.entries(accounts).map(([role, a]) => [role, a.address]),
  );
  writeFileSync(PUBLIC_PATH, JSON.stringify(pub, null, 2) + "\n");
}

export function loadAccounts(): Accounts {
  if (!existsSync(SECRETS_PATH)) {
    throw new Error(`No ${SECRETS_PATH}. Run: npm run setup:testnet`);
  }
  return JSON.parse(readFileSync(SECRETS_PATH, "utf8"));
}

export function wallet(accounts: Accounts, role: Role): Wallet {
  return Wallet.fromSeed(accounts[role].seed);
}

export const txLink = (hash: string) => `${EXPLORER}/transactions/${hash}`;
export const accountLink = (address: string) => `${EXPLORER}/accounts/${address}`;

// Audit memo: SHA-256 of the decision report, stored on-ledger in the payment.
export function reportMemo(report: unknown) {
  const hash = createHash("sha256").update(JSON.stringify(report)).digest("hex");
  return {
    hash,
    memo: {
      Memo: {
        MemoType: convertStringToHex("mlinzi/report-sha256"),
        MemoData: convertStringToHex(hash),
      },
    },
  };
}

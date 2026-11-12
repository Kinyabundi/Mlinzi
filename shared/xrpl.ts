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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function connect(attempts = 5): Promise<Client> {
  const client = new Client(XRPL_WS, { connectionTimeout: 20_000 });
  for (let i = 0; i < attempts; i++) {
    try {
      await client.connect();
      return client;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await sleep(2000 * (i + 1));
    }
  }
  throw new Error("unreachable");
}

function isTransient(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return e?.name === "NotConnectedError" || e?.name === "DisconnectedError"
    || /not connected|websocket|connect\(\) timed out/i.test(e?.message ?? "");
}

/**
 * Runs a ledger call, reconnecting and retrying if the socket drops. Safe for
 * submits too: a signed blob carries a fixed Sequence, so resubmitting it is
 * idempotent — the ledger either returns the same result or rejects the dupe.
 */
export async function withLedger<T>(client: Client, fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      if (!client.isConnected()) await client.connect();
      return await fn();
    } catch (err) {
      if (!isTransient(err) || i === attempts - 1) throw err;
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error("unreachable");
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

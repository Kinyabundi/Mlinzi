import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";

mkdirSync(".data", { recursive: true });
export const db = new Database(".data/gateway.db");
db.pragma("journal_mode = WAL");

db.exec(`
  -- One row per 402 challenge. The nonce binds a payment to one screening request.
  CREATE TABLE IF NOT EXISTS challenges (
    nonce TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    price REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Spent payment hashes, so one payment cannot buy two screenings.
  CREATE TABLE IF NOT EXISTS receipts (
    tx_hash TEXT PRIMARY KEY,
    nonce TEXT NOT NULL,
    address TEXT NOT NULL,
    amount REAL NOT NULL,
    redeemed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- The gateway's own risk intelligence. Seeded by the operator, not by the agent.
  CREATE TABLE IF NOT EXISTS denylist (
    address TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export interface ChallengeRow { nonce: string; address: string; price: number; created_at: string }

export const putChallenge = (nonce: string, address: string, price: number) =>
  db.prepare("INSERT INTO challenges (nonce, address, price) VALUES (?, ?, ?)").run(nonce, address, price);

export const getChallenge = (nonce: string) =>
  db.prepare("SELECT * FROM challenges WHERE nonce = ?").get(nonce) as ChallengeRow | undefined;

export const isSpent = (txHash: string) =>
  !!db.prepare("SELECT 1 FROM receipts WHERE tx_hash = ?").get(txHash);

export const spend = (txHash: string, nonce: string, address: string, amount: number) =>
  db.prepare("INSERT INTO receipts (tx_hash, nonce, address, amount) VALUES (?, ?, ?, ?)")
    .run(txHash, nonce, address, amount);

export const denyReason = (address: string) =>
  (db.prepare("SELECT reason FROM denylist WHERE address = ?").get(address) as { reason: string } | undefined)?.reason;

export const addDeny = (address: string, reason: string) =>
  db.prepare("INSERT OR REPLACE INTO denylist (address, reason) VALUES (?, ?)").run(address, reason);

export const listDeny = () =>
  db.prepare("SELECT * FROM denylist ORDER BY added_at DESC").all() as { address: string; reason: string; added_at: string }[];

export const revenue = () =>
  (db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM receipts").get() as { s: number }).s;

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import type { ProposalStatus } from "../shared/types.js";

mkdirSync(".data", { recursive: true });
export const db = new Database(".data/policy.db");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS policy (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    per_payment_limit REAL NOT NULL,
    daily_limit REAL NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT OR IGNORE INTO policy VALUES (1, 500, 2000, datetime('now'));

  CREATE TABLE IF NOT EXISTS payees (
    address TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    approved_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id TEXT NOT NULL,
    payee TEXT NOT NULL,
    amount REAL NOT NULL,
    status TEXT NOT NULL,
    reasons TEXT NOT NULL,
    report TEXT NOT NULL,
    tx_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_proposals_invoice ON proposals(invoice_id);
`);

export interface PolicyRow { per_payment_limit: number; daily_limit: number; updated_at: string }
export interface ProposalRow {
  id: number; invoice_id: string; payee: string; amount: number; status: ProposalStatus;
  reasons: string; report: string; tx_hash: string | null; created_at: string; updated_at: string;
}

export const getPolicy = () => db.prepare("SELECT * FROM policy WHERE id = 1").get() as PolicyRow;

export const setPolicy = (perPayment: number, daily: number) =>
  db.prepare("UPDATE policy SET per_payment_limit = ?, daily_limit = ?, updated_at = datetime('now') WHERE id = 1")
    .run(perPayment, daily);

export const isAllowlisted = (address: string) =>
  !!db.prepare("SELECT 1 FROM payees WHERE address = ?").get(address);

export const listPayees = () => db.prepare("SELECT * FROM payees ORDER BY approved_at DESC").all();

export const addPayee = (address: string, name: string) =>
  db.prepare("INSERT OR REPLACE INTO payees VALUES (?, ?, datetime('now'))").run(address, name);

export const removePayee = (address: string) =>
  db.prepare("DELETE FROM payees WHERE address = ?").run(address);

export const latestForInvoice = (invoiceId: string) =>
  db.prepare("SELECT * FROM proposals WHERE invoice_id = ? ORDER BY id DESC LIMIT 1").get(invoiceId) as ProposalRow | undefined;

export const spentToday = () =>
  (db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM proposals WHERE status = 'paid' AND date(updated_at) = date('now')").get() as { s: number }).s;

export const insertProposal = (p: { invoiceId: string; payee: string; amount: number; status: ProposalStatus; reasons: string[]; report: unknown }) =>
  Number(db.prepare("INSERT INTO proposals (invoice_id, payee, amount, status, reasons, report) VALUES (?, ?, ?, ?, ?, ?)")
    .run(p.invoiceId, p.payee, p.amount, p.status, JSON.stringify(p.reasons), JSON.stringify(p.report)).lastInsertRowid);

export const updateStatus = (id: number, status: ProposalStatus, txHash?: string) =>
  db.prepare("UPDATE proposals SET status = ?, tx_hash = COALESCE(?, tx_hash), updated_at = datetime('now') WHERE id = ?")
    .run(status, txHash ?? null, id);

export const getProposal = (id: number) =>
  db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as ProposalRow | undefined;

export const listProposals = (status?: ProposalStatus) =>
  (status
    ? db.prepare("SELECT * FROM proposals WHERE status = ? ORDER BY id DESC").all(status)
    : db.prepare("SELECT * FROM proposals ORDER BY id DESC LIMIT 200").all()) as ProposalRow[];

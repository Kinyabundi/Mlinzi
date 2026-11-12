import type { Client } from "xrpl";
import { CURRENCY } from "../shared/xrpl.js";
import { denyReason } from "./db.js";

export interface Signal { code: string; detail: string; severity: "info" | "warn" | "high" }

export interface ScreeningResult {
  address: string;
  risk: "low" | "medium" | "high";
  signals: Signal[];
  screenedAt: string;
}

const MIN_AGE_HOURS = 24;
const MIN_ACTIVITY = 2; // transactions

// Deterministic screening over on-ledger facts plus the operator's denylist.
// No LLM: a paid verdict the policy service and the operator can both reproduce.
export async function screenAddress(client: Client, address: string, issuer: string): Promise<ScreeningResult> {
  const signals: Signal[] = [];

  const denied = denyReason(address);
  if (denied) signals.push({ code: "denylisted", detail: denied, severity: "high" });

  let exists = true;
  try {
    await client.request({ command: "account_info", account: address, ledger_index: "validated" });
  } catch (err: any) {
    if (err?.data?.error === "actNotFound") exists = false;
    else throw err;
  }

  if (!exists) {
    signals.push({ code: "no_such_account", detail: "address does not exist on the ledger", severity: "high" });
    return { address, risk: "high", signals, screenedAt: new Date().toISOString() };
  }

  const txs = await client.request({ command: "account_tx", account: address, forward: true, limit: 200 });
  const rows = txs.result.transactions;
  const firstSeen: string | undefined = (rows[0] as any)?.close_time_iso;
  const ageHours = firstSeen ? Math.round((Date.now() - Date.parse(firstSeen)) / 36e5) : 0;

  if (ageHours < MIN_AGE_HOURS) {
    signals.push({ code: "new_account", detail: `first seen ${ageHours}h ago`, severity: "warn" });
  }
  if (rows.length < MIN_ACTIVITY) {
    signals.push({ code: "low_activity", detail: `${rows.length} transactions on record`, severity: "warn" });
  }

  const lines = await client.request({ command: "account_lines", account: address, peer: issuer });
  if (!lines.result.lines.some((l) => l.currency === CURRENCY)) {
    signals.push({ code: "no_trust_line", detail: `cannot receive ${CURRENCY} from the issuer`, severity: "high" });
  }

  // Counterparties the address has already received this stablecoin from.
  const counterparties = new Set<string>();
  for (const row of rows as any[]) {
    const tx = row.tx_json ?? row.tx;
    if (tx?.TransactionType === "Payment" && tx.Destination === address && tx.Account) counterparties.add(tx.Account);
  }
  signals.push({ code: "counterparties", detail: `${counterparties.size} distinct senders`, severity: "info" });

  const risk: ScreeningResult["risk"] =
    signals.some((s) => s.severity === "high") ? "high"
    : signals.some((s) => s.severity === "warn") ? "medium"
    : "low";

  return { address, risk, signals, screenedAt: new Date().toISOString() };
}

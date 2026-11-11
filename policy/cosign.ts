import { decode, multisign, Wallet, type Client, type Payment } from "xrpl";
import { reportMemo, CURRENCY, type Accounts } from "../shared/xrpl.js";
import type { Proposal } from "../shared/types.js";

const TF_PARTIAL_PAYMENT = 0x00020000;

// Checks that the transaction the agent signed is exactly the payment it proposed.
// Returns a list of problems; empty means the blob is safe to co-sign.
export function verifyAgentBlob(p: Proposal, accounts: Accounts): string[] {
  const problems: string[] = [];
  let tx: Record<string, any>;
  try {
    tx = decode(p.txBlob) as Record<string, any>;
  } catch {
    return ["txBlob could not be decoded"];
  }

  if (tx.TransactionType !== "Payment") problems.push("not a Payment");
  if (tx.Account !== accounts.treasury.address) problems.push("source is not the treasury");
  if (tx.Destination !== p.payee) problems.push("destination does not match proposal payee");

  const amt = tx.Amount;
  if (typeof amt !== "object" || amt.currency !== CURRENCY || amt.issuer !== accounts.issuer.address) {
    problems.push(`amount must be ${CURRENCY} from the configured issuer`);
  } else if (Number(amt.value) !== Number(p.amount)) {
    problems.push("amount does not match proposal");
  }

  if (((tx.Flags ?? 0) & TF_PARTIAL_PAYMENT) !== 0) problems.push("partial payments are not allowed");
  for (const field of ["SendMax", "DeliverMin", "Paths"]) {
    if (tx[field] !== undefined) problems.push(`${field} is not allowed`);
  }

  const signers: any[] = tx.Signers ?? [];
  if (signers.length !== 1 || signers[0]?.Signer?.Account !== accounts.agent.address) {
    problems.push("must carry exactly one signature, from the agent key");
  }

  const memoHex: string | undefined = tx.Memos?.[0]?.Memo?.MemoData;
  const expected = Buffer.from(reportMemo(p.report).hash, "utf8").toString("hex");
  if (!memoHex || memoHex.toLowerCase() !== expected.toLowerCase()) {
    problems.push("memo does not match the hash of the decision report");
  }

  return problems;
}

// Adds the policy signature and submits. Throws if the ledger rejects it.
export async function cosignAndSubmit(client: Client, agentBlob: string, policyWallet: Wallet): Promise<string> {
  const tx = decode(agentBlob) as unknown as Payment & { Signers?: unknown };
  delete tx.Signers;
  const policyBlob = policyWallet.sign(tx, true).tx_blob;
  const res = await client.submitAndWait(multisign([agentBlob, policyBlob]));
  const meta = res.result.meta;
  const code = typeof meta === "object" && meta ? meta.TransactionResult : "unknown";
  if (code !== "tesSUCCESS") throw new Error(`ledger rejected payment: ${code}`);
  return res.result.hash;
}

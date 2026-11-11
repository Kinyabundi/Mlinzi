import type { Client } from "xrpl";
import { CURRENCY } from "../shared/xrpl.js";

// Free, on-ledger facts about a payee. Paid screening (x402) is added on Thursday.
export async function payeeFacts(client: Client, address: string, issuer: string) {
  try {
    const info = await client.request({ command: "account_info", account: address, ledger_index: "validated" });
    const first = await client.request({ command: "account_tx", account: address, forward: true, limit: 1 });
    const firstTx: any = first.result.transactions[0];
    const firstSeen: string | undefined = firstTx?.close_time_iso;
    const ageHours = firstSeen ? Math.round((Date.now() - Date.parse(firstSeen)) / 36e5) : null;

    const lines = await client.request({ command: "account_lines", account: address, peer: issuer });
    const hasTrustLine = lines.result.lines.some((l) => l.currency === CURRENCY);

    return {
      exists: true,
      xrpBalance: Number(info.result.account_data.Balance) / 1e6,
      firstSeen: firstSeen ?? null,
      ageHours,
      hasTrustLine,
    };
  } catch (err: any) {
    if (err?.data?.error === "actNotFound") return { exists: false };
    throw err;
  }
}

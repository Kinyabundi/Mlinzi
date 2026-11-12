import type { Client, Payment } from "xrpl";
import { convertStringToHex } from "xrpl";
import { wallet, withLedger, CURRENCY, type Accounts } from "../shared/xrpl.js";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:4402";

// Hard cap on screening spend per agent run, on top of the intel account's float.
const RUN_BUDGET = Number(process.env.SCREENING_RUN_BUDGET ?? "5");
let spentThisRun = 0;

export interface ScreeningOutcome {
  paid: boolean;
  cost?: number;
  txHash?: string;
  result?: { address: string; risk: "low" | "medium" | "high"; signals: unknown[]; screenedAt: string };
  error?: string;
}

interface Requirements {
  payTo: string;
  maxAmountRequired: string;
  nonce: string;
  asset: { currency: string; issuer: string };
}

function firstAccept(body: any): Requirements | null {
  const a = body?.accepts?.[0];
  if (!a?.payTo || !a?.nonce || !a?.maxAmountRequired) return null;
  return a;
}

// x402 round trip: ask, get 402, pay on-ledger, ask again with proof of payment.
export async function screenPayee(client: Client, accounts: Accounts, address: string): Promise<ScreeningOutcome> {
  const url = `${GATEWAY_URL}/screen?address=${encodeURIComponent(address)}`;

  const challenge = await fetch(url);
  if (challenge.ok) return { paid: false, result: await challenge.json() as any };
  if (challenge.status !== 402) return { paid: false, error: `gateway returned ${challenge.status}` };

  const req = firstAccept(await challenge.json());
  if (!req) return { paid: false, error: "gateway sent no usable payment requirements" };

  const price = Number(req.maxAmountRequired);
  if (!Number.isFinite(price) || price <= 0) return { paid: false, error: "gateway quoted an unusable price" };
  if (spentThisRun + price > RUN_BUDGET) {
    return { paid: false, error: `screening budget ${RUN_BUDGET} ${CURRENCY} for this run is exhausted` };
  }
  if (req.asset?.currency !== CURRENCY || req.asset?.issuer !== accounts.issuer.address) {
    return { paid: false, error: "gateway asked to be paid in an unexpected asset" };
  }

  // Paid from the intel account only. The treasury is never touched for screening.
  const tx: Payment = {
    TransactionType: "Payment",
    Account: accounts.intel.address,
    Destination: req.payTo,
    Amount: { currency: CURRENCY, issuer: accounts.issuer.address, value: price.toString() },
    Memos: [{ Memo: {
      MemoType: convertStringToHex("mlinzi/x402-nonce"),
      MemoData: convertStringToHex(req.nonce),
    } }],
  };

  const res = await withLedger(client, () =>
    client.submitAndWait(tx, { autofill: true, wallet: wallet(accounts, "intel") }));
  const meta = res.result.meta;
  const code = typeof meta === "object" && meta ? meta.TransactionResult : "unknown";
  if (code !== "tesSUCCESS") return { paid: false, error: `screening payment failed: ${code}` };

  spentThisRun += price;
  const txHash = res.result.hash;
  const proof = Buffer.from(JSON.stringify({ txHash, nonce: req.nonce })).toString("base64");

  const settled = await fetch(url, { headers: { "x-payment": proof } });
  if (!settled.ok) {
    const body = await settled.json().catch(() => ({}));
    return { paid: true, cost: price, txHash, error: (body as any).error ?? `gateway returned ${settled.status}` };
  }

  return { paid: true, cost: price, txHash, result: await settled.json() as any };
}

export const screeningSpentThisRun = () => spentThisRun;

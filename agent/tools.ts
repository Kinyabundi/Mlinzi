import type Anthropic from "@anthropic-ai/sdk";
import type { Client, Payment } from "xrpl";
import { wallet, reportMemo, CURRENCY, type Accounts } from "../shared/xrpl.js";
import type { DecisionReport, Invoice, Proposal, ProposalResponse } from "../shared/types.js";
import { payeeFacts } from "./ledger.js";

const POLICY_URL = process.env.POLICY_URL ?? "http://127.0.0.1:4000";
const AGENT_TOKEN = process.env.AGENT_TOKEN!;

async function policy<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${POLICY_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${AGENT_TOKEN}`, ...init?.headers },
  });
  return (await res.json()) as T;
}

export const getInvoiceStatus = (invoiceId: string) =>
  policy<{ status: string }>(`/agent/invoices/${encodeURIComponent(invoiceId)}`);

export const toolDefs: Anthropic.Messages.Tool[] = [
  {
    name: "check_payee",
    description:
      "Free checks on a payee address: whether the business owner has approved it, and on-ledger facts " +
      "(exists, account age in hours, XRP balance, whether it can receive the stablecoin).",
    input_schema: {
      type: "object",
      properties: { address: { type: "string", description: "XRPL address of the payee" } },
      required: ["address"],
    },
  },
  {
    name: "propose_payment",
    description:
      "Sign and submit the invoice payment to the policy service. The policy service makes the final " +
      "decision; it may pay, or hold the payment for the business owner. Call exactly once per invoice.",
    input_schema: {
      type: "object",
      properties: {
        screening: { type: "string", enum: ["clean", "risky"], description: "Your verdict on the payee" },
        rationale: { type: "string", description: "One or two sentences explaining the verdict" },
      },
      required: ["screening", "rationale"],
    },
  },
];

export interface ToolContext {
  client: Client;
  accounts: Accounts;
  invoice: Invoice;
  evidence: Record<string, unknown>;
  result?: ProposalResponse;
}

export async function runTool(name: string, input: any, ctx: ToolContext): Promise<unknown> {
  const { client, accounts, invoice } = ctx;

  if (name === "check_payee") {
    // The agent may only ask about this invoice's payee.
    if (input.address !== invoice.payee) return { error: "can only check the payee named on this invoice" };
    const allow = await policy<{ allowlisted: boolean }>(`/agent/payees/${invoice.payee}`);
    const facts = await payeeFacts(client, invoice.payee, accounts.issuer.address);
    ctx.evidence.checkPayee = { ...allow, ...facts };
    return ctx.evidence.checkPayee;
  }

  if (name === "propose_payment") {
    if (ctx.result) return { error: "already proposed" };
    const report: DecisionReport = {
      invoiceId: invoice.invoiceId,
      payee: invoice.payee,
      amount: invoice.amount,
      currency: CURRENCY,
      screening: input.screening === "risky" ? "risky" : "clean",
      rationale: String(input.rationale ?? "").slice(0, 500),
      evidence: ctx.evidence,
      decidedAt: new Date().toISOString(),
    };

    // Payment fields come from the invoice, never from model output.
    const tx: Payment = {
      TransactionType: "Payment",
      Account: accounts.treasury.address,
      Destination: invoice.payee,
      Amount: { currency: CURRENCY, issuer: accounts.issuer.address, value: invoice.amount },
      Memos: [reportMemo(report).memo],
    };
    const prepared = await client.autofill(tx, 2);
    const txBlob = wallet(accounts, "agent").sign(prepared, true).tx_blob;

    const proposal: Proposal = { invoiceId: invoice.invoiceId, payee: invoice.payee, amount: invoice.amount, report, txBlob };
    ctx.result = await policy<ProposalResponse>("/proposals", { method: "POST", body: JSON.stringify(proposal) });
    return ctx.result;
  }

  return { error: `unknown tool ${name}` };
}

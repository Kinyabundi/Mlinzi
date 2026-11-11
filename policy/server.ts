/**
 * Mlinzi policy service. Holds the policy key (signer weight 1).
 *
 * Two callers, two tokens:
 *   agent    -> POST /proposals, GET /agent/*        (AGENT_TOKEN)
 *   operator -> everything under /operator/*        (OPERATOR_TOKEN)
 *
 *   npm run policy
 */
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { connect, loadAccounts, wallet, txLink } from "../shared/xrpl.js";
import type { Proposal, ProposalResponse, ProposalStatus } from "../shared/types.js";
import * as store from "./db.js";
import { evaluate } from "./rules.js";
import { verifyAgentBlob, cosignAndSubmit } from "./cosign.js";

const AGENT_TOKEN = process.env.AGENT_TOKEN;
const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN;
const PORT = Number(process.env.POLICY_PORT ?? 4000);
if (!AGENT_TOKEN || !OPERATOR_TOKEN || AGENT_TOKEN === OPERATOR_TOKEN) {
  throw new Error("Set distinct AGENT_TOKEN and OPERATOR_TOKEN in .env");
}

const accounts = loadAccounts();
const policyWallet = wallet(accounts, "policy");
const client = await connect();
const app = Fastify({ logger: { level: "info" } });

const requireToken = (token: string) => async (req: FastifyRequest, reply: FastifyReply) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    return reply.code(401).send({ error: "unauthorized" });
  }
};
const agentOnly = { preHandler: requireToken(AGENT_TOKEN) };
const operatorOnly = { preHandler: requireToken(OPERATOR_TOKEN) };

const view = (r: store.ProposalRow) => ({
  ...r, reasons: JSON.parse(r.reasons), report: JSON.parse(r.report), link: r.tx_hash ? txLink(r.tx_hash) : null,
});

async function pay(id: number, blob: string): Promise<ProposalResponse> {
  try {
    const hash = await cosignAndSubmit(client, blob, policyWallet);
    store.updateStatus(id, "paid", hash);
    return { status: "paid", reasons: [], txHash: hash };
  } catch (err) {
    store.updateStatus(id, "held");
    return { status: "held", reasons: [`submission failed: ${(err as Error).message}`] };
  }
}

// ---- Agent API ----

app.post<{ Body: Proposal }>("/proposals", agentOnly, async (req, reply) => {
  const p = req.body;
  const amount = Number(p.amount);
  const latest = store.latestForInvoice(p.invoiceId);

  if (latest?.status === "paid") return reply.code(409).send({ status: "refused", reasons: ["invoice already paid"] });
  if (latest?.status === "rejected") return reply.code(409).send({ status: "refused", reasons: ["operator rejected this invoice"] });

  const problems = verifyAgentBlob(p, accounts);
  if (problems.length) return reply.code(400).send({ status: "refused", reasons: problems });

  // Operator already approved this invoice: co-sign the fresh blob.
  if (latest?.status === "released") return pay(latest.id, p.txBlob);

  const { approve, reasons } = evaluate(p.payee, amount, p.report.screening);
  if (!approve) {
    if (latest?.status !== "held") {
      store.insertProposal({ invoiceId: p.invoiceId, payee: p.payee, amount, status: "held", reasons, report: p.report });
    }
    return { status: "held", reasons } satisfies ProposalResponse;
  }

  const id = store.insertProposal({ invoiceId: p.invoiceId, payee: p.payee, amount, status: "held", reasons: [], report: p.report });
  return pay(id, p.txBlob);
});

app.get<{ Params: { address: string } }>("/agent/payees/:address", agentOnly, async (req) => ({
  address: req.params.address, allowlisted: store.isAllowlisted(req.params.address),
}));

app.get<{ Params: { invoiceId: string } }>("/agent/invoices/:invoiceId", agentOnly, async (req) => {
  const latest = store.latestForInvoice(req.params.invoiceId);
  return { invoiceId: req.params.invoiceId, status: latest?.status ?? "new" };
});

// ---- Operator API (the agent's token cannot reach these) ----

app.get("/operator/policy", operatorOnly, async () => ({ ...store.getPolicy(), spentToday: store.spentToday() }));

app.put<{ Body: { perPaymentLimit: number; dailyLimit: number } }>("/operator/policy", operatorOnly, async (req, reply) => {
  const { perPaymentLimit, dailyLimit } = req.body;
  if (!(perPaymentLimit > 0 && dailyLimit >= perPaymentLimit)) {
    return reply.code(400).send({ error: "need perPaymentLimit > 0 and dailyLimit >= perPaymentLimit" });
  }
  store.setPolicy(perPaymentLimit, dailyLimit);
  return store.getPolicy();
});

app.get("/operator/payees", operatorOnly, async () => store.listPayees());

app.post<{ Body: { address: string; name: string } }>("/operator/payees", operatorOnly, async (req, reply) => {
  const { address, name } = req.body;
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address ?? "") || !name) {
    return reply.code(400).send({ error: "valid XRPL address and name required" });
  }
  store.addPayee(address, name);
  return { ok: true };
});

app.delete<{ Params: { address: string } }>("/operator/payees/:address", operatorOnly, async (req) => {
  store.removePayee(req.params.address);
  return { ok: true };
});

app.get<{ Querystring: { status?: ProposalStatus } }>("/operator/proposals", operatorOnly, async (req) =>
  store.listProposals(req.query.status).map(view));

app.post<{ Params: { id: string } }>("/operator/proposals/:id/release", operatorOnly, async (req, reply) => {
  const row = store.getProposal(Number(req.params.id));
  if (!row || row.status !== "held") return reply.code(404).send({ error: "no held proposal with that id" });
  store.updateStatus(row.id, "released");
  return { ok: true, note: "agent will re-sign and the policy service will co-sign on its next run" };
});

app.post<{ Params: { id: string } }>("/operator/proposals/:id/reject", operatorOnly, async (req, reply) => {
  const row = store.getProposal(Number(req.params.id));
  if (!row || row.status !== "held") return reply.code(404).send({ error: "no held proposal with that id" });
  store.updateStatus(row.id, "rejected");
  return { ok: true };
});

app.get("/health", async () => ({ ok: true, treasury: accounts.treasury.address }));

const shutdown = async () => { await app.close(); await client.disconnect(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: PORT, host: "127.0.0.1" });

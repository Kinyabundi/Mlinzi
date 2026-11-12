/**
 * Mlinzi screening gateway. Sells one payee screening per payment, over x402.
 *
 *   GET /screen?address=r...                 -> 402 with payment requirements
 *   GET /screen?address=r...  + X-PAYMENT    -> 200 with the screening result
 *
 * The agent pays from the `intel` account, whose float is the hard cap on what
 * screening can ever cost. Payment is verified on-ledger before any verdict is
 * returned, and each payment hash can be redeemed exactly once.
 *
 *   npm run gateway
 */
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { convertHexToString } from "xrpl";
import { connect, loadAccounts, CURRENCY } from "../shared/xrpl.js";
import * as store from "./db.js";
import { screenAddress } from "./screen.js";

const PORT = Number(process.env.GATEWAY_PORT ?? 4402);
const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN;
export const SCREENING_PRICE = Number(process.env.SCREENING_PRICE ?? "0.50");
const NETWORK = "xrpl-testnet";
const CHALLENGE_TTL_MS = 10 * 60_000;

const accounts = loadAccounts();
const client = await connect();
const app = Fastify({ logger: { level: "info" } });

const ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

interface PaymentPayload { txHash: string; nonce: string }

function requirements(address: string, nonce: string) {
  return {
    x402Version: 1,
    error: "payment required",
    accepts: [{
      scheme: "exact",
      network: NETWORK,
      resource: `/screen?address=${address}`,
      description: `Mlinzi payee screening for ${address}`,
      payTo: accounts.gateway.address,
      maxAmountRequired: SCREENING_PRICE.toFixed(2),
      asset: { currency: CURRENCY, issuer: accounts.issuer.address },
      nonce,
      // Put the nonce in a payment memo so the payment is bound to this request.
      memoHint: { MemoType: "mlinzi/x402-nonce", MemoData: nonce },
      maxTimeoutSeconds: CHALLENGE_TTL_MS / 1000,
    }],
  };
}

function decodePayment(header: string): PaymentPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    if (typeof parsed?.txHash === "string" && typeof parsed?.nonce === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

// Confirms on-ledger that this exact payment funded this exact request.
async function verifyPayment(p: PaymentPayload, address: string): Promise<string[]> {
  const problems: string[] = [];

  const challenge = store.getChallenge(p.nonce);
  if (!challenge) return ["unknown nonce"];
  if (challenge.address !== address) problems.push("nonce was issued for a different address");
  if (Date.now() - Date.parse(challenge.created_at + "Z") > CHALLENGE_TTL_MS) problems.push("challenge expired");
  if (store.isSpent(p.txHash)) problems.push("payment already redeemed");

  // The payer waited for validation on its own node; ours can lag a ledger or two
  // behind, so give it up to ~10s to catch up before refusing.
  let tx: any;
  let validated = false;
  for (let i = 0; i < 10; i++) {
    try {
      const res = await client.request({ command: "tx", transaction: p.txHash });
      tx = res.result.tx_json ?? res.result;
      (tx as any).meta ??= (res.result as any).meta;
      validated = !!res.result.validated;
      if (validated) break;
    } catch { /* not seen yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!tx) return [...problems, "payment not found on the ledger"];
  if (!validated) problems.push("payment is not validated yet");

  if (tx.TransactionType !== "Payment") problems.push("not a Payment");
  if (tx.Destination !== accounts.gateway.address) problems.push("payment was not sent to the gateway");

  const delivered = (tx as any).meta?.delivered_amount ?? tx.DeliverMax ?? tx.Amount;
  if (typeof delivered !== "object" || delivered.currency !== CURRENCY || delivered.issuer !== accounts.issuer.address) {
    problems.push(`payment must be ${CURRENCY} from the configured issuer`);
  } else if (Number(delivered.value) < challenge.price) {
    problems.push(`paid ${delivered.value}, price is ${challenge.price}`);
  }

  const memoHex: string | undefined = tx.Memos?.[0]?.Memo?.MemoData;
  if (!memoHex || convertHexToString(memoHex) !== p.nonce) problems.push("payment memo does not carry this nonce");

  if (!problems.length) {
    store.spend(p.txHash, p.nonce, address, Number(delivered.value));
  }
  return problems;
}

app.get<{ Querystring: { address?: string } }>("/screen", async (req, reply) => {
  const address = req.query.address ?? "";
  if (!ADDRESS_RE.test(address)) return reply.code(400).send({ error: "valid XRPL address required" });

  const header = req.headers["x-payment"];
  if (typeof header !== "string" || !header) {
    const nonce = randomBytes(16).toString("hex");
    store.putChallenge(nonce, address, SCREENING_PRICE);
    return reply.code(402).send(requirements(address, nonce));
  }

  const payment = decodePayment(header);
  if (!payment) return reply.code(400).send({ error: "X-PAYMENT header is not valid base64 JSON" });

  const problems = await verifyPayment(payment, address);
  if (problems.length) {
    const nonce = randomBytes(16).toString("hex");
    store.putChallenge(nonce, address, SCREENING_PRICE);
    return reply.code(402).send({ ...requirements(address, nonce), error: problems.join("; ") });
  }

  const receipt = { settled: true, txHash: payment.txHash, amount: SCREENING_PRICE.toFixed(2), network: NETWORK };
  reply.header("x-payment-response", Buffer.from(JSON.stringify(receipt)).toString("base64"));
  return screenAddress(client, address, accounts.issuer.address);
});

// ---- Operator API: the gateway's own risk intelligence ----

const operatorOnly = {
  preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
    if (!OPERATOR_TOKEN || req.headers.authorization !== `Bearer ${OPERATOR_TOKEN}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  },
};

app.get("/operator/denylist", operatorOnly, async () => store.listDeny());

app.post<{ Body: { address: string; reason: string } }>("/operator/denylist", operatorOnly, async (req, reply) => {
  const { address, reason } = req.body ?? ({} as any);
  if (!ADDRESS_RE.test(address ?? "") || !reason) {
    return reply.code(400).send({ error: "valid XRPL address and reason required" });
  }
  store.addDeny(address, reason);
  return { ok: true };
});

app.delete<{ Params: { address: string } }>("/operator/denylist/:address", operatorOnly, async (req) => {
  store.removeDeny(req.params.address);
  return { ok: true };
});

app.get("/operator/revenue", operatorOnly, async () => ({
  gateway: accounts.gateway.address, screeningsSold: store.revenue() / SCREENING_PRICE, revenue: store.revenue(),
}));

app.get("/health", async () => ({ ok: true, gateway: accounts.gateway.address, price: SCREENING_PRICE, currency: CURRENCY }));

const shutdown = async () => { await app.close(); await client.disconnect(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: PORT, host: "127.0.0.1" });

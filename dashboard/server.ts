/**
 * Mlinzi operator dashboard.
 *
 * Serves the operator UI and proxies it to the policy service and the gateway.
 * The operator token stays in this process; the browser never receives it, so a
 * tab left open is not a key left lying around.
 *
 *   npm run dashboard
 */
import Fastify from "fastify";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const PORT = Number(process.env.DASHBOARD_PORT ?? 4100);
const POLICY_URL = process.env.POLICY_URL ?? "http://127.0.0.1:4000";
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:4402";
const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN;
if (!OPERATOR_TOKEN) throw new Error("OPERATOR_TOKEN missing from .env");

const app = Fastify({ logger: { level: "warn" } });
const page = readFileSync("dashboard/index.html", "utf8");

// Only these upstream calls are reachable from the browser.
const ROUTES: Record<string, { base: string; path: (p: Record<string, string>) => string; method: string }> = {
  "policy":        { base: POLICY_URL,  method: "GET",    path: () => "/operator/policy" },
  "setPolicy":     { base: POLICY_URL,  method: "PUT",    path: () => "/operator/policy" },
  "payees":        { base: POLICY_URL,  method: "GET",    path: () => "/operator/payees" },
  "addPayee":      { base: POLICY_URL,  method: "POST",   path: () => "/operator/payees" },
  "removePayee":   { base: POLICY_URL,  method: "DELETE", path: (p) => `/operator/payees/${encodeURIComponent(p.address)}` },
  "proposals":     { base: POLICY_URL,  method: "GET",    path: (p) => `/operator/proposals${p.status ? `?status=${encodeURIComponent(p.status)}` : ""}` },
  "release":       { base: POLICY_URL,  method: "POST",   path: (p) => `/operator/proposals/${encodeURIComponent(p.id)}/release` },
  "reject":        { base: POLICY_URL,  method: "POST",   path: (p) => `/operator/proposals/${encodeURIComponent(p.id)}/reject` },
  "logs":          { base: POLICY_URL,  method: "GET",    path: (p) => `/operator/logs?after=${encodeURIComponent(p.after ?? "0")}` },
  "clearLogs":     { base: POLICY_URL,  method: "DELETE", path: () => "/operator/logs" },
  "denylist":      { base: GATEWAY_URL, method: "GET",    path: () => "/operator/denylist" },
  "addDeny":       { base: GATEWAY_URL, method: "POST",   path: () => "/operator/denylist" },
  "removeDeny":    { base: GATEWAY_URL, method: "DELETE", path: (p) => `/operator/denylist/${encodeURIComponent(p.address)}` },
  "revenue":       { base: GATEWAY_URL, method: "GET",    path: () => "/operator/revenue" },
};

// ---- Invoice inbox ----
// The inbox is the agent's input file, not policy state, so the dashboard owns
// it directly. Adding one here is the same as dropping an invoice on the desk:
// it grants nothing. The agent still has to propose it and the policy service
// still has to approve it.
const INBOX = "agent/inbox.json";
const ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

interface Invoice {
  invoiceId: string; supplierName: string; payee: string; amount: string; description: string;
}

const readInbox = (): Invoice[] => {
  if (!existsSync(INBOX)) return [];
  try {
    const parsed = JSON.parse(readFileSync(INBOX, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

function addInvoice(raw: Partial<Invoice>): { error: string } | { ok: true; invoice: Invoice } {
  const invoiceId = String(raw.invoiceId ?? "").trim();
  const supplierName = String(raw.supplierName ?? "").trim();
  const payee = String(raw.payee ?? "").trim();
  const amount = String(raw.amount ?? "").trim();
  const description = String(raw.description ?? "").trim();

  if (!invoiceId) return { error: "invoice number is required" };
  if (!supplierName) return { error: "supplier name is required" };
  if (!ADDRESS_RE.test(payee)) return { error: "payee must be a valid XRPL address" };
  if (!(Number(amount) > 0)) return { error: "amount must be greater than zero" };

  const inbox = readInbox();
  if (inbox.some((i) => i.invoiceId === invoiceId)) return { error: `${invoiceId} is already in the inbox` };

  const invoice: Invoice = { invoiceId, supplierName, payee, amount, description };
  writeFileSync(INBOX, JSON.stringify([...inbox, invoice], null, 2) + "\n");
  return { ok: true, invoice };
}

app.post<{ Body: { action: string; params?: Record<string, string>; body?: unknown } }>("/api", async (req, reply) => {
  if (req.body?.action === "invoices") return readInbox();
  if (req.body?.action === "addInvoice") {
    const result = addInvoice((req.body.body ?? {}) as Partial<Invoice>);
    return "error" in result ? reply.code(400).send(result) : result;
  }
  if (req.body?.action === "removeInvoice") {
    const id = req.body.params?.invoiceId;
    writeFileSync(INBOX, JSON.stringify(readInbox().filter((i) => i.invoiceId !== id), null, 2) + "\n");
    return { ok: true };
  }

  const route = ROUTES[req.body?.action];
  if (!route) return reply.code(400).send({ error: "unknown action" });

  try {
    // Only declare a JSON body when there is one: release/reject take none, and
    // an empty body with a JSON content-type is rejected upstream.
    const hasBody = req.body.body !== undefined && req.body.body !== null;
    const res = await fetch(`${route.base}${route.path(req.body.params ?? {})}`, {
      method: route.method,
      headers: {
        authorization: `Bearer ${OPERATOR_TOKEN}`,
        ...(hasBody ? { "content-type": "application/json" } : {}),
      },
      body: hasBody ? JSON.stringify(req.body.body) : undefined,
    });
    const text = await res.text();
    return reply.code(res.status).type("application/json")
      .send(text || JSON.stringify({ ok: res.ok }));
  } catch (err) {
    return reply.code(502).send({ error: `upstream unreachable: ${(err as Error).message}` });
  }
});

app.get("/", async (_req, reply) => reply.type("text/html").send(page));

await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`Mlinzi dashboard: http://127.0.0.1:${PORT}`);

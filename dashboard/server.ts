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
import { readFileSync } from "node:fs";

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

app.post<{ Body: { action: string; params?: Record<string, string>; body?: unknown } }>("/api", async (req, reply) => {
  const route = ROUTES[req.body?.action];
  if (!route) return reply.code(400).send({ error: "unknown action" });

  try {
    const res = await fetch(`${route.base}${route.path(req.body.params ?? {})}`, {
      method: route.method,
      // Only label it JSON when there is a body: Fastify rejects an empty JSON body with 400.
      headers: {
        authorization: `Bearer ${OPERATOR_TOKEN}`,
        ...(req.body.body ? { "content-type": "application/json" } : {}),
      },
      body: req.body.body ? JSON.stringify(req.body.body) : undefined,
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

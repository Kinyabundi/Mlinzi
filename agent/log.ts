import { randomUUID } from "node:crypto";

const POLICY_URL = process.env.POLICY_URL ?? "http://127.0.0.1:4000";
const AGENT_TOKEN = process.env.AGENT_TOKEN!;

export const runId = randomUUID().slice(0, 8);

export type LogKind = "run" | "invoice" | "thinking" | "thought" | "tool" | "result" | "verdict" | "outcome" | "skip" | "error";

// Shows the owner what the agent is doing on the dashboard. Best effort: a logging
// failure must never stop or change a payment, so errors are swallowed.
export async function logEvent(kind: LogKind, message: string, invoiceId?: string, data?: unknown): Promise<void> {
  try {
    await fetch(`${POLICY_URL}/agent/logs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${AGENT_TOKEN}` },
      body: JSON.stringify({ runId, invoiceId, kind, message, data }),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* ignore */ }
}

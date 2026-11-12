/**
 * The gateway's denylist, read by the policy service itself.
 *
 * The agent decides when to buy screening, so a denylist consulted only through
 * the agent is not a limit the agent cannot override: an agent that skips
 * screening — for good reasons or bad — skips the denylist with it. The policy
 * service therefore checks it directly, on every proposal, and fails closed.
 */
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:4402";
const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN;
const CACHE_MS = 30_000;

let cache: { at: number; addresses: Set<string> } | null = null;

export interface DenylistCheck { denied: boolean; reason?: string; unavailable?: boolean }

export async function checkDenylist(address: string): Promise<DenylistCheck> {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return cache.addresses.has(address)
      ? { denied: true, reason: "payee is on the screening gateway's denylist" }
      : { denied: false };
  }

  try {
    const res = await fetch(`${GATEWAY_URL}/operator/denylist`, {
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { denied: true, unavailable: true, reason: `screening gateway returned ${res.status}` };

    const rows = (await res.json()) as { address: string; reason: string }[];
    cache = { at: Date.now(), addresses: new Set(rows.map((r) => r.address)) };

    const hit = rows.find((r) => r.address === address);
    return hit
      ? { denied: true, reason: `payee is denylisted by the screening gateway: ${hit.reason}` }
      : { denied: false };
  } catch (err) {
    // Fail closed: an unreachable gateway holds the payment rather than waving it through.
    return { denied: true, unavailable: true, reason: `screening gateway unreachable: ${(err as Error).message}` };
  }
}

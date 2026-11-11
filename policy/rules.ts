import { getPolicy, isAllowlisted, spentToday } from "./db.js";

export interface Evaluation { approve: boolean; reasons: string[] }

// Deterministic rules. No LLM here: the agent cannot talk its way past them.
// Agent input (its screening verdict) can only make a decision stricter, never looser.
export function evaluate(payee: string, amount: number, screening: "clean" | "risky"): Evaluation {
  const policy = getPolicy();
  const reasons: string[] = [];

  if (!isAllowlisted(payee)) reasons.push("payee is not on the approved list");
  if (amount > policy.per_payment_limit) reasons.push(`amount ${amount} exceeds per-payment limit ${policy.per_payment_limit}`);
  const spent = spentToday();
  if (spent + amount > policy.daily_limit) reasons.push(`daily limit ${policy.daily_limit} would be exceeded (already paid ${spent} today)`);
  if (screening === "risky") reasons.push("agent screening flagged the payee as risky");

  return { approve: reasons.length === 0, reasons };
}

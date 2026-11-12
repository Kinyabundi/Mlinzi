# Mlinzi

An AI payout agent for small businesses, paying suppliers in a USD stablecoin on the XRP Ledger — **within limits it cannot override**.

*Mlinzi* is Swahili for "guardian".

The agent reads invoices, screens the supplier, and pays. The interesting part is what happens when it is wrong, compromised, or talked into something by a malicious invoice: **nothing moves**. The agent holds one signature out of a quorum of two. It can propose a payment; it can never make one.

---

## The core 

Most "AI agent with a wallet" designs put the private key behind the model and hope the prompt holds. Mlinzi assumes the prompt will fail and puts the limits somewhere the model cannot reach — in the ledger's own multisig rules, and in a deterministic policy service that holds the second key.

```
  invoice ──▶  AGENT  ──proposes──▶  POLICY SERVICE  ──co-signs──▶  XRP LEDGER
               (LLM)                  (no LLM, rules)                (2-of-N multisig)
                 │                          │                              │
            1 signature              1 signature                  needs quorum 2
                 │                          │                              │
                 └──── neither alone can move a cent ────────────────────▶ ✗
```

Three properties, each enforced by something other than the model:

| Guarantee | Enforced by | Proven by |
| --- | --- | --- |
| The agent cannot pay alone | XRPL signer list, quorum 2 | `tefBAD_QUORUM` |
| Nobody can bypass the quorum | Treasury master key disabled | `tefMASTER_DISABLED` |
| Only in-policy payments get the 2nd signature | Policy service rules (no LLM) | held queue |

The agent's own risk verdict is an input to the policy service, but a **one-way** one: it can make a decision stricter, never looser. An agent that says "clean" still gets refused if the payee is unapproved or the amount is over the limit.

---

## Architecture

Four processes, each holding only what it needs.

| Component | Port | Holds | Role |
| --- | --- | --- | --- |
| **Agent** (`agent/`) | — | agent signing key, `intel` spending key | Reads invoices, calls Claude, signs proposals |
| **Policy service** (`policy/`) | 4000 | policy signing key | Deterministic rules, co-signs, submits to the ledger |
| **Gateway** (`gateway/`) | 4402 | gateway receiving address | Sells paid payee screening over x402 |
| **Dashboard** (`dashboard/`) | 4100 | operator token | Operator UI; proxies the other two |

### Ledger accounts

Created on XRPL Testnet by `npm run setup:testnet`. Addresses are public ([`shared/accounts.public.json`](shared/accounts.public.json)); seeds live in `.secrets/` and are gitignored.

| Role | Funded | Purpose |
| --- | --- | --- |
| `issuer` | ✅ | Issues the test USD stablecoin |
| `treasury` | ✅ | Holds the float. Multisig, master key disabled |
| `agent` | — | Signing key only, weight 1 |
| `policy` | — | Signing key only, weight 1 |
| `operator` | — | Signing key only, weight 2 (can act alone in a break-glass) |
| `intel` | ✅ | Screening budget. Its float is the hard cap on screening spend |
| `gateway` | ✅ | Receives x402 screening fees |
| `supplierA` / `supplierB` | ✅ | Demo payees |

Signer list: **quorum 2** — agent (1) + policy (1) = 2 ✅, or operator (2) alone ✅, agent alone = 1 ✗.

---

## How a payment actually happens

1. **Agent** reads an invoice from `agent/inbox.json`.
2. Calls `check_payee` — free on-ledger facts: does the account exist, how old is it, can it receive the stablecoin, has the owner approved it.
3. Optionally calls `screen_payee` — **paid** risk screening bought from the gateway over x402 (see below).
4. Calls `propose_payment` with a `clean`/`risky` verdict. The agent signs a Payment from the treasury — but **the payment fields come from the invoice, never from model output**. The model supplies only a verdict and a rationale.
5. **Policy service** re-derives the transaction from the blob and checks it independently ([`policy/cosign.ts`](policy/cosign.ts)): right source, right destination, right amount and issuer, no `SendMax`/`DeliverMin`/`Paths`, no partial-payment flag, exactly one signature from the agent key, and a memo whose hash matches the decision report.
6. It then applies the owner's rules ([`policy/rules.ts`](policy/rules.ts)): allowlisted payee, per-payment limit, daily limit, agent's own risk flag — **and checks the screening gateway's denylist itself** ([`policy/intel.ts`](policy/intel.ts)), because the agent decides whether to buy screening and must not be the only thing standing between a denylisted payee and a payout. If the gateway is unreachable, the payment is held, not waved through.
7. Pass → policy co-signs and submits. Fail → the proposal is **held** for the operator.

A held payment is never co-signed later from a stale blob. Signed XRPL transactions expire (`LastLedgerSequence`), so "release" just marks the invoice approved; the agent signs a **fresh** payment on its next run. The operator key never leaves the operator.

### Audit trail

Every payment carries a memo holding the SHA-256 of the full decision report — verdict, rationale, and all evidence the agent saw. The report is stored in the policy database; the hash is on the public ledger. Anyone can verify after the fact that the stored reasoning is the reasoning that authorized that exact payment.

---

## Paid screening over x402

Free on-ledger checks only tell you so much. The gateway sells a deeper verdict, priced per call, paid on-ledger.

```
agent                                    gateway
  │  GET /screen?address=r...               │
  │ ─────────────────────────────────────▶  │
  │  ◀── 402 + {payTo, amount, nonce} ───── │
  │                                          │
  │  Payment: intel ──0.50 USD──▶ gateway   │   (nonce in a memo)
  │                                          │
  │  GET /screen + X-PAYMENT: {txHash}      │
  │ ─────────────────────────────────────▶  │   verifies on-ledger
  │  ◀── 200 {risk, signals} ────────────── │
```

Design notes that matter:

- **The verdict is deterministic** — operator denylist plus on-ledger signals (account age, activity, trust line, distinct counterparties). No LLM sits behind the paywall, so the agent cannot argue its way to a clean rating.
- **Payment is verified on-ledger before any verdict is returned** — correct destination, correct asset and issuer, sufficient amount, and a memo carrying that request's nonce.
- **Each payment hash redeems exactly once.** Replays are refused.
- **Spend is capped twice**: by `SCREENING_RUN_BUDGET` per agent run, and absolutely by the `intel` account's float. The treasury is never touched for screening.

---

## Tools used

| Area | Choice | Why |
| --- | --- | --- |
| Ledger | **XRP Ledger Testnet** | Native multisig with signer weights and quorum, native issued currencies, 3–5s settlement, memos for audit |
| Ledger SDK | **xrpl.js 4.7** | `multisign()`, `autofill(tx, signerCount)`, transaction decode for independent verification |
| Runtime | **Node.js 22**, ESM, `--env-file` | No dotenv dependency; native env loading |
| Language | **TypeScript 5.6**, strict | `tsc --noEmit` gates every step |
| Execution | **tsx** | Run TypeScript directly, no build step |
| HTTP | **Fastify 5** | Typed routes, per-route `preHandler` auth |
| Storage | **better-sqlite3 11** | Synchronous, single-file, WAL — no server to run |
| LLM | **@anthropic-ai/sdk 1.8**, Claude Sonnet | Tool use for the decide-then-act loop |
| Payments protocol | **x402** (HTTP 402) | Pay-per-call screening, settled on XRPL |

No framework for the agent loop — it is a plain `while` loop over `messages.create` with two tools. Readable, and easy to reason about when the question is "what could this thing do".

---

## Security model

What an attacker gets from each thing they compromise:

A load-bearing rule: **nothing that protects money may depend on the agent choosing to invoke it.** Every control below runs policy-side, on every proposal.

| Compromised | They can | They cannot |
| --- | --- | --- |
| The invoice (prompt injection) | Influence the model's verdict | Change payee or amount — those come from invoice fields, not model output; and policy rules still apply |
| The agent process + key | Propose payments | Pay anyone unapproved, exceed limits, or pay at all without the policy key |
| The policy service + key | Co-sign | Originate a payment — it only ever adds a signature to a blob the agent already signed |
| The agent token | Call `/proposals`, `/agent/*` | Reach any `/operator/*` endpoint (separate token, verified) |
| A browser tab with the dashboard open | Use the UI | Steal the operator token — it stays server-side and is never sent to the browser |

Deliberate choices:

- **Payment fields never come from model output.** The model returns a verdict; the code builds the transaction from the invoice.
- **The agent can only ask about its own invoice's payee** — `check_payee`/`screen_payee` refuse any other address.
- **Agent risk input is one-way.** `risky` can block a payment; `clean` can never unblock one.
- **No LLM in the policy service or the gateway.** Both are reproducible by the operator.
- **The gateway denylist is enforced by the policy service**, not by the agent remembering to screen, and it fails closed if the gateway is down.
- **Replay protection** on screening payments, and invoice-level idempotency (`paid`/`rejected` are terminal).

---

## Getting started

### Prerequisites

Node.js 20.6+ (for `--env-file`), npm, git, openssl. An Anthropic API key is needed only for the agent.

### Setup

```bash
npm install

# Create .env and generate two distinct service tokens
cp .env.example .env
sed -i.bak "s/^AGENT_TOKEN=.*/AGENT_TOKEN=$(openssl rand -hex 24)/" .env
sed -i.bak "s/^OPERATOR_TOKEN=.*/OPERATOR_TOKEN=$(openssl rand -hex 24)/" .env
rm .env.bak
# then set ANTHROPIC_API_KEY in .env
```

Build the ledger side — funds nine accounts, issues the stablecoin, sets the signer list, disables the treasury master key:

```bash
npm run setup:testnet
```

> Run this **once**. It writes `.secrets/accounts.json`. Re-running with `--force` creates entirely new accounts and abandons the old treasury.

Prove the guarantee before trusting anything else:

```bash
npm run test:multisig
```

Expect: agent alone → `tefBAD_QUORUM`, master key → `tefMASTER_DISABLED`, agent+policy → paid.

### Running

Four terminals, or background them:

```bash
npm run policy      # :4000  — rules + co-signing
npm run gateway     # :4402  — x402 screening
npm run dashboard   # :4100  — operator UI
npm run seed        # demo limits, approved payee, 3 invoices
npm run agent       # process the inbox
```

Then open **http://127.0.0.1:4100**.

### Scripts

| Command | Does |
| --- | --- |
| `npm run setup:testnet` | Create accounts, issue currency, lock the treasury |
| `npm run test:multisig` | Prove agent-alone and master-key both fail, co-sign succeeds |
| `npm run policy` | Policy service |
| `npm run gateway` | x402 screening gateway |
| `npm run dashboard` | Operator dashboard |
| `npm run seed` | Seed demo limits, payee and invoices |
| `npm run agent` | Process every unpaid invoice once |
| `npm run typecheck` | `tsc --noEmit` |

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `XRPL_WS` | testnet altnet | Ledger endpoint — **testnet only** |
| `AGENT_TOKEN` / `OPERATOR_TOKEN` | — | Must be set and must differ |
| `ANTHROPIC_API_KEY` | — | Agent only |
| `ANTHROPIC_WORKSPACE_ID` | — | Only for org-level (non-workspace-scoped) keys |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | |
| `SCREENING_PRICE` | `0.50` | Gateway price per screening |
| `SCREENING_RUN_BUDGET` | `5` | Max screening spend per agent run |

---

## API

### Policy service — agent token

| Endpoint | Does |
| --- | --- |
| `POST /proposals` | Submit a signed payment proposal |
| `GET /agent/payees/:address` | Is this payee approved |
| `GET /agent/invoices/:invoiceId` | Invoice status |

### Policy service — operator token

| Endpoint | Does |
| --- | --- |
| `GET`/`PUT /operator/policy` | Read/set per-payment and daily limits |
| `GET`/`POST`/`DELETE /operator/payees` | Manage the approved list |
| `GET /operator/proposals?status=` | List proposals with full reports |
| `POST /operator/proposals/:id/release` | Approve a held invoice |
| `POST /operator/proposals/:id/reject` | Refuse it permanently |

### Gateway

| Endpoint | Does |
| --- | --- |
| `GET /screen?address=` | 402 without payment; verdict with a valid `X-PAYMENT` |
| `GET`/`POST /operator/denylist` | Manage gateway risk intelligence |
| `GET /operator/revenue` | Screenings sold |

---

## Project layout

```
agent/        run.ts (LLM loop) · tools.ts · ledger.ts · screening.ts (x402 client)
policy/       server.ts · rules.ts (deterministic) · cosign.ts (verify + co-sign) · db.ts
gateway/      server.ts (x402) · screen.ts (deterministic screening) · db.ts
dashboard/    server.ts (token-holding proxy) · index.html
scripts/      setup-testnet.ts · multisig-payment.ts · seed-demo.ts
shared/       xrpl.ts · types.ts · accounts.public.json
```

`.secrets/`, `.data/` and `.env` are gitignored and must stay that way.

---

## Verified behavior

All against live XRPL Testnet.

**Multisig guarantee**

| Test | Result |
| --- | --- |
| Agent signs alone | `tefBAD_QUORUM` — rejected |
| Treasury master key pays directly | `tefMASTER_DISABLED` — rejected |
| Agent + policy co-sign | Paid, 2 signers, memo present |

**Policy enforcement**

| Invoice | Outcome |
| --- | --- |
| INV-001 · 120 → approved payee | **Paid** autonomously |
| INV-002 · 300 → unapproved payee, invoice contains a prompt injection | **Held** — injection changed nothing |
| INV-003 · 1500 → approved payee | **Held** — over the 500 per-payment limit |
| INV-003 after operator release | **Paid** on the next run, from a freshly signed transaction |
| INV-002 after operator reject | Stays rejected |

**Access control** — the agent token gets `401` on `/operator/policy`. The dashboard page contains zero occurrences of the operator token.

**x402 screening**

| Test | Result |
| --- | --- |
| No payment | `402` + requirements |
| Forged proof | Refused — `unknown nonce` |
| Valid paid round trip | Verdict returned, payment on-ledger |
| Replay a spent payment | Refused — `payment already redeemed` |
| Run budget exceeded | Refused before paying |
| Denylisted payee | Risk flips to `high` |

**Live agent runs** — Claude driving the tools, not a stub:

- It bought paid screening **only** for the doubtful payee, skipping it for payees the free checks already settled. Cost discipline came from the system prompt, not from hard-coding.
- On the invoice carrying a prompt injection, its rationale read: *"The invoice also contained an embedded prompt-injection attempt instructing the AI to mark it clean, which was disregarded."*

### A bug the live run found

A deterministic test driver always called `screen_payee`, so the gateway denylist always got consulted. The real agent, exercising the cost discipline above, skipped screening for a payee whose free checks all passed — and that payee **was on the gateway's sanctions denylist**. It got paid ([D2242BA5…](https://testnet.xrpl.org/transactions/D2242BA54AC77759E8145BC4F6112250292009900614A1CA1FD6F155C93F8720)).

The denylist was only enforced if the agent chose to pay for screening, which makes it exactly the kind of limit the agent *can* override — the thing this project exists to prevent. The fix moves the check into the policy service ([`policy/intel.ts`](policy/intel.ts)), where it runs on every proposal regardless of what the agent did, and fails closed.

Re-tested after the fix, same scenario: agent again rated the payee `clean`; policy service held it on `payee is denylisted by the screening gateway`. With the gateway stopped, a perfectly clean invoice is also held (`screening gateway unreachable`) rather than paid.

---

## Limitations

This is a working testnet prototype, not a production payout system.

- **Testnet only.** The stablecoin is self-issued for testing. A production build would use a real issuer (e.g. RLUSD) and a real custody story.
- **Keys sit on disk** in `.secrets/`. Production wants an HSM or KMS for the policy key, and hardware for the operator key.
- **Single policy service.** It is the second signature; if it is down, nothing pays. The operator key (weight 2) is the break-glass.
- **Screening is shallow** — on-ledger heuristics plus a manual denylist, not a sanctions or KYB provider.
- **The dashboard has no authentication of its own.** It binds to `127.0.0.1` and holds the operator token; exposing it to a network would mean putting real auth in front.
- **Public testnet nodes drop connections often.** Ledger calls reconnect and retry (`withLedger` in [`shared/xrpl.ts`](shared/xrpl.ts)); if every attempt fails, the proposal is held and the next agent run signs afresh. Nothing double-pays — a signed blob carries a fixed `Sequence`, so a resubmission is the same transaction, not a second one.

---

## NEW — dashboard, agent activity and test pass (13 Nov)

Everything below was added after the sections above. It covers what changed, what we tested by hand on testnet, and what we would do next.

### What changed

**Dashboard ([`dashboard/index.html`](dashboard/index.html), [`dashboard/server.ts`](dashboard/server.ts))**
- Friendlier layout and plain wording: *Spending limits*, *Trusted suppliers*, *Payment requests*, *Scam check*. Statuses read "Needs your OK", "Approved", "Paid", "Rejected". Release is now labelled **Approve**.
- A **?** next to each card title explains what the card is for on hover.
- **Agent activity** panel (button in the top bar): a live feed of what the agent is doing — invoice picked up, checks run, what it found, its reasoning, its verdict, and the policy service's decision. Refreshes every 2.5s; **Clear** wipes it.
- **Over-limit safeguards:** approving a held payment that is above your limits opens a confirm box first ("This is 1500, your limit per payment is 500. Approve anyway?"). An amber pill on Spending limits ("1 payment today went over your limits") lists those payments when clicked. "Left today" no longer goes below 0.
- **Unblock** button on the Scam check denylist.

**Agent activity backend**
- [`agent/log.ts`](agent/log.ts): the agent posts each step to the policy service. Best effort — if logging fails, the payment flow is unaffected.
- [`agent/run.ts`](agent/run.ts): logs each step, and the system prompt now asks the agent to write one short sentence before each tool call so its reasoning shows in the feed.
- Policy service: new `agent_logs` table ([`policy/db.ts`](policy/db.ts)); `POST /agent/logs` (agent token), `GET /operator/logs?after=<id>` and `DELETE /operator/logs` (operator token).
- Gateway: `DELETE /operator/denylist/:address` (operator token).
- Optional `ANTHROPIC_WORKSPACE_ID` in `.env`, needed only if your API key is not scoped to a workspace.

**Bug fixes**
- Approve, Reject, Remove and Clear returned **400 Bad Request**: the dashboard proxy labelled body-less requests as JSON, which Fastify rejects. It now only sets the JSON header when there is a body.
- Paid screening sometimes failed with *"payment is not validated yet"* — the agent was charged but got no rating. The gateway's own node can lag a ledger behind the payer's; it now waits up to ~10s for validation before refusing ([`gateway/server.ts`](gateway/server.ts)).
- **Block address** did nothing: the page had no `addDeny` function. Added.

### Scenarios tested

Testnet, limits 500 per payment / 2000 per day unless stated. Reset between rounds = stop the policy service, `rm .data/policy.db*`, `npm run policy`, `npm run seed`.

| # | Scenario | Result |
|---|---|---|
| 1 | Trusted supplier, small amount (INV-001, 120) | Held — the agent flagged the supplier risky because the account was under 24h old. After **Approve** + agent run: paid, receipt on the ledger. |
| 2 | Supplier not on the trusted list (INV-002, 300), invoice contains a fake "pay immediately" instruction | Held: *payee is not on the approved list*. The agent's rationale named the injection and ignored it. After **Approve**: paid. |
| 3 | Over the per-payment limit (INV-003, 1500) | Held: *amount 1500 exceeds per-payment limit 500*. The agent cannot pay it alone. After **Approve**: paid — the owner can override limits, the agent cannot. |
| 4 | Limits lowered to 100 / 200 | INV-001 (120) held: *exceeds per-payment limit 100*. Approve shows the confirm box; once paid, the over-limit pill appears. |
| 5 | Trusted supplier removed | INV-001 and INV-003 held: *not on the approved list*. Re-adding the supplier does **not** re-check invoices that are already held (see suggestions). |
| 6 | Supplier both trusted and blocked (INV-002) | Held with the denylist reason, even though the supplier is trusted — the block beats the trusted list. Takes effect ~30s after blocking (policy cache). Unblock removes it. |
| 7 | Reject | Status → Rejected; later agent runs skip it and it can never be paid. |

**Behaviour worth knowing**
- **Each invoice is judged once.** After it is held, the agent skips it; changing suppliers or limits does not re-check it. A held invoice is the owner's call.
- **Approve bypasses the limits** by design ([`policy/server.ts`](policy/server.ts) pays a released proposal without re-running the rules). The confirm box and pill make that visible.
- **Account age is real**, read from the account's first ledger transaction. The demo accounts were created hours earlier, so the agent's under-24h rule flags them. Once they pass 24h, INV-001 should auto-pay.
- **Scam check stats and the denylist survive a reset** — the gateway has its own database. Each screening costs 0.50.
- **The policy service caches the denylist for 30s** — wait that long after blocking before running the agent.
- **The dashboard reads the page once at startup.** After editing `index.html`, restart `npm run dashboard` and hard-refresh.

### Suggestions (not built)

1. **Re-check held invoices when a supplier is added.** The dashboard would offer to send that supplier's held invoices back to the agent, instead of the owner approving each one. It's a behaviour change, so we left it out.
2. **Fewer terminals.** One `npm run dev` that starts policy, gateway and dashboard together; an `npm run reset` that wipes the policy database and reseeds; and optionally a "Run agent" button on the dashboard. Testing currently needs 4 terminals and a manual reset each round.
3. **Serve the dashboard page fresh on each request in development**, so edits show without a restart. A stale page caused confusion twice during testing.

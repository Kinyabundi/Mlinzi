# Mlinzi

An AI payout agent for small businesses, paying suppliers in a USD stablecoin on the XRP Ledger — **within limits it cannot override**.

*Mlinzi* is Swahili for "guardian".

The agent reads invoices, screens the supplier, and pays. The interesting part is what happens when it is wrong, compromised, or talked into something by a malicious invoice: **nothing moves**. The agent holds one signature out of a quorum of two. It can propose a payment; it can never make one.

---

## The core idea

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
6. It then applies the owner's rules ([`policy/rules.ts`](policy/rules.ts)): allowlisted payee, per-payment limit, daily limit, agent's own risk flag.
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

**The test that matters most** — INV-004, 200 to a payee that was approved, had a trust line, and was within limits. Every free check passed. Paid screening rated it `high`, the agent reported `risky`, and the policy service held it. Paid screening was the only thing between that invoice and an autonomous payout.

---

## Limitations

This is a working testnet prototype, not a production payout system.

- **Testnet only.** The stablecoin is self-issued for testing. A production build would use a real issuer (e.g. RLUSD) and a real custody story.
- **Keys sit on disk** in `.secrets/`. Production wants an HSM or KMS for the policy key, and hardware for the operator key.
- **Single policy service.** It is the second signature; if it is down, nothing pays. The operator key (weight 2) is the break-glass.
- **Screening is shallow** — on-ledger heuristics plus a manual denylist, not a sanctions or KYB provider.
- **The dashboard has no authentication of its own.** It binds to `127.0.0.1` and holds the operator token; exposing it to a network would mean putting real auth in front.
- **No automatic retry** for transient XRPL disconnects; a failed submit holds the proposal and the next agent run re-signs.

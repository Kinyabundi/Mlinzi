/**
 * Proves the core guarantee before any agent code exists:
 *   A. the agent's signature alone cannot move treasury funds
 *   B. the treasury's own master key no longer works
 *   C. agent + policy signatures together do pay the supplier
 *
 *   npm run test:multisig
 */
import { multisign, type Payment, type Client } from "xrpl";
import {
  connect, loadAccounts, wallet, txLink, reportMemo, CURRENCY,
} from "../shared/xrpl.js";

async function expectRejected(client: Client, blob: string, label: string) {
  const { result } = await client.submit(blob);
  const ok = result.engine_result !== "tesSUCCESS";
  console.log(`  ${ok ? "✓" : "✗"} ${label}: ${result.engine_result}${ok ? " (rejected, as intended)" : " — SHOULD HAVE FAILED"}`);
  if (!ok) throw new Error(`${label} unexpectedly succeeded`);
}

async function main() {
  const accounts = loadAccounts();
  const client = await connect();
  const issuer = accounts.issuer.address;

  try {
    // Stand-in for the agent's decision report; the real one comes from the agent.
    const report = {
      invoice: "INV-DEMO-001",
      payee: accounts.supplierA.address,
      amount: "120",
      checks: { allowlisted: true, withinLimits: true, screening: "clean" },
      decidedAt: new Date().toISOString(),
    };
    const { hash: reportHash, memo } = reportMemo(report);

    const base: Payment = {
      TransactionType: "Payment",
      Account: accounts.treasury.address,
      Destination: accounts.supplierA.address,
      Amount: { currency: CURRENCY, issuer, value: report.amount },
      Memos: [memo],
    };

    // Fee scales with the number of signers, so tell autofill to expect 2.
    const prepared = await client.autofill(base, 2);

    const agentBlob = wallet(accounts, "agent").sign(prepared, true).tx_blob;
    const policyBlob = wallet(accounts, "policy").sign(prepared, true).tx_blob;

    console.log("A. Agent signs alone");
    await expectRejected(client, multisign([agentBlob]), "agent-only payment");

    console.log("B. Treasury master key tries to pay directly");
    const direct = await client.autofill({ ...base });
    const masterBlob = wallet(accounts, "treasury").sign(direct).tx_blob;
    await expectRejected(client, masterBlob, "master-key payment");

    console.log("C. Agent + policy service co-sign");
    const res = await client.submitAndWait(multisign([agentBlob, policyBlob]));
    const meta = res.result.meta;
    const code = typeof meta === "object" && meta ? meta.TransactionResult : "unknown";
    if (code !== "tesSUCCESS") throw new Error(`co-signed payment failed: ${code}`);
    console.log(`  ✓ paid ${report.amount} ${CURRENCY} to supplierA  ${txLink(res.result.hash)}`);
    console.log(`  ✓ memo carries report hash ${reportHash.slice(0, 16)}…`);

    const balances = await client.getBalances(accounts.supplierA.address);
    const usd = balances.find((b) => b.currency === CURRENCY);
    console.log(`\nsupplierA now holds ${usd?.value ?? "0"} ${CURRENCY}`);
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

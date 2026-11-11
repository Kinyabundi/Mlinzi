/**
 * Mlinzi testnet setup.
 *
 * Creates every account, issues the test stablecoin, and locks the treasury
 * behind a 2-of-N multisig with its master key disabled.
 *
 *   npm run setup:testnet            # first run
 *   npm run setup:testnet -- --force # start over with fresh accounts
 */
import { Wallet, AccountSetAsfFlags, type Client, type SubmittableTransaction } from "xrpl";
import { existsSync } from "node:fs";
import {
  connect, saveAccounts, accountLink, txLink, CURRENCY, SECRETS_PATH,
  type Accounts, type Role,
} from "../shared/xrpl.js";

const FUNDED: Role[] = ["issuer", "treasury", "intel", "gateway", "supplierA", "supplierB"];
// Signer keys only sign; they never hold funds, so no faucet call is needed.
const SIGNERS: Role[] = ["agent", "policy", "operator"];
const HOLDERS: Role[] = ["treasury", "intel", "gateway", "supplierA", "supplierB"];

const TREASURY_FLOAT = "10000";
const INTEL_FLOAT = "25"; // hard cap on what the agent can spend on screening

async function submit(client: Client, tx: SubmittableTransaction, signer: Wallet, label: string) {
  const res = await client.submitAndWait(tx, { autofill: true, wallet: signer });
  const meta = res.result.meta;
  const code = typeof meta === "object" && meta ? meta.TransactionResult : "unknown";
  if (code !== "tesSUCCESS") throw new Error(`${label} failed: ${code}`);
  console.log(`  ✓ ${label}  ${txLink(res.result.hash)}`);
}

async function main() {
  if (existsSync(SECRETS_PATH) && !process.argv.includes("--force")) {
    console.error(`${SECRETS_PATH} already exists. Use --force to recreate accounts.`);
    process.exit(1);
  }

  const client = await connect();
  const accounts = {} as Accounts;

  try {
    console.log("1. Funding accounts from the testnet faucet");
    for (const role of FUNDED) {
      const { wallet } = await client.fundWallet();
      accounts[role] = { address: wallet.address, seed: wallet.seed! };
      console.log(`  ✓ ${role.padEnd(9)} ${wallet.address}`);
    }
    for (const role of SIGNERS) {
      const w = Wallet.generate();
      accounts[role] = { address: w.address, seed: w.seed! };
      console.log(`  ✓ ${role.padEnd(9)} ${w.address} (signing key only)`);
    }
    saveAccounts(accounts); // save early so a later failure doesn't lose keys

    const w = (role: Role) => Wallet.fromSeed(accounts[role].seed);
    const issuer = accounts.issuer.address;

    console.log("2. Issuer: enable rippling so holders can pay each other");
    await submit(client, {
      TransactionType: "AccountSet",
      Account: issuer,
      SetFlag: AccountSetAsfFlags.asfDefaultRipple,
    }, w("issuer"), "DefaultRipple on issuer");

    console.log(`3. Trust lines to ${CURRENCY} issuer`);
    for (const role of HOLDERS) {
      await submit(client, {
        TransactionType: "TrustSet",
        Account: accounts[role].address,
        LimitAmount: { currency: CURRENCY, issuer, value: "1000000" },
      }, w(role), `trust line: ${role}`);
    }

    console.log("4. Issue test stablecoin");
    for (const [role, value] of [["treasury", TREASURY_FLOAT], ["intel", INTEL_FLOAT]] as const) {
      await submit(client, {
        TransactionType: "Payment",
        Account: issuer,
        Destination: accounts[role].address,
        Amount: { currency: CURRENCY, issuer, value },
      }, w("issuer"), `issue ${value} ${CURRENCY} to ${role}`);
    }

    console.log("5. Treasury signer list: quorum 2 (agent 1, policy 1, operator 2)");
    await submit(client, {
      TransactionType: "SignerListSet",
      Account: accounts.treasury.address,
      SignerQuorum: 2,
      SignerEntries: [
        { SignerEntry: { Account: accounts.agent.address, SignerWeight: 1 } },
        { SignerEntry: { Account: accounts.policy.address, SignerWeight: 1 } },
        { SignerEntry: { Account: accounts.operator.address, SignerWeight: 2 } },
      ],
    }, w("treasury"), "SignerListSet");

    console.log("6. Disable treasury master key (multisig is now the only way in)");
    await submit(client, {
      TransactionType: "AccountSet",
      Account: accounts.treasury.address,
      SetFlag: AccountSetAsfFlags.asfDisableMaster,
    }, w("treasury"), "DisableMaster on treasury");

    console.log("\nDone. Treasury:", accountLink(accounts.treasury.address));
    console.log(`Seeds: ${SECRETS_PATH} (gitignored). Addresses: shared/accounts.public.json`);
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Contracts between the agent and the policy service.

export interface DecisionReport {
  invoiceId: string;
  payee: string;
  amount: string;
  currency: string;
  screening: "clean" | "risky";
  rationale: string;
  evidence: Record<string, unknown>;
  decidedAt: string;
}

export interface Proposal {
  invoiceId: string;
  payee: string;
  amount: string;
  report: DecisionReport;
  txBlob: string; // Payment from treasury, signed by the agent key (multisign)
}

export type ProposalStatus = "held" | "released" | "rejected" | "paid";

export interface ProposalResponse {
  status: ProposalStatus | "refused";
  reasons: string[];
  txHash?: string;
}

export interface Invoice {
  invoiceId: string;
  supplierName: string;
  payee: string;
  amount: string;
  description: string;
}

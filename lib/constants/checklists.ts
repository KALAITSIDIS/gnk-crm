/**
 * KYC + banking-readiness checklist definitions (doc 02 §C3).
 * Stored per contact as jsonb: kyc = { [key]: { done, note, doc_link } },
 * banking_readiness = structured fields below.
 */

export const KYC_ITEMS = [
  ["passport_id", "Passport / ID"],
  ["proof_of_address", "Proof of address"],
  ["sof_declaration", "Source-of-funds declaration"],
  ["sof_evidence", "Source-of-funds evidence"],
  ["sanctions_self_declaration", "Sanctions self-declaration"],
  ["pep_declaration", "PEP declaration"],
] as const;

export type KycItemKey = (typeof KYC_ITEMS)[number][0];

export interface KycItemState {
  done?: boolean;
  note?: string;
  doc_link?: string;
}

export type KycState = Partial<Record<KycItemKey, KycItemState>>;

export const ACCOUNT_FEASIBILITY = ["yes", "maybe", "no"] as const;

export interface BankingReadinessState {
  nationality_risk_note?: string;
  funds_origin_country?: string;
  bank_pre_check_done?: boolean;
  account_feasibility?: (typeof ACCOUNT_FEASIBILITY)[number];
}

export function kycCompletion(kyc: KycState): number {
  const done = KYC_ITEMS.filter(([key]) => kyc[key]?.done).length;
  return Math.round((done / KYC_ITEMS.length) * 100);
}

export function bankingCompletion(b: BankingReadinessState): number {
  const checks = [
    Boolean(b.nationality_risk_note?.trim()),
    Boolean(b.funds_origin_country?.trim()),
    b.bank_pre_check_done === true,
    Boolean(b.account_feasibility),
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

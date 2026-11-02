/** A vendor's trades (ADR 0077); the migration's CHECK repeats them. */
export const VENDOR_CATEGORIES = [
  'maintenance',
  'cleaning',
  'security',
  'landscaping',
  'pest_control',
  'supplies',
  'utilities',
  'professional',
  'other',
] as const;
export type VendorCategory = (typeof VENDOR_CATEGORIES)[number];

/** A vendor's papers; the migration's CHECK repeats them. */
export const VENDOR_DOCUMENT_KINDS = [
  'commercial_register',
  'tax_card',
  'licence',
  'insurance',
  'safety_certificate',
  'contract_copy',
  'other',
] as const;
export type VendorDocumentKind = (typeof VENDOR_DOCUMENT_KINDS)[number];

export const VENDOR_STATUSES = ['active', 'suspended'] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];

/** What an evaluation scores, each 1 to 5. */
export const EVALUATION_CRITERIA = [
  'quality',
  'timeliness',
  'cost',
  'communication',
  'safety',
] as const;
export type EvaluationCriterion = (typeof EVALUATION_CRITERIA)[number];

export const VENDOR_LIMITS = {
  name: 120,
  legalName: 200,
  contactName: 120,
  address: 300,
  notes: 1000,
  evaluationNote: 1000,
} as const;
/** A commercial register or tax number as written on the paper. */
export const REGISTRY_NUMBER = /^[A-Za-z0-9/-]{1,40}$/;
export const DOCUMENT_NUMBER = /^[A-Za-z0-9/. -]{1,60}$/;
export const VENDOR_PHONE = /^[0-9+() -]{3,30}$/;
/** Live papers one vendor holds at most. */
export const VENDOR_DOCUMENTS_MAX = 50;
/** A paper's expiry is announced this many days ahead, once per date. */
export const VENDOR_DOCUMENT_NOTICE_DAYS = 30;
/** The evaluations a vendor's average reads: the last year's. */
export const EVALUATION_WINDOW_DAYS = 365;

/** The number as shown, as the board's (AR-0001): V-0001. */
export const vendorReference = (n: number) => `V-${String(n).padStart(4, '0')}`;

/** The average of the scores, to one decimal, or null with none. */
export function averageScore(
  rows: readonly Record<EvaluationCriterion, number>[],
): Record<EvaluationCriterion | 'overall', number | null> {
  const avg = (xs: number[]) =>
    xs.length
      ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10
      : null;
  const per = Object.fromEntries(
    EVALUATION_CRITERIA.map((c) => [c, avg(rows.map((r) => r[c]))]),
  ) as Record<EvaluationCriterion, number | null>;
  return {
    ...per,
    overall: avg(
      rows.map(
        (r) =>
          EVALUATION_CRITERIA.reduce((a, c) => a + r[c], 0) /
          EVALUATION_CRITERIA.length,
      ),
    ),
  };
}

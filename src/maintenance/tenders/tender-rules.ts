// ============================================================================
// Tenders (ADR 0088)
// ============================================================================
//
// The states and limits a tender's routes check under its row lock; the
// migration's CHECKs and trigger repeat them.

/** draft → open → opening → opened → awarded; any but awarded → cancelled. */
export const TENDER_STATUSES = [
  'draft',
  'open',
  'opening',
  'opened',
  'awarded',
  'cancelled',
] as const;
export type TenderStatus = (typeof TENDER_STATUSES)[number];

/** What may be called off: anything not yet awarded or called off. */
export const CANCELLABLE: readonly TenderStatus[] = [
  'draft',
  'open',
  'opening',
  'opened',
];

export const INVITATION_KINDS = ['vendor', 'link'] as const;
export type InvitationKind = (typeof INVITATION_KINDS)[number];

export const TENDER_LIMITS = {
  title: { min: 3, max: 200 },
  scope: { min: 1, max: 4000 },
  documentTitle: { min: 1, max: 120 },
  companyName: { min: 2, max: 200 },
  note: { min: 1, max: 2000 },
  durationDays: { min: 1, max: 3650 },
  /** A tender's live documents. */
  documents: 20,
  /** A tender's live invitations. */
  invitations: 100,
  /** The deadline is at most a year ahead. */
  maxDaysAhead: 366,
  /** At least an hour ahead when it is published. */
  minLeadMinutes: 60,
};

/** `TN-000123`: the compound's tender number. */
export const tenderReference = (n: number) =>
  `TN-${String(n).padStart(6, '0')}`;

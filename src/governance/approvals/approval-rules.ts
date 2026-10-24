import {
  APPROVAL_TYPES,
  THRESHOLD_TYPES,
  type ApprovalType,
} from '../../core/board-matters/board-matters';

export { APPROVAL_TYPES, THRESHOLD_TYPES };

/** The settings' rows: every approval type, and appeals to the board. */
/**
 * A deadline per approval type and for appeals to the board, and (ADR
 * 0059) the days owners may object to a published decision.
 */
export const SETTING_TYPES = [
  ...APPROVAL_TYPES,
  'board_appeal',
  'objection',
] as const;
export type SettingType = (typeof SETTING_TYPES)[number];

/** A new compound's deadlines, in days (the migration's backfill too). */
export const DEFAULT_DEADLINE_DAYS: Record<SettingType, number> = {
  annual_budget: 30,
  budget_increase: 14,
  major_contract: 14,
  exceptional_fee: 14,
  waiver_above_limit: 14,
  payment_plan_above_limit: 14,
  legal_escalation: 14,
  board_appeal: 30,
  objection: 14,
};

export const DEADLINE_DAYS = { min: 1, max: 90 } as const;

/** The types whose request names a subject: what the handler takes. */
export const SUBJECT_TYPES: readonly ApprovalType[] = [
  'annual_budget',
  'budget_increase',
];

export const APPROVAL_LIMITS = {
  context: 4000,
  impact: 2000,
  alternative: 1000,
  alternatives: 5,
  attachments: 5,
  implementationNote: 1000,
  rationale: 4000,
  alternativesNote: 2000,
} as const;

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'withdrawn',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** What the lists filter by: `approved` waits to be implemented. */
export const APPROVAL_FILTERS = [
  'pending',
  'approved',
  'implemented',
  'rejected',
  'withdrawn',
] as const;
export type ApprovalFilter = (typeof APPROVAL_FILTERS)[number];

/** The number as shown, as polls' (GP-0001): AR-0001. */
export const approvalReference = (n: number) =>
  `AR-${String(n).padStart(4, '0')}`;

/** How an approved request is followed up (ADR 0059); a unit test pins the CHECK. */
export const APPROVAL_PROGRESS_STATUSES = [
  'in_progress',
  'implemented',
  'cannot_implement',
] as const;
export type ApprovalProgressStatus =
  (typeof APPROVAL_PROGRESS_STATUSES)[number];

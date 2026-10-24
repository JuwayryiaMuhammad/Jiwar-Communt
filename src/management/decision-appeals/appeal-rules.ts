import {
  DECISION_APPEAL_EFFECT_REASONS,
  DECISION_APPEAL_KINDS,
  type DecisionAppealEffectReason,
  type DecisionAppealKind,
} from '../../core/decision-appeals/decision-appeals';

export {
  DECISION_APPEAL_EFFECT_REASONS,
  DECISION_APPEAL_KINDS,
  type DecisionAppealEffectReason,
  type DecisionAppealKind,
};

/** A staff decision is appealed within this many days of it (ADR 0059). */
export const DECISION_APPEAL_WINDOW_DAYS = 15;

export const DECISION_APPEAL_LIMITS = {
  grounds: 2000,
  rationale: 2000,
  attachments: 3,
} as const;

export const DECISION_APPEAL_STATUSES = [
  'pending',
  'upheld',
  'overturned',
  'withdrawn',
] as const;
export type DecisionAppealStatus = (typeof DECISION_APPEAL_STATUSES)[number];

export const DECISION_APPEAL_OUTCOMES = ['upheld', 'overturned'] as const;
export type DecisionAppealOutcome = (typeof DECISION_APPEAL_OUTCOMES)[number];

export const DECISION_APPEAL_EFFECTS = [
  'applied',
  'follow_up',
  'none',
] as const;
export type DecisionAppealEffectCode = (typeof DECISION_APPEAL_EFFECTS)[number];

/** The number as shown: AP-000123. */
export const decisionAppealReference = (n: number) =>
  `AP-${String(n).padStart(6, '0')}`;

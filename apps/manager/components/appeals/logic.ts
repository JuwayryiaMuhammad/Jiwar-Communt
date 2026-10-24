/**
 * Decision appeals (ADR 0059): what the management's pages say of them.
 * Pure, so node:test covers it.
 */

export const KIND_TEXT: Record<string, string> = {
  permit_rejection: 'Rejected permit',
  vehicle_rejection: 'Rejected vehicle',
  worker_rejection: 'Rejected worker',
  neighbour_notice: 'Neighbour notice',
};

export const STATUS_TEXT: Record<string, string> = {
  pending: 'To decide',
  upheld: 'Upheld: the decision stands',
  overturned: 'Overturned',
  withdrawn: 'Withdrawn by the appellant',
};

export const EFFECT_TEXT: Record<string, string> = {
  applied: 'Applied: the normal approval passed',
  follow_up: 'For the management to follow up',
  none: 'Nothing changed',
};

/** Why an overturn was left to the management: the check that refused it. */
export const EFFECT_REASON_TEXT: Record<string, string> = {
  window_passed: 'its window has passed',
  purged: 'its data was purged',
  requester_gone: 'its requester may no longer ask for it',
  unit_limit: 'the unit is at its limit',
  work_rules: 'the compound’s work days or hours refuse it',
  blocklisted: 'a plate on it is banned',
  needs_sticker: 'a sticker and the permit’s last day are needed',
  registrant_gone: 'its registrant may no longer keep vehicles there',
  plate_active: 'another vehicle holds the plate',
  permit_date: 'the permit’s last day is out of range',
  sticker_used: 'the sticker was issued before',
  changed: 'it changed since the appeal',
  needs_review: 'a worker is approved by a person, from their review',
};

/** A vehicle's overturn asks what its approval asks: a sticker and a last day. */
export const needsSticker = (kind: string, outcome: string) =>
  kind === 'vehicle_rejection' && outcome === 'overturned';

/** What the decided appeal says, in one line. */
export function decisionLine(d: {
  outcome: string;
  effect: string;
  effectReason: string | null;
}): string {
  const base = STATUS_TEXT[d.outcome] ?? d.outcome;
  if (d.outcome !== 'overturned') return base;
  const effect = EFFECT_TEXT[d.effect] ?? d.effect;
  return d.effectReason
    ? `${base} · ${effect}: ${EFFECT_REASON_TEXT[d.effectReason] ?? d.effectReason}`
    : `${base} · ${effect}`;
}

/** Where the decision appealed is opened in the dashboard, if anywhere. */
export function subjectHref(kind: string, subjectId: string): string | null {
  switch (kind) {
    case 'permit_rejection':
      return `/permits/${subjectId}`;
    case 'vehicle_rejection':
      // The vehicles' list: it has no page of one.
      return '/vehicles';
    default:
      return null;
  }
}

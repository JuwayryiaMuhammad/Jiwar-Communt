/** The visits an overstay alert is about (ADR 0056): visitors only. */
export const OVERSTAY_SUBJECTS = [
  'visitor_pass',
  'gate_request',
  'field_exception',
] as const;
export type OverstaySubject = (typeof OVERSTAY_SUBJECTS)[number];

/**
 * How long back the sweep looks for an `in`: a visit lasts at most 12 hours
 * before the system closes it, and its alert is due by then. Twice that,
 * so a late sweep still finds it.
 */
export const OVERSTAY_LOOKBACK_HOURS = 24;

/** The visit's expected minutes: its pass's, else the compound's (null: none). */
export function expectedMinutes(
  pass: number | null | undefined,
  compound: number | null,
): number | null {
  return pass ?? compound;
}

/** When a visit that came in at `enteredAt` is overstayed. */
export function overstayDue(enteredAt: Date, minutes: number): Date {
  return new Date(enteredAt.getTime() + minutes * 60_000);
}

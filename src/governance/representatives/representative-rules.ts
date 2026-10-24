/** Why a representative's term ended (ADR 0059); a unit test pins the CHECK. */
export const REPRESENTATIVE_END_REASONS = [
  'ended',
  'replaced',
  'no_longer_owner',
  'account_closed',
] as const;
export type RepresentativeEndReason =
  (typeof REPRESENTATIVE_END_REASONS)[number];

/** A message's words, at most. */
export const REPRESENTATIVE_MESSAGE_MAX = 2000;

/** What the residents of a building see of its representative. */
export const firstNameOf = (fullName: string | null | undefined) =>
  fullName?.trim().split(/\s+/)[0] ?? null;

/** What a board matter about a representative does (ADR 0059). */
export const REPRESENTATIVE_MATTER_ACTIONS = ['appoint', 'end'] as const;
export type RepresentativeMatterAction =
  (typeof REPRESENTATIVE_MATTER_ACTIONS)[number];

export const REPRESENTATIVE_MATTER_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'withdrawn',
] as const;
export type RepresentativeMatterStatus =
  (typeof REPRESENTATIVE_MATTER_STATUSES)[number];

/**
 * Why an approved matter changed nothing: the owner no longer owns a unit
 * in the building, or sits already (an appointment); the term ended
 * meanwhile (an end). A unit test pins the CHECK.
 */
export const REPRESENTATIVE_MATTER_EFFECT_REASONS = [
  'not_an_owner',
  'already_sitting',
  'already_ended',
] as const;
export type RepresentativeMatterEffectReason =
  (typeof REPRESENTATIVE_MATTER_EFFECT_REASONS)[number];

/** The board's deadline on a matter, from its raise. */
export const REPRESENTATIVE_MATTER_DAYS = 14;

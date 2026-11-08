import { addDays, type LocalDate } from '../schedules/local-dates';

/**
 * What a staff certificate certifies (ADR 0090); the migration's CHECK
 * repeats the list, a unit test keeps them in step.
 */
export const STAFF_CERTIFICATE_KINDS = [
  'electrical',
  'plumbing',
  'gas',
  'hvac',
  'working_at_height',
  'first_aid',
  'fire_safety',
  'driving',
  'security_licence',
  'other',
] as const;
export type StaffCertificateKind = (typeof STAFF_CERTIFICATE_KINDS)[number];

/** Its holder and the field team are told this many days ahead. */
export const CERTIFICATE_NOTICE_DAYS = 30;

export const CERTIFICATE_STATES = ['valid', 'expiring', 'expired'] as const;
export type CertificateState = (typeof CERTIFICATE_STATES)[number];

/**
 * Where a certificate stands on the compound's today. Its expiry is its
 * last day in force, as a vendor's paper (ADR 0077): `expiring` within the
 * 30 days (that day included), `expired` from the day after.
 */
export function certificateState(
  expiresOn: LocalDate,
  today: LocalDate,
): CertificateState {
  if (expiresOn < today) return 'expired';
  if (addDays(expiresOn, -CERTIFICATE_NOTICE_DAYS) <= today) return 'expiring';
  return 'valid';
}

/** The notice a sweep owes today, if any, for one expiry. */
export function noticeDue(
  c: {
    expiresOn: LocalDate;
    warnedFor: LocalDate | null;
    dayToldFor: LocalDate | null;
  },
  today: LocalDate,
): 'expires_today' | 'expiring' | null {
  if (c.expiresOn <= today)
    return c.expiresOn === today && c.dayToldFor !== c.expiresOn
      ? 'expires_today'
      : null;
  if (
    addDays(c.expiresOn, -CERTIFICATE_NOTICE_DAYS) <= today &&
    c.warnedFor !== c.expiresOn
  )
    return 'expiring';
  return null;
}

/**
 * What an account controls about delivery (ADR 0036): per category and
 * channel, never per kind. The inbox records everything whatever the
 * preferences say (ADR 0027); preferences decide only whether, and when, a
 * delivery channel carries it.
 */
export const NOTIFICATION_CATEGORIES = [
  'maintenance',
  'gate_visitors',
  'parcels',
  'household',
  'account_security',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** `push` is stored from R1 on; nothing reads it until push delivery exists. */
export const DELIVERY_CHANNELS = ['email', 'push'] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

/**
 * How a notification kind or an email template is delivered.
 *
 * - `critical`: never muted, never held by quiet hours or a pause.
 * - `soleRecord` (email templates only): the email is the only record of
 *   the notice, with no inbox twin. Turning the category off never skips
 *   it (ADR 0016: never silent); quiet hours and a timed pause hold it, and
 *   a pause "until resumed" does not (ADR 0036).
 */
export interface DeliveryClass {
  category: NotificationCategory;
  critical: boolean;
  soleRecord?: boolean;
}

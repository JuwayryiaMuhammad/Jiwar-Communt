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
  // Management requests and their appointments (ADR 0039).
  'management',
  // Important announcements, cancelled events, a suggestion's answer
  // (ADR 0040).
  'community',
  // Complaints between units, the boards and masked contact (ADR 0042).
  'neighbours',
  // A resident's bookings of the facilities, and the club (ADR 0044).
  'bookings',
  // A unit's vehicles, their permits and fines (ADR 0045).
  'vehicles',
  // A unit's invoices and payments (ADR 0046).
  'finance',
  // Emergencies and the services security gives at the gate (ADR 0047).
  'safety',
  // A unit's permits: works and contractors, moves, material exits and
  // private events (ADR 0049).
  'permits',
  // The guards' work: shifts, the roster, tasks, swaps and instructions
  // (ADR 0050).
  'guard_duty',
  // The owners' association: the board, its polls and elections (ADR 0051).
  'governance',
  // A resident's requests to the compound's service partners (ADR 0060).
  'partners',
  // Water, electricity and gas cut off in their buildings (ADR 0066).
  'utilities',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** `push` decides whether a notification is also pushed to the phone (ADR 0041). */
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

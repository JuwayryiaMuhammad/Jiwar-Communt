/**
 * The words for an account's codes (ADR 0023, 0036): why it cannot be
 * erased yet, what a consent means, the personal fields an erasure blanks.
 * Plain TypeScript, type imports only; the words are in the shell-accounts
 * catalog, and a code it does not know shows as the shared label.
 */
import type { Translate } from '@jiwar/i18n/core';
import type en from '../../messages/en/shell-accounts.ts';

type T = Translate<typeof en>;
type Label = (code: string) => string;

// The backend's DELETION_BLOCKERS.
const BLOCKERS = ['primary_resident', 'active_staff_role', 'legal_hold', 'open_worker_obligations', 'deposit_held'] as const;

const CONSENTS = [
  'ticket_phone_share',
  // One per category of service (ADR 0060).
  'partner_share_gas_water',
  'partner_share_pharmacy',
  'partner_share_grocery',
  'partner_share_home_services',
  'partner_share_laundry',
  'partner_share_gardening',
  'partner_share_beauty_at_home',
  'partner_share_repair',
  'partner_share_pets',
  'partner_share_events',
  'partner_share_moving_storage',
  'partner_share_car_services',
  'partner_share_elderly_care',
] as const;

const FIELDS = ['fullName', 'phone', 'email', 'idDocumentType', 'idDocumentNumber', 'nationality', 'birthDate'] as const;

const among = <V extends string>(list: readonly V[], value: string): value is V => (list as readonly string[]).includes(value);

/** Why an account cannot be erased yet. */
export function blockerText(t: T, label: Label, code: string): string {
  return among(BLOCKERS, code) ? t(`blocker.${code}`) : label(code);
}

/** What a consent is called. */
export function consentTitle(t: T, label: Label, code: string): string {
  return among(CONSENTS, code) ? t(`consent.${code}`) : label(code);
}

/** What a consent lets happen, or null for a consent this app does not know. */
export function consentBody(t: T, code: string): string | null {
  if (code === 'ticket_phone_share') return t('consentBody.ticket_phone_share');
  return among(CONSENTS, code) ? t('consentBody.partner') : null;
}

/** A personal field an erasure blanks, as the scope lists them. */
export function fieldText(t: T, field: string): string {
  if (among(FIELDS, field)) return t(`field.${field}`);
  return field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
}

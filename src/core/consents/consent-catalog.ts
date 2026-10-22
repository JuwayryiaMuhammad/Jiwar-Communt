/**
 * The closed catalog of consents (ADR 0036). Each code has a version: the
 * text the apps show for it. Bumping a version makes every earlier grant
 * stop counting until the account grants the new one. The database repeats
 * the codes as CHECKs (`consent_events_code_known`,
 * `account_consents_code_known`); a unit test keeps the two in step.
 *
 * Partner consents came with ADR 0060, one per category of service;
 * marketing and directory consents are still out.
 */
export interface ConsentDefinition {
  /** The current version of the text; earlier grants do not count. */
  version: number;
}

export const CONSENT_CATALOG = {
  /**
   * The technician assigned now to an open ticket the account reported may
   * see the account's phone in the ticket (ADR 0036). Account-level, off by
   * default; checked at every read, so a revocation hides it at once.
   */
  ticket_phone_share: { version: 1 },
  /**
   * A request to a partner of this category may show the partner what that
   * one request needs: the unit's code, the requester's first name, the
   * time window, the note and the lines it names (ADR 0060). One per
   * category of the closed list (PARTNER_CATEGORIES; a unit test keeps the
   * two in step). Off by default; a request needs it granted at its current
   * version, and the partner's desk checks it at every read, so a
   * revocation hides the request's details at once.
   */
  partner_share_gas_water: { version: 1 },
  partner_share_pharmacy: { version: 1 },
  partner_share_grocery: { version: 1 },
  partner_share_home_services: { version: 1 },
  partner_share_laundry: { version: 1 },
  partner_share_gardening: { version: 1 },
  partner_share_beauty_at_home: { version: 1 },
  partner_share_repair: { version: 1 },
  partner_share_pets: { version: 1 },
  partner_share_events: { version: 1 },
  partner_share_moving_storage: { version: 1 },
  partner_share_car_services: { version: 1 },
  partner_share_elderly_care: { version: 1 },
} satisfies Record<string, ConsentDefinition>;

export type ConsentCode = keyof typeof CONSENT_CATALOG;

export const CONSENT_CODES = Object.keys(CONSENT_CATALOG) as ConsentCode[];

export function isConsentCode(code: string): code is ConsentCode {
  return Object.prototype.hasOwnProperty.call(CONSENT_CATALOG, code);
}

/** The catalog's current version of a code. */
export function currentVersion(code: ConsentCode): number {
  return (CONSENT_CATALOG as Record<ConsentCode, ConsentDefinition>)[code]
    .version;
}

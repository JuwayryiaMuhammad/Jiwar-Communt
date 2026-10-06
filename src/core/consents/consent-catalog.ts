/**
 * The closed catalog of consents (ADR 0036). Each code has a version: the
 * text the apps show for it. Bumping a version makes every earlier grant
 * stop counting until the account grants the new one. The database repeats
 * the codes as CHECKs (`consent_events_code_known`,
 * `account_consents_code_known`); a unit test keeps the two in step.
 *
 * Out of R1: partner, marketing and directory consents.
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

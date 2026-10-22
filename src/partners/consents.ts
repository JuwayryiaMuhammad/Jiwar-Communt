import {
  CONSENT_CATALOG,
  type ConsentCode,
} from '../core/consents/consent-catalog';
import type { PartnerCategory } from './categories';

/**
 * The consent a request in `category` needs (ADR 0036, 0060): what the
 * request shows the partner, granted per category of service.
 */
export function partnerConsent(category: PartnerCategory): ConsentCode {
  const code = `partner_share_${category}`;
  if (!Object.prototype.hasOwnProperty.call(CONSENT_CATALOG, code))
    throw new Error(`No consent for the partner category ${category}`);
  return code as ConsentCode;
}

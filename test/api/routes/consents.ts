import { PARTNER_CATEGORIES } from '../../../src/partners/categories';
import type { Row } from '../registry';

/** The catalog's codes, in its order: ADR 0036's, then one per partner category (ADR 0060). */
const CONSENT_CODES = [
  'ticket_phone_share',
  ...PARTNER_CATEGORIES.map((c) => `partner_share_${c}`),
];
const UNKNOWN_CODE = [
  {
    field: 'code',
    code: 'INVALID_VALUE',
    params: { allowed: CONSENT_CODES },
  },
];

/** Consents (ADR 0036): the caller's own, any tenant account. */
export const CONSENTS_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/me/consents',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/me/consents/grant',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: { code: 'marketing', version: 1 },
      fields: UNKNOWN_CODE,
    },
  },
  {
    method: 'POST',
    path: '/me/consents/revoke',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: 'none',
    invalid: { body: { code: 'marketing' }, fields: UNKNOWN_CODE },
  },
];

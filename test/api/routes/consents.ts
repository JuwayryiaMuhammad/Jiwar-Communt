import type { Row } from '../registry';

const UNKNOWN_CODE = [
  {
    field: 'code',
    code: 'INVALID_VALUE',
    params: { allowed: ['ticket_phone_share'] },
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

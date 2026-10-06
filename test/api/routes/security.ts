import type { Row } from '../registry';

/** Step-up and devices (ADR 0036): the caller's own session and account. */
export const SECURITY_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/me/step-up',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/me/step-up/verify',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: { code: '12' },
      fields: [
        { field: 'code', code: 'INVALID_FORMAT', params: { length: 6 } },
      ],
    },
  },
];

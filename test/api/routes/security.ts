import type { Row } from '../registry';

/**
 * Step-up and devices (ADR 0036): the caller's own session and account, and
 * the "not me" link of an unusual-login email (the token is the only input).
 */
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
  {
    method: 'POST',
    path: '/me/devices/{id}/not-me',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: {
      params: (w) => ({ id: w.bDeviceId }),
      code: 'DEVICE_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/public/not-me',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: { token: 5, accountId: 'x' },
      fields: [
        { field: 'accountId', code: 'FIELD_NOT_ALLOWED' },
        { field: 'token', code: 'INVALID_TYPE' },
      ],
    },
  },
];

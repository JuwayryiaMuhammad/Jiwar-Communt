import type { Row } from '../registry';

/** Delivery preferences (ADR 0036): the caller's own, any tenant account. */
export const PREFERENCES_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/me/notification-preferences',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/me/notification-preferences',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: { pause: '2h' },
      fields: [
        {
          field: 'pause',
          code: 'INVALID_VALUE',
          params: { allowed: ['1h', '8h', 'until_resumed'] },
        },
      ],
    },
  },
];

import type { Row } from '../registry';

/** This install's push token (ADR 0041): any signed-in tenant account. */
export const PUSH_TOKENS_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/me/push-tokens',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: { token: '', platform: 'windows' },
      fields: [
        {
          field: 'token',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 4096 },
        },
        {
          field: 'platform',
          code: 'INVALID_VALUE',
          params: { allowed: ['android', 'ios'] },
        },
      ],
    },
  },
  {
    method: 'DELETE',
    path: '/me/push-tokens',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: 'none',
    invalid: 'none',
  },
];

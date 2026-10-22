import type { Row } from '../registry';

export const NOTIFICATIONS_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/me/notifications',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: 'none',
    invalid: {
      query: { unread: 'yes', archived: 'no' },
      fields: [
        {
          field: 'unread',
          code: 'INVALID_VALUE',
          params: { allowed: ['true', 'false'] },
        },
        {
          field: 'archived',
          code: 'INVALID_VALUE',
          params: { allowed: ['true', 'false'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/me/notifications/unread-count',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/me/notifications/read-all',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/me/notifications/{id}/read',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: {
      params: (w) => ({ id: w.bNotificationId }),
      code: 'NOTIFICATION_NOT_FOUND',
    },
    invalid: 'none',
  },
  // The resident's archive and delete (ADR 0058).
  ...(
    [
      ['POST', '/me/notifications/{id}/archive'],
      ['POST', '/me/notifications/{id}/unarchive'],
      ['DELETE', '/me/notifications/{id}'],
    ] as const
  ).map(([method, path]): Row => ({
    method,
    path,
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: {
      params: (w) => ({ id: w.bNotificationId }),
      code: 'NOTIFICATION_NOT_FOUND',
    },
    invalid: 'none',
  })),
];

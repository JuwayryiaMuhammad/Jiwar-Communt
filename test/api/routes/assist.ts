import type { Row } from '../registry';

const REASON = { reasonCode: 'in_person' };
const foreign = (body?: object) => ({
  params: (w: { b: { ids: { owner: string } } }) => ({ id: w.b.ids.owner }),
  code: 'ACCOUNT_NOT_FOUND',
  ...(body ? { body: () => body } : {}),
});
const reasonType = {
  body: { reasonCode: 5 },
  fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
};
const UNKNOWN_CODE = [
  {
    field: 'code',
    code: 'INVALID_VALUE',
    params: { allowed: ['ticket_phone_share'] },
  },
];

/**
 * The assisted path (ADR 0036): a manager (`residents.assist`) acting for a
 * resident or family account; another compound's account is not found.
 */
export const ASSIST_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/accounts/{id}/notification-preferences',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: foreign(),
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/accounts/{id}/notification-preferences',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: foreign(REASON),
    invalid: {
      body: { pause: '2h', reasonCode: 'in_person' },
      fields: [
        {
          field: 'pause',
          code: 'INVALID_VALUE',
          params: { allowed: ['1h', '8h', 'until_resumed'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/accounts/{id}/consents',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: foreign(),
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/accounts/{id}/consents/grant',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: foreign({ code: 'ticket_phone_share', version: 1, ...REASON }),
    invalid: {
      body: { code: 'marketing', version: 1, ...REASON },
      fields: UNKNOWN_CODE,
    },
  },
  {
    method: 'POST',
    path: '/accounts/{id}/consents/revoke',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: foreign({ code: 'ticket_phone_share', ...REASON }),
    invalid: { body: { code: 'marketing', ...REASON }, fields: UNKNOWN_CODE },
  },
  {
    method: 'GET',
    path: '/accounts/{id}/data-exports',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: foreign(),
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/accounts/{id}/deletion-request',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: foreign(),
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/accounts/{id}/data-exports',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: foreign(REASON),
    invalid: reasonType,
  },
  {
    method: 'POST',
    path: '/accounts/{id}/deletion-request',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: foreign(REASON),
    invalid: reasonType,
  },
  {
    method: 'POST',
    path: '/accounts/{id}/deletion-request/cancel',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: foreign(REASON),
    invalid: reasonType,
  },
];

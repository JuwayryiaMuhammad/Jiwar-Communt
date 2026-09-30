import type { Row } from '../registry';

export const inAMonth = () =>
  new Date(Date.now() + 30 * 86_400_000).toISOString();

export const DELEGATIONS_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/units/{unitId}/delegations',
    auth: 'tenant',
    as: 'owner',
    // Family members hold household.manage, never household.delegate.
    denied: 'family',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/units/{unitId}/delegations',
    auth: 'tenant',
    as: 'owner',
    denied: 'family',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      body: (w) => ({
        delegateAccountId: w.b.ids.family,
        scopes: ['household'],
        expiresAt: inAMonth(),
      }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { delegateAccountId: 'x', scopes: [], expiresAt: 'soon' },
      fields: [
        { field: 'delegateAccountId', code: 'INVALID_UUID' },
        { field: 'scopes', code: 'INVALID_LENGTH', params: { min: 1 } },
        { field: 'expiresAt', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'POST',
    path: '/delegations/{id}/revoke',
    auth: 'tenant',
    as: 'owner',
    denied: 'family',
    foreign: {
      params: (w) => ({ id: w.bDelegationId }),
      code: 'DELEGATION_NOT_FOUND',
    },
    invalid: 'none',
  },
];

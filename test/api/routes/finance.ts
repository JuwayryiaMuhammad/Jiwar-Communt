import { newId } from '../../../src/core/common/uuid';
import type { Row } from '../registry';

const CREDENTIALS = {
  mode: 'sandbox',
  secretKey: 'egy_sk_test_0123456789abcdef',
  publicKey: 'egy_pk_test_0123456789abcdef',
  hmacSecret: 'HMAC0123456789ABCDEF',
  cardIntegrationId: 4100001,
};

const BAD_CREDENTIALS: Pick<Row, 'invalid'> = {
  invalid: {
    body: { ...CREDENTIALS, secretKey: 'sk_live_x', cardIntegrationId: 0 },
    fields: [
      { field: 'secretKey', code: 'INVALID_FORMAT' },
      {
        field: 'cardIntegrationId',
        code: 'INVALID_NUMBER',
        params: { min: 1, max: 2147483647 },
      },
    ],
  },
};

/** The compound's online payment account (ADR 0046). */
export const FINANCE_GATEWAY_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/finance/gateway',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'PUT',
    path: '/staff/finance/gateway',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    ...BAD_CREDENTIALS,
  },
  {
    method: 'PATCH',
    path: '/staff/finance/gateway',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { onlineEnabled: 'yes' },
      fields: [{ field: 'onlineEnabled', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'GET',
    path: '/platform/tenants/{id}/payment-gateway',
    auth: 'platform',
    denied: 'restricted',
    foreign: { params: () => ({ id: newId() }), code: 'TENANT_NOT_FOUND' },
    invalid: 'none',
  },
  {
    method: 'PUT',
    path: '/platform/tenants/{id}/payment-gateway',
    auth: 'platform',
    denied: 'restricted',
    foreign: {
      params: () => ({ id: newId() }),
      body: () => CREDENTIALS,
      code: 'TENANT_NOT_FOUND',
    },
    ...BAD_CREDENTIALS,
  },
  {
    method: 'PATCH',
    path: '/platform/tenants/{id}/payment-gateway',
    auth: 'platform',
    denied: 'restricted',
    foreign: {
      params: () => ({ id: newId() }),
      body: () => ({ platformDisabled: true }),
      code: 'TENANT_NOT_FOUND',
    },
    invalid: {
      body: { platformDisabled: 1 },
      fields: [{ field: 'platformDisabled', code: 'INVALID_TYPE' }],
    },
  },
];

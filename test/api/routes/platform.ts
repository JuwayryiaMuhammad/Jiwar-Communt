import { newId } from '../../../src/core/common/uuid';
import { nationalIdFor } from '../../setup/fixtures';
import { uniqueEmail, uniquePhone } from '../../setup/http-app';
import type { Row } from '../registry';

export const newManagerBody = () => ({
  fullName: 'Second Manager',
  idDocumentType: 'national_id',
  idDocumentNumber: nationalIdFor(),
  phone: uniquePhone(),
  email: uniqueEmail('mgr2'),
});

const LIMIT = { min: 1, max: 100 };

export const PLATFORM_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/platform/auth/login',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: {},
      fields: [
        { field: 'email', code: 'FIELD_REQUIRED' },
        { field: 'password', code: 'FIELD_REQUIRED' },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/platform/auth/change-password',
    auth: 'platform',
    // The restricted token is exactly what this route accepts.
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: { currentPassword: 1 },
      fields: [
        { field: 'currentPassword', code: 'INVALID_TYPE' },
        { field: 'newPassword', code: 'FIELD_REQUIRED' },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/platform/auth/refresh',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: { refreshToken: 'short' },
      fields: [
        {
          field: 'refreshToken',
          code: 'INVALID_LENGTH',
          params: { min: 20, max: 200 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/platform/auth/logout',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: {},
      fields: [{ field: 'refreshToken', code: 'FIELD_REQUIRED' }],
    },
  },
  {
    method: 'GET',
    path: '/platform/tenants',
    auth: 'platform',
    denied: 'restricted',
    foreign: 'none',
    invalid: {
      query: { limit: '0', sort: 'name' },
      fields: [
        { field: 'sort', code: 'FIELD_NOT_ALLOWED' },
        { field: 'limit', code: 'INVALID_NUMBER', params: LIMIT },
      ],
    },
  },
  {
    method: 'POST',
    path: '/platform/tenants',
    auth: 'platform',
    denied: 'restricted',
    foreign: 'none',
    invalid: {
      body: { name: 'x', manager: { phone: '123' } },
      fields: [
        { field: 'name', code: 'INVALID_LENGTH', params: { min: 2, max: 200 } },
        { field: 'manager.fullName', code: 'FIELD_REQUIRED' },
        { field: 'manager.phone', code: 'INVALID_PHONE' },
        { field: 'manager.email', code: 'FIELD_REQUIRED' },
        { field: 'manager.idDocumentType', code: 'FIELD_REQUIRED' },
        { field: 'manager.idDocumentNumber', code: 'FIELD_REQUIRED' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/platform/tenants/{id}',
    auth: 'platform',
    denied: 'restricted',
    foreign: { params: () => ({ id: newId() }), code: 'TENANT_NOT_FOUND' },
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/platform/tenants/{id}/status',
    auth: 'platform',
    denied: 'restricted',
    foreign: {
      params: () => ({ id: newId() }),
      body: () => ({ status: 'active' }),
      code: 'TENANT_NOT_FOUND',
    },
    invalid: {
      body: { status: 'closed' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['active', 'suspended'] },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/platform/tenants/{id}/managers',
    auth: 'platform',
    denied: 'restricted',
    foreign: {
      params: () => ({ id: newId() }),
      body: newManagerBody,
      code: 'TENANT_NOT_FOUND',
    },
    invalid: {
      body: { ...newManagerBody(), email: 'nope', tenantId: newId() },
      fields: [
        { field: 'tenantId', code: 'FIELD_NOT_ALLOWED' },
        { field: 'email', code: 'INVALID_EMAIL' },
      ],
    },
  },
  {
    method: 'PATCH',
    path: '/platform/tenants/{id}/managers/{accountId}/status',
    auth: 'platform',
    denied: 'restricted',
    // Compound A's id with compound B's manager.
    foreign: {
      params: (w) => ({ id: w.a.tenantId, accountId: w.b.ids.manager }),
      body: () => ({ status: 'active' }),
      code: 'ACCOUNT_NOT_FOUND',
    },
    invalid: {
      body: { status: 'erased' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['active', 'inactive'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/platform/audit',
    auth: 'platform',
    denied: 'restricted',
    foreign: 'none',
    invalid: {
      query: { actorId: 'x', from: 'yesterday' },
      fields: [
        { field: 'from', code: 'INVALID_FORMAT' },
        { field: 'actorId', code: 'INVALID_UUID' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/platform/security-events',
    auth: 'platform',
    denied: 'restricted',
    foreign: 'none',
    invalid: {
      query: { identifierHash: 'x' },
      fields: [{ field: 'identifierHash', code: 'INVALID_FORMAT' }],
    },
  },
];

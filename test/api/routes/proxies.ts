import { day } from '../../setup/compound-clock';
import type { Row } from '../registry';

/** Another compound's proxy, or none: the one not-found. */
const UNKNOWN = '0192a5f0-1c2b-7d3e-8f40-0000000063b1';

/** Unit proxies (ADR 0063): the owners', the proxy's, the management's, the public accept. */
export const PROXY_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/units/{unitId}/proxies',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/units/{unitId}/proxies',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    // The unit's lock comes first: another compound's unit is not found.
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      body: () => ({
        fullName: 'Foreign Proxy',
        email: 'foreign-proxy@example.com',
        phone: '+201000000063',
        idDocumentType: 'national_id',
        idDocumentNumber: '29001011234567',
        scopes: ['tickets'],
        endsOn: day(30),
      }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: {
        fullName: 'X',
        email: 'proxy@example.com',
        phone: '+201000000063',
        idDocumentType: 'national_id',
        idDocumentNumber: '29001011234567',
        scopes: ['money'],
        // Shaped as a day, and no day: `::date` refused it with a 500.
        endsOn: '2026-02-30',
      },
      fields: [
        {
          field: 'fullName',
          code: 'INVALID_LENGTH',
          params: { min: 2, max: 200 },
        },
        {
          field: 'scopes',
          code: 'INVALID_VALUE',
          params: {
            allowed: [
              'inspections',
              'tickets',
              'visitors_invite',
              'works',
              'requests',
            ],
          },
        },
        {
          field: 'endsOn',
          code: 'INVALID_FORMAT',
          params: { format: 'YYYY-MM-DD' },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/units/{unitId}/proxies/{id}/revoke',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId, id: UNKNOWN }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/me/proxy-units',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/units/{unitId}/proxies',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/proxy-invites/accept/start',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: {},
      fields: [{ field: 'token', code: 'FIELD_REQUIRED' }],
    },
  },
  {
    method: 'POST',
    path: '/proxy-invites/accept/complete',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: { token: 'x', code: '12' },
      fields: [
        { field: 'code', code: 'INVALID_FORMAT', params: { length: 6 } },
      ],
    },
  },
];

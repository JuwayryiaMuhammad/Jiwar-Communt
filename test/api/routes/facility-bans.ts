import type { Row } from '../registry';

/** A day shaped right that does not exist (ADR 0025, ADR 0067). */
const NO_SUCH_DAY = '2026-02-30';
const BOOL = ['true', 'false'];
const LIMIT = { min: 1, max: 100 };

/** Facility bans and the facilities' usage (ADR 0067). */
export const FACILITY_BAN_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/facility-bans',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { accountId: 'x', facilityId: 'x', inForce: 'yes', limit: '0' },
      fields: [
        { field: 'accountId', code: 'INVALID_UUID' },
        { field: 'facilityId', code: 'INVALID_UUID' },
        { field: 'inForce', code: 'INVALID_VALUE', params: { allowed: BOOL } },
        { field: 'limit', code: 'INVALID_NUMBER', params: LIMIT },
      ],
    },
  },
  {
    method: 'POST',
    path: '/staff/facility-bans',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    // B's facility is not found in A: the booker, A's owner, is locked first.
    foreign: {
      params: () => ({}),
      body: (w) => ({
        accountId: w.a.ids.owner,
        facilityId: w.bFacilityId,
        reasonCode: 'damage',
      }),
      code: 'FACILITY_NOT_FOUND',
    },
    invalid: {
      body: { accountId: 'x', facilityId: 'x', endsOn: NO_SUCH_DAY },
      fields: [
        { field: 'accountId', code: 'INVALID_UUID' },
        { field: 'facilityId', code: 'INVALID_UUID' },
        { field: 'reasonCode', code: 'FIELD_REQUIRED' },
        { field: 'endsOn', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/facility-bans/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bBanId }),
      code: 'FACILITY_BAN_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/facility-bans/{id}/lift',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bBanId }),
      body: () => ({ reasonCode: 'other' }),
      code: 'FACILITY_BAN_NOT_FOUND',
    },
    invalid: {
      body: {},
      fields: [{ field: 'reasonCode', code: 'FIELD_REQUIRED' }],
    },
  },
  {
    method: 'GET',
    path: '/me/facility-bans',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/facility-usage',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { from: NO_SUCH_DAY, to: '2026-13-01' },
      fields: [
        { field: 'from', code: 'INVALID_FORMAT' },
        { field: 'to', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/facility-usage/export',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { from: '2027-02-29' },
      fields: [{ field: 'from', code: 'INVALID_FORMAT' }],
    },
    noStore: true,
  },
];

import type { Row } from '../registry';

const KINDS = ['building', 'area', 'facility'];

/** The asset register (ADR 0064): its common areas. */
export const COMMON_AREA_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/maintenance/areas',
    auth: 'tenant',
    as: 'technician',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { kind: 'garden' },
      fields: [
        { field: 'kind', code: 'INVALID_VALUE', params: { allowed: KINDS } },
      ],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/areas',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: {
        kind: 'garden',
        code: 'with space',
        nameAr: '',
        nameEn: 'Garden',
        latitude: 91,
      },
      fields: [
        { field: 'kind', code: 'INVALID_VALUE', params: { allowed: KINDS } },
        { field: 'code', code: 'INVALID_FORMAT' },
        {
          field: 'nameAr',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 80 },
        },
        {
          field: 'latitude',
          code: 'INVALID_NUMBER',
          params: { min: -90, max: 90 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/areas/{id}',
    auth: 'tenant',
    as: 'technician',
    denied: 'family',
    foreign: {
      params: (w) => ({ id: w.bCommonAreaId }),
      code: 'COMMON_AREA_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/maintenance/areas/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bCommonAreaId }),
      body: () => ({ nameEn: 'Garden' }),
      code: 'COMMON_AREA_NOT_FOUND',
    },
    invalid: {
      body: { active: 'no' },
      fields: [{ field: 'active', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/areas/{id}/tag',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bCommonAreaId }),
      code: 'COMMON_AREA_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
];

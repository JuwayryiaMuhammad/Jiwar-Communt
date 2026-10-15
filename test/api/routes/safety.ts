import type { Row } from '../registry';

/** The compound's places (ADR 0047). */
export const PLACE_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/community/places',
    auth: 'tenant',
    as: 'owner',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/places',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/places',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { nameEn: '', nameAr: 'مكان', position: 1001 },
      fields: [
        {
          field: 'nameEn',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 60 },
        },
        {
          field: 'position',
          code: 'INVALID_NUMBER',
          params: { min: 0, max: 1000 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/places/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPlaceId }),
      code: 'PLACE_NOT_FOUND',
      body: () => ({ position: 5 }),
    },
    invalid: {
      body: { active: 'no' },
      fields: [{ field: 'active', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
];

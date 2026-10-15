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

/** A unit's emergency contacts (ADR 0047). */
export const EMERGENCY_CONTACT_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/units/{unitId}/emergency-contacts',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.bUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
];

/** Emergencies, the household's side (ADR 0047). */
export const EMERGENCY_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/emergencies',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: () => ({}),
      code: 'UNIT_NOT_FOUND',
      body: (w) => ({ type: 'medical', unitId: w.bUnitId }),
    },
    invalid: {
      body: { type: 'flood', unitId: 'nowhere' },
      fields: [
        {
          field: 'type',
          code: 'INVALID_VALUE',
          params: { allowed: ['medical', 'fire', 'security', 'facilities'] },
        },
        { field: 'unitId', code: 'INVALID_UUID' },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/me/emergencies',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { status: 'pending' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['open', 'closed'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/emergencies/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bEmergencyId }),
      code: 'EMERGENCY_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/emergencies/{id}/cancel',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bEmergencyId }),
      code: 'EMERGENCY_NOT_FOUND',
      body: () => ({}),
    },
    invalid: {
      body: { reasonCode: 5 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/emergencies/{id}/on-my-way',
    auth: 'tenant',
    as: 'family',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bEmergencyId }),
      code: 'EMERGENCY_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
];

/** Emergencies, the responders' side (ADR 0047). */
export const EMERGENCY_RESPONDER_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/gate/emergencies',
    auth: 'tenant',
    as: 'guard',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'pending' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['open', 'closed'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/gate/emergencies/{id}',
    auth: 'tenant',
    as: 'guard',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bEmergencyId }),
      code: 'EMERGENCY_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/gate/emergencies/{id}/accept',
    auth: 'tenant',
    as: 'guard',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bEmergencyId }),
      code: 'EMERGENCY_NOT_FOUND',
      body: () => ({ etaMinutes: 5 }),
    },
    invalid: {
      body: { etaMinutes: 3 },
      fields: [
        {
          field: 'etaMinutes',
          code: 'INVALID_VALUE',
          params: { allowed: [2, 5, 10, 15] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/gate/emergencies/{id}/arrived',
    auth: 'tenant',
    as: 'guard',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bEmergencyId }),
      code: 'EMERGENCY_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/gate/emergencies/{id}/resolve',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bEmergencyId }),
      code: 'EMERGENCY_NOT_FOUND',
      body: () => ({ reasonCode: 'handled' }),
    },
    invalid: {
      body: { note: '' },
      fields: [
        { field: 'reasonCode', code: 'FIELD_REQUIRED' },
        {
          field: 'note',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 500 },
        },
      ],
    },
    noStore: true,
  },
];

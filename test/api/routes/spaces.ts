import { at, day } from '../../setup/compound-clock';
import type { Row } from '../registry';

const UUID = (field: string) => [{ field, code: 'INVALID_UUID' }];
const later = () => ({
  startsAt: at(day(30), 10).toISOString(),
  endsAt: at(day(30), 12).toISOString(),
});

/**
 * Spaces (ADR 0084): the holiday calendar, the site map, the floor plans,
 * common-area use requests and a closure's preview.
 */
export const SPACES_ROUTES: Row[] = [
  // --- the holiday calendar --------------------------------------------------
  {
    method: 'GET',
    path: '/staff/holidays',
    auth: 'tenant',
    as: 'manager',
    denied: 'collector',
    foreign: 'none',
    invalid: {
      query: { from: '2026-02-30' },
      fields: [{ field: 'from', code: 'INVALID_FORMAT' }],
    },
  },
  {
    method: 'POST',
    path: '/staff/holidays',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: { day: '2026-04-31', nameEn: '', nameAr: 'عيد' },
      fields: [
        { field: 'day', code: 'INVALID_FORMAT' },
        {
          field: 'nameEn',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 80 },
        },
      ],
    },
  },
  {
    method: 'PATCH',
    path: '/staff/holidays/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bHolidayId }),
      body: () => ({ nameEn: 'Feast' }),
      code: 'HOLIDAY_NOT_FOUND',
    },
    invalid: {
      body: { stopsWorks: 'yes' },
      fields: [{ field: 'stopsWorks', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'DELETE',
    path: '/staff/holidays/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bHolidayId }),
      code: 'HOLIDAY_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/community/holidays',
    auth: 'tenant',
    as: 'owner',
    denied: 'collector',
    foreign: 'none',
    invalid: 'none',
  },
  // --- the site map ------------------------------------------------------------
  {
    method: 'GET',
    path: '/staff/site-map',
    auth: 'tenant',
    as: 'manager',
    denied: 'collector',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PUT',
    path: '/staff/site-map/image',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: { body: { fileId: 'x' }, fields: UUID('fileId') },
    noStore: true,
  },
  {
    method: 'PUT',
    path: '/staff/site-map/points',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: { points: [{ kind: 'building', refId: 'x', x: 0.5, y: 2 }] },
      fields: [
        { field: 'points.0.refId', code: 'INVALID_UUID' },
        {
          field: 'points.0.y',
          code: 'INVALID_NUMBER',
          params: { min: 0, max: 1 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/site-map',
    auth: 'tenant',
    as: 'owner',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  // --- the floor plans ---------------------------------------------------------
  {
    method: 'GET',
    path: '/staff/floor-plans',
    auth: 'tenant',
    as: 'manager',
    denied: 'collector',
    foreign: 'none',
    invalid: { query: { buildingId: 'x' }, fields: UUID('buildingId') },
  },
  {
    method: 'POST',
    path: '/staff/floor-plans',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: { buildingId: 'x', floor: 201, fileId: 'y' },
      fields: [
        { field: 'buildingId', code: 'INVALID_UUID' },
        {
          field: 'floor',
          code: 'INVALID_NUMBER',
          params: { min: -5, max: 200 },
        },
        { field: 'fileId', code: 'INVALID_UUID' },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/floor-plans/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'collector',
    foreign: {
      params: (w) => ({ id: w.bFloorPlanId }),
      code: 'FLOOR_PLAN_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PUT',
    path: '/staff/floor-plans/{id}/image',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bFloorPlanId }),
      body: () => ({ fileId: '00000000-0000-4000-8000-000000000001' }),
      code: 'FLOOR_PLAN_NOT_FOUND',
    },
    invalid: { body: { fileId: 'x' }, fields: UUID('fileId') },
    noStore: true,
  },
  {
    method: 'PUT',
    path: '/staff/floor-plans/{id}/hotspots',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bFloorPlanId }),
      body: () => ({ hotspots: [] }),
      code: 'FLOOR_PLAN_NOT_FOUND',
    },
    invalid: {
      body: { hotspots: [{ unitId: 'x', x: 0, y: 0, width: -1, height: 0.5 }] },
      fields: [
        { field: 'hotspots.0.unitId', code: 'INVALID_UUID' },
        {
          field: 'hotspots.0.width',
          code: 'INVALID_NUMBER',
          params: { min: 0, max: 1 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'DELETE',
    path: '/staff/floor-plans/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bFloorPlanId }),
      code: 'FLOOR_PLAN_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/units/{unitId}/floor-plan',
    auth: 'tenant',
    as: 'owner',
    denied: 'technician',
    foreign: {
      params: (w) => ({ unitId: w.bUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  // --- common-area use requests ------------------------------------------------
  {
    method: 'GET',
    path: '/staff/space-use-areas',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'PUT',
    path: '/staff/space-use-areas/{commonAreaId}',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ commonAreaId: w.bCommonAreaId }),
      code: 'COMMON_AREA_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'DELETE',
    path: '/staff/space-use-areas/{commonAreaId}',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ commonAreaId: w.bCommonAreaId }),
      code: 'COMMON_AREA_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/space-use-areas',
    auth: 'tenant',
    as: 'owner',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/units/{unitId}/space-uses',
    auth: 'tenant',
    as: 'owner',
    denied: 'technician',
    foreign: {
      params: (w) => ({ unitId: w.bUnitId }),
      body: (w) => ({
        commonAreaId: w.bCommonAreaId,
        ...later(),
        purpose: 'A party',
      }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: {
        commonAreaId: 'x',
        startsAt: '2027-02-29T09:00:00Z',
        endsAt: at(day(30), 12).toISOString(),
        purpose: '',
      },
      fields: [
        { field: 'commonAreaId', code: 'INVALID_UUID' },
        { field: 'startsAt', code: 'INVALID_FORMAT' },
        {
          field: 'purpose',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 500 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/units/{unitId}/space-uses',
    auth: 'tenant',
    as: 'owner',
    denied: 'technician',
    foreign: {
      params: (w) => ({ unitId: w.bUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      query: { limit: '0' },
      fields: [
        {
          field: 'limit',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 100 },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/space-uses/{id}/withdraw',
    auth: 'tenant',
    as: 'owner',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bSpaceUseId }),
      body: () => ({ reasonCode: 'plans_changed' }),
      code: 'SPACE_USE_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: ['x'] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'GET',
    path: '/staff/space-uses',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { status: 'x' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: {
            allowed: ['pending', 'approved', 'refused', 'cancelled', 'expired'],
          },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/space-uses/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bSpaceUseId }),
      code: 'SPACE_USE_NOT_FOUND',
    },
    invalid: 'none',
  },
  ...(['approve', 'refuse', 'cancel'] as const).map((action): Row => ({
    method: 'POST',
    path: `/staff/space-uses/{id}/${action}`,
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bSpaceUseId }),
      ...(action === 'approve'
        ? {}
        : {
            body: () => ({
              reasonCode: action === 'refuse' ? 'not_suitable' : 'safety',
            }),
          }),
      code: 'SPACE_USE_NOT_FOUND',
    },
    invalid:
      action === 'approve'
        ? 'none'
        : {
            body: { reasonCode: ['x'] },
            fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
          },
  })),
  // --- a closure's preview -----------------------------------------------------
  {
    method: 'GET',
    path: '/staff/facilities/{id}/closure-preview',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bFacilityId }),
      query: {
        startsAt: at(day(30), 10).toISOString(),
        endsAt: at(day(30), 12).toISOString(),
      },
      code: 'FACILITY_NOT_FOUND',
    },
    invalid: {
      query: {
        startsAt: '2099-02-30T08:00:00Z',
        endsAt: at(day(30), 12).toISOString(),
      },
      fields: [{ field: 'startsAt', code: 'INVALID_FORMAT' }],
    },
    noStore: true,
  },
];

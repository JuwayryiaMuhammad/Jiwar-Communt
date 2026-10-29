import type { Row } from '../registry';

const KINDS = ['building', 'area', 'facility'];
/**
 * A day shaped right that does not exist: a pattern lets it through, and
 * `new Date` rolls it over to 2 March. Every date the register takes is
 * refused with it (INVALID_FORMAT).
 */
const NO_SUCH_DAY = '2026-02-30';

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

const pageInvalid = {
  query: { limit: '0' },
  fields: [
    { field: 'limit', code: 'INVALID_NUMBER', params: { min: 1, max: 100 } },
  ],
};
const STATUSES = ['in_service', 'out_of_service', 'retired'];
const CONDITIONS = ['good', 'fair', 'poor', 'critical'];

/** The asset register (ADR 0064): types, assets, documents, imports. */
export const ASSET_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/maintenance/asset-types',
    auth: 'tenant',
    as: 'technician',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/maintenance/asset-types',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: {
        key: 'Bad!',
        nameAr: '',
        nameEn: 'Chiller',
        categoryId: 'x',
        expectedLifeYears: 0,
      },
      fields: [
        { field: 'key', code: 'INVALID_FORMAT' },
        {
          field: 'nameAr',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 80 },
        },
        { field: 'categoryId', code: 'INVALID_UUID' },
        {
          field: 'expectedLifeYears',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 100 },
        },
      ],
    },
  },
  {
    method: 'PATCH',
    path: '/maintenance/asset-types/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bAssetTypeId }),
      body: () => ({ active: false }),
      code: 'ASSET_TYPE_NOT_FOUND',
    },
    invalid: {
      body: { active: 'no' },
      fields: [{ field: 'active', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/assets',
    auth: 'tenant',
    as: 'technician',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'broken' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: STATUSES },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/assets',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: {
        code: 'with space',
        typeId: 'x',
        nameAr: '',
        nameEn: 'Pump',
        // Shaped as days, and no day: never stored rolled over.
        commissionedOn: NO_SUCH_DAY,
        warrantyEndsOn: '2026-04-31',
      },
      fields: [
        { field: 'code', code: 'INVALID_FORMAT' },
        { field: 'typeId', code: 'INVALID_UUID' },
        {
          field: 'nameAr',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 120 },
        },
        { field: 'commissionedOn', code: 'INVALID_FORMAT' },
        { field: 'warrantyEndsOn', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/assets/{id}',
    auth: 'tenant',
    as: 'technician',
    denied: 'family',
    foreign: { params: (w) => ({ id: w.bAssetId }), code: 'ASSET_NOT_FOUND' },
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/maintenance/assets/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bAssetId }),
      body: () => ({ condition: 'fair' }),
      code: 'ASSET_NOT_FOUND',
    },
    invalid: {
      body: {
        condition: 'broken',
        commissionedOn: NO_SUCH_DAY,
        warrantyEndsOn: '2026-04-31',
      },
      fields: [
        { field: 'commissionedOn', code: 'INVALID_FORMAT' },
        { field: 'warrantyEndsOn', code: 'INVALID_FORMAT' },
        {
          field: 'condition',
          code: 'INVALID_VALUE',
          params: { allowed: CONDITIONS },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/assets/{id}/status',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bAssetId }),
      body: () => ({ status: 'out_of_service', reasonCode: 'breakdown' }),
      code: 'ASSET_NOT_FOUND',
    },
    invalid: {
      body: { status: 'retired' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['in_service', 'out_of_service'] },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/assets/{id}/retire',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bAssetId }),
      body: () => ({ reasonCode: 'replaced' }),
      code: 'ASSET_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/maintenance/assets/{id}/move',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bAssetId }),
      body: (w) => ({ commonAreaId: w.bCommonAreaId }),
      code: 'ASSET_NOT_FOUND',
    },
    invalid: {
      body: { unitId: 'x' },
      fields: [{ field: 'unitId', code: 'INVALID_UUID' }],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/assets/{id}/tag',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: { params: (w) => ({ id: w.bAssetId }), code: 'ASSET_NOT_FOUND' },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/maintenance/assets/{id}/events',
    auth: 'tenant',
    as: 'technician',
    denied: 'owner',
    foreign: { params: (w) => ({ id: w.bAssetId }), code: 'ASSET_NOT_FOUND' },
    invalid: pageInvalid,
  },
  {
    method: 'GET',
    path: '/maintenance/assets/{id}/impact',
    auth: 'tenant',
    as: 'technician',
    denied: 'owner',
    foreign: { params: (w) => ({ id: w.bAssetId }), code: 'ASSET_NOT_FOUND' },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/maintenance/documents',
    auth: 'tenant',
    as: 'technician',
    denied: 'owner',
    // The subject is a query parameter: another compound's asset is
    // ASSET_NOT_FOUND, covered by test/assets/assets.e2e-spec.ts.
    foreign: 'none',
    invalid: {
      query: { assetId: 'x' },
      fields: [{ field: 'assetId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/maintenance/documents',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: () => ({}),
      body: (w) => ({
        assetId: w.bAssetId,
        fileId: w.bAssetId,
        kind: 'manual',
        title: 'Manual',
      }),
      code: 'ASSET_NOT_FOUND',
    },
    invalid: {
      body: { fileId: 'x', kind: 'leaflet', title: '' },
      fields: [
        { field: 'fileId', code: 'INVALID_UUID' },
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: {
            allowed: [
              'plan',
              'manual',
              'warranty',
              'certificate',
              'photo',
              'other',
            ],
          },
        },
        {
          field: 'title',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 120 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/maintenance/documents/{id}/remove',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bDocumentId }),
      code: 'MAINTENANCE_DOCUMENT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/maintenance/asset-imports',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: pageInvalid,
  },
  {
    method: 'POST',
    path: '/maintenance/asset-imports',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: { fileId: 'x' },
      fields: [{ field: 'fileId', code: 'INVALID_UUID' }],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/asset-imports/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bAssetImportId }),
      code: 'ASSET_IMPORT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/maintenance/asset-imports/{id}/apply',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bAssetImportId }),
      code: 'ASSET_IMPORT_NOT_FOUND',
    },
    invalid: 'none',
  },
];

/** The compound's own work orders (ADR 0064): dispatch closes or sends back. */
export const WORK_ORDER_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/maintenance/tickets/{id}/accept-work',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: { params: (w) => ({ id: w.bTicketId }), code: 'TICKET_NOT_FOUND' },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/maintenance/tickets/{id}/send-back',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: () => ({ reasonCode: 'not_fixed', reason: 'Still leaking' }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: ['x'] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
];

const KINDS_OF_ITEM = ['check', 'reading', 'photo', 'text'];

/** Checklists and a ticket's run (ADR 0064). */
export const CHECKLIST_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/maintenance/checklists',
    auth: 'tenant',
    as: 'technician',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/maintenance/checklists',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: {
        key: 'Bad key',
        nameAr: 'فحص',
        nameEn: 'Check',
        purpose: 'audit',
        items: [],
      },
      fields: [
        { field: 'key', code: 'INVALID_FORMAT' },
        {
          field: 'purpose',
          code: 'INVALID_VALUE',
          params: { allowed: ['pm', 'inspection', 'any'] },
        },
        {
          field: 'items',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 100 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/checklists/{id}',
    auth: 'tenant',
    as: 'technician',
    denied: 'family',
    foreign: {
      params: (w) => ({ id: w.bChecklistId }),
      code: 'CHECKLIST_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/maintenance/checklists/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bChecklistId }),
      body: () => ({ active: false }),
      code: 'CHECKLIST_NOT_FOUND',
    },
    invalid: {
      body: { requireScan: 'yes' },
      fields: [{ field: 'requireScan', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'PUT',
    path: '/maintenance/checklists/{id}/items',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bChecklistId }),
      body: () => ({
        items: [{ kind: 'check', labelAr: 'ت', labelEn: 'Check' }],
      }),
      code: 'CHECKLIST_NOT_FOUND',
    },
    invalid: {
      body: { items: [{ kind: 'gauge', labelAr: '', labelEn: 'G' }] },
      fields: [
        {
          field: 'items.0.kind',
          code: 'INVALID_VALUE',
          params: { allowed: KINDS_OF_ITEM },
        },
        {
          field: 'items.0.labelAr',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 200 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/technician/tickets/{id}/checklist',
    auth: 'tenant',
    as: 'technician',
    denied: 'manager',
    foreign: { params: (w) => ({ id: w.bTicketId }), code: 'TICKET_NOT_FOUND' },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PUT',
    path: '/technician/tickets/{id}/checklist/items/{itemId}',
    auth: 'tenant',
    as: 'technician',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bTicketId, itemId: w.bTicketId }),
      body: () => ({ result: 'pass' }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: {
      body: { result: 'ok' },
      fields: [
        {
          field: 'result',
          code: 'INVALID_VALUE',
          params: { allowed: ['pass', 'fail', 'na'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/technician/tickets/{id}/checklist/submit',
    auth: 'tenant',
    as: 'technician',
    denied: 'manager',
    foreign: { params: (w) => ({ id: w.bTicketId }), code: 'TICKET_NOT_FOUND' },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/maintenance/tickets/{id}/checklist',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: { params: (w) => ({ id: w.bTicketId }), code: 'TICKET_NOT_FOUND' },
    invalid: 'none',
    noStore: true,
  },
];

/** Maintenance plans (ADR 0064). */
export const PLAN_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/maintenance/plans',
    auth: 'tenant',
    as: 'technician',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { active: 'yes' },
      fields: [
        {
          field: 'active',
          code: 'INVALID_VALUE',
          params: { allowed: ['true', 'false'] },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/plans',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: {
        every: 0,
        assetId: 'x',
        title: '',
        trigger: 'weekly',
        anchorOn: NO_SUCH_DAY,
      },
      fields: [
        { field: 'assetId', code: 'INVALID_UUID' },
        {
          field: 'title',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 120 },
        },
        {
          field: 'trigger',
          code: 'INVALID_VALUE',
          params: { allowed: ['calendar', 'usage'] },
        },
        {
          field: 'every',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 365 },
        },
        { field: 'anchorOn', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/plans/{id}',
    auth: 'tenant',
    as: 'technician',
    denied: 'family',
    foreign: {
      params: (w) => ({ id: w.bPlanId }),
      code: 'MAINTENANCE_PLAN_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/maintenance/plans/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bPlanId }),
      body: () => ({ leadDays: 5 }),
      code: 'MAINTENANCE_PLAN_NOT_FOUND',
    },
    invalid: {
      body: { leadDays: 61, anchorOn: NO_SUCH_DAY },
      fields: [
        { field: 'anchorOn', code: 'INVALID_FORMAT' },
        {
          field: 'leadDays',
          code: 'INVALID_NUMBER',
          params: { min: 0, max: 60 },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/plans/{id}/deactivate',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bPlanId }),
      body: () => ({ reasonCode: 'no_longer_needed' }),
      code: 'MAINTENANCE_PLAN_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/maintenance/plans/{id}/reactivate',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bPlanId }),
      code: 'MAINTENANCE_PLAN_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/maintenance/plans/{id}/defer',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bPlanId }),
      body: () => ({ toDate: '2030-01-01', reasonCode: 'weather' }),
      code: 'MAINTENANCE_PLAN_NOT_FOUND',
    },
    invalid: {
      body: { toDate: NO_SUCH_DAY },
      fields: [{ field: 'toDate', code: 'INVALID_FORMAT' }],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/plans/{id}/skip',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bPlanId }),
      body: () => ({ reasonCode: 'not_needed' }),
      code: 'MAINTENANCE_PLAN_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/maintenance/plans/{id}/occurrences',
    auth: 'tenant',
    as: 'technician',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bPlanId }),
      code: 'MAINTENANCE_PLAN_NOT_FOUND',
    },
    invalid: pageInvalid,
  },
  {
    method: 'GET',
    path: '/maintenance/plans/{id}/events',
    auth: 'tenant',
    as: 'technician',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bPlanId }),
      code: 'MAINTENANCE_PLAN_NOT_FOUND',
    },
    invalid: pageInvalid,
  },
  {
    method: 'POST',
    path: '/maintenance/plan-occurrences/{id}/defer',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bOccurrenceId }),
      body: () => ({ toDate: '2030-01-01', reasonCode: 'weather' }),
      code: 'PLAN_OCCURRENCE_NOT_FOUND',
    },
    invalid: {
      body: { toDate: NO_SUCH_DAY },
      fields: [{ field: 'toDate', code: 'INVALID_FORMAT' }],
    },
  },
];

const INSPECTION_STATUS_LIST = [
  'scheduled',
  'in_progress',
  'submitted',
  'cancelled',
];
const periodInvalid = {
  query: { from: NO_SUCH_DAY, to: '2026-04-31' },
  fields: [
    { field: 'from', code: 'INVALID_FORMAT' },
    { field: 'to', code: 'INVALID_FORMAT' },
  ],
};

/** Inspections (ADR 0064): rounds, inspections, the report, the inspector's. */
export const INSPECTION_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/maintenance/inspection-rounds',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { active: 'yes' },
      fields: [
        {
          field: 'active',
          code: 'INVALID_VALUE',
          params: { allowed: ['true', 'false'] },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/inspection-rounds',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: {
        title: '',
        checklistId: 'x',
        assigneeId: 'x',
        every: 0,
        unit: 'hour',
        anchorOn: NO_SUCH_DAY,
      },
      fields: [
        {
          field: 'title',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 120 },
        },
        { field: 'checklistId', code: 'INVALID_UUID' },
        { field: 'assigneeId', code: 'INVALID_UUID' },
        {
          field: 'every',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 365 },
        },
        {
          field: 'unit',
          code: 'INVALID_VALUE',
          params: { allowed: ['day', 'week', 'month', 'year'] },
        },
        { field: 'anchorOn', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/inspection-rounds/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bRoundId }),
      code: 'INSPECTION_ROUND_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/maintenance/inspection-rounds/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bRoundId }),
      body: () => ({ leadDays: 3 }),
      code: 'INSPECTION_ROUND_NOT_FOUND',
    },
    invalid: {
      body: { leadDays: 61, anchorOn: NO_SUCH_DAY },
      fields: [
        { field: 'anchorOn', code: 'INVALID_FORMAT' },
        {
          field: 'leadDays',
          code: 'INVALID_NUMBER',
          params: { min: 0, max: 60 },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/inspection-rounds/{id}/deactivate',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bRoundId }),
      code: 'INSPECTION_ROUND_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/maintenance/inspection-rounds/{id}/reactivate',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bRoundId }),
      code: 'INSPECTION_ROUND_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/maintenance/inspections',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { status: 'late' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: INSPECTION_STATUS_LIST },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/inspections',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: { checklistId: 'x', assigneeId: 'x', dueOn: NO_SUCH_DAY },
      fields: [
        { field: 'checklistId', code: 'INVALID_UUID' },
        { field: 'assigneeId', code: 'INVALID_UUID' },
        { field: 'dueOn', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/maintenance/inspections/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bInspectionId }),
      code: 'INSPECTION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/maintenance/inspections/{id}/cancel',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bInspectionId }),
      body: () => ({ reasonCode: 'not_needed' }),
      code: 'INSPECTION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/maintenance/inspection-report',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: periodInvalid,
  },
  {
    method: 'GET',
    path: '/maintenance/inspection-report/export',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: periodInvalid,
    noStore: true,
  },
  {
    method: 'GET',
    path: '/technician/inspections',
    auth: 'tenant',
    as: 'technician',
    denied: 'manager',
    foreign: 'none',
    invalid: {
      query: { status: 'late' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: INSPECTION_STATUS_LIST },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/technician/inspections/{id}',
    auth: 'tenant',
    as: 'technician',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bInspectionId }),
      code: 'INSPECTION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/technician/inspections/{id}/start',
    auth: 'tenant',
    as: 'technician',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bInspectionId }),
      code: 'INSPECTION_NOT_FOUND',
    },
    invalid: {
      body: { code: '' },
      fields: [
        { field: 'code', code: 'INVALID_LENGTH', params: { min: 1, max: 200 } },
      ],
    },
    noStore: true,
  },
  {
    method: 'PUT',
    path: '/technician/inspections/{id}/items/{itemId}',
    auth: 'tenant',
    as: 'technician',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bInspectionId, itemId: w.bInspectionId }),
      body: () => ({ result: 'pass' }),
      code: 'INSPECTION_NOT_FOUND',
    },
    invalid: {
      body: { result: 'ok' },
      fields: [
        {
          field: 'result',
          code: 'INVALID_VALUE',
          params: { allowed: ['pass', 'fail', 'na'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/technician/inspections/{id}/submit',
    auth: 'tenant',
    as: 'technician',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bInspectionId }),
      code: 'INSPECTION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
];

/** The technician in the field, and the recommendations (ADR 0064). */
export const FIELD_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/technician/scan',
    auth: 'tenant',
    as: 'technician',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { code: '' },
      fields: [
        { field: 'code', code: 'INVALID_LENGTH', params: { min: 1, max: 200 } },
      ],
    },
  },
  {
    method: 'GET',
    path: '/technician/assets/{id}',
    auth: 'tenant',
    as: 'technician',
    denied: 'owner',
    foreign: { params: (w) => ({ id: w.bAssetId }), code: 'ASSET_NOT_FOUND' },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/technician/assets/{id}/readings',
    auth: 'tenant',
    as: 'technician',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bAssetId }),
      body: () => ({
        readings: [
          {
            metricKey: 'run_hours',
            value: '10',
            occurredAt: new Date().toISOString(),
          },
        ],
      }),
      code: 'ASSET_NOT_FOUND',
    },
    invalid: {
      body: { readings: [] },
      fields: [
        {
          field: 'readings',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 20 },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/technician/assets/{id}/faults',
    auth: 'tenant',
    as: 'technician',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bAssetId }),
      body: () => ({ description: 'A leak at the seal' }),
      code: 'ASSET_NOT_FOUND',
    },
    invalid: {
      body: { description: '' },
      fields: [
        {
          field: 'description',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 2000 },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/technician/assets/{id}/replacement-recommendations',
    auth: 'tenant',
    as: 'technician',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bAssetId }),
      body: () => ({ reasonCode: 'end_of_life' }),
      code: 'ASSET_NOT_FOUND',
    },
    invalid: {
      body: { note: '' },
      fields: [
        {
          field: 'note',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 1000 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/technician/plans/upcoming',
    auth: 'tenant',
    as: 'technician',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/maintenance/replacement-recommendations',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { status: 'open' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['pending', 'accepted', 'declined'] },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/replacement-recommendations/{id}/accept',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bRecommendationId }),
      code: 'REPLACEMENT_RECOMMENDATION_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/maintenance/replacement-recommendations/{id}/decline',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bRecommendationId }),
      body: () => ({ reasonCode: 'budget' }),
      code: 'REPLACEMENT_RECOMMENDATION_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: ['x'] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
];

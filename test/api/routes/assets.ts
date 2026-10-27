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
      body: { code: 'with space', typeId: 'x', nameAr: '', nameEn: 'Pump' },
      fields: [
        { field: 'code', code: 'INVALID_FORMAT' },
        { field: 'typeId', code: 'INVALID_UUID' },
        {
          field: 'nameAr',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 120 },
        },
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
      body: { condition: 'broken' },
      fields: [
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

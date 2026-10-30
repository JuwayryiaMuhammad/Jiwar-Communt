import type { Row } from '../registry';

const METER_KINDS = ['electricity', 'water', 'gas', 'fuel', 'run_hours'];
/** A day shaped right that does not exist (ADR 0025, ADR 0066). */
const NO_SUCH_DAY = '2026-02-30';

/** What reads energy (`energy.read`) or keeps it (`energy.manage`): the supervisor and the manager, never a technician. */
const keeper = (row: Omit<Row, 'auth' | 'as' | 'denied'>): Row => ({
  auth: 'tenant',
  as: 'manager',
  denied: 'technician',
  ...row,
});

/** Meters (ADR 0066). */
export const METER_ROUTES: Row[] = [
  keeper({
    method: 'GET',
    path: '/maintenance/meters',
    foreign: 'none',
    invalid: {
      query: { kind: 'steam', active: 'yes' },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: METER_KINDS },
        },
        {
          field: 'active',
          code: 'INVALID_VALUE',
          params: { allowed: ['true', 'false'] },
        },
      ],
    },
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/meters',
    foreign: 'none',
    invalid: {
      body: {
        code: 'with space',
        kind: 'steam',
        multiplier: 'x',
        installedOn: NO_SUCH_DAY,
      },
      fields: [
        { field: 'code', code: 'INVALID_FORMAT' },
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: METER_KINDS },
        },
        { field: 'multiplier', code: 'INVALID_FORMAT' },
        { field: 'installedOn', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  keeper({
    method: 'GET',
    path: '/maintenance/meters/{id}',
    foreign: { params: (w) => ({ id: w.bMeterId }), code: 'METER_NOT_FOUND' },
    invalid: 'none',
  }),
  keeper({
    method: 'PATCH',
    path: '/maintenance/meters/{id}',
    foreign: {
      params: (w) => ({ id: w.bMeterId }),
      body: () => ({ serial: 'SN-1' }),
      code: 'METER_NOT_FOUND',
    },
    invalid: {
      body: { serial: '', installedOn: NO_SUCH_DAY },
      fields: [
        {
          field: 'serial',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 60 },
        },
        { field: 'installedOn', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/meters/{id}/retire',
    foreign: {
      params: (w) => ({ id: w.bMeterId }),
      body: () => ({ reasonCode: 'faulty' }),
      code: 'METER_NOT_FOUND',
    },
    invalid: 'none',
  }),
];

const BOOL = ['true', 'false'];

/** A meter's readings, its alerts and the spike rule (ADR 0066). */
export const READING_ROUTES: Row[] = [
  keeper({
    method: 'GET',
    path: '/maintenance/meters/{id}/readings',
    foreign: { params: (w) => ({ id: w.bMeterId }), code: 'METER_NOT_FOUND' },
    invalid: {
      query: { superseded: 'yes' },
      fields: [
        {
          field: 'superseded',
          code: 'INVALID_VALUE',
          params: { allowed: BOOL },
        },
      ],
    },
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/meters/{id}/readings',
    foreign: {
      params: (w) => ({ id: w.bMeterId }),
      body: () => ({ readOn: '2026-01-02', value: '11' }),
      code: 'METER_NOT_FOUND',
    },
    invalid: {
      body: { readOn: NO_SUCH_DAY, value: '-1' },
      fields: [
        { field: 'readOn', code: 'INVALID_FORMAT' },
        { field: 'value', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/meters/{id}/readings/{readingId}/correct',
    foreign: {
      params: (w) => ({ id: w.bMeterId, readingId: w.bReadingId }),
      body: () => ({ value: '12', reasonCode: 'misread' }),
      code: 'METER_NOT_FOUND',
    },
    invalid: {
      body: { value: 'x', readOn: NO_SUCH_DAY },
      fields: [
        { field: 'value', code: 'INVALID_FORMAT' },
        { field: 'readOn', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/meters/{id}/readings/{readingId}/withdraw',
    foreign: {
      params: (w) => ({ id: w.bMeterId, readingId: w.bReadingId }),
      body: () => ({ reasonCode: 'wrong_meter' }),
      code: 'METER_NOT_FOUND',
    },
    invalid: 'none',
  }),
  keeper({
    method: 'GET',
    path: '/maintenance/meter-alerts',
    foreign: 'none',
    invalid: {
      query: { meterId: 'x', open: 'yes' },
      fields: [
        { field: 'meterId', code: 'INVALID_UUID' },
        { field: 'open', code: 'INVALID_VALUE', params: { allowed: BOOL } },
      ],
    },
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/meter-alerts/{id}/acknowledge',
    foreign: {
      params: (w) => ({ id: w.bMeterAlertId }),
      code: 'METER_ALERT_NOT_FOUND',
    },
    invalid: 'none',
  }),
  keeper({
    method: 'GET',
    path: '/maintenance/energy/settings',
    foreign: 'none',
    invalid: 'none',
  }),
  keeper({
    method: 'PATCH',
    path: '/maintenance/energy/settings',
    foreign: 'none',
    invalid: {
      body: { anomalyFactor: 'x', anomalyPeriods: 30 },
      fields: [
        { field: 'anomalyFactor', code: 'INVALID_FORMAT' },
        {
          field: 'anomalyPeriods',
          code: 'INVALID_NUMBER',
          params: { min: 3, max: 24 },
        },
      ],
    },
  }),
];

/** The meters a technician reads (ADR 0066): `meters.record`, staff only. */
export const TECHNICIAN_METER_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/technician/meters/{id}',
    auth: 'tenant',
    as: 'technician',
    denied: 'manager',
    foreign: { params: (w) => ({ id: w.bMeterId }), code: 'METER_NOT_FOUND' },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/technician/meters/{id}/readings',
    auth: 'tenant',
    as: 'technician',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bMeterId }),
      body: () => ({ readOn: '2026-01-02', value: '11' }),
      code: 'METER_NOT_FOUND',
    },
    invalid: {
      body: { readOn: NO_SUCH_DAY, value: '1.23456' },
      fields: [
        { field: 'readOn', code: 'INVALID_FORMAT' },
        { field: 'value', code: 'INVALID_FORMAT' },
      ],
    },
  },
];

/** Sheets of meter readings (ADR 0066). */
export const READING_IMPORT_ROUTES: Row[] = [
  keeper({
    method: 'GET',
    path: '/maintenance/meter-reading-imports',
    foreign: 'none',
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
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/meter-reading-imports',
    foreign: 'none',
    invalid: {
      body: { fileId: 'x' },
      fields: [{ field: 'fileId', code: 'INVALID_UUID' }],
    },
  }),
  keeper({
    method: 'GET',
    path: '/maintenance/meter-reading-imports/{id}',
    foreign: {
      params: (w) => ({ id: w.bReadingImportId }),
      code: 'METER_READING_IMPORT_NOT_FOUND',
    },
    invalid: 'none',
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/meter-reading-imports/{id}/apply',
    foreign: {
      params: (w) => ({ id: w.bReadingImportId }),
      code: 'METER_READING_IMPORT_NOT_FOUND',
    },
    invalid: 'none',
  }),
];

const KIND_INVALID = {
  field: 'kind',
  code: 'INVALID_VALUE',
  params: { allowed: METER_KINDS },
};

/** Consumption, tariffs and saving measures (ADR 0066). */
export const CONSUMPTION_ROUTES: Row[] = [
  keeper({
    method: 'GET',
    path: '/maintenance/energy/consumption',
    foreign: 'none',
    invalid: {
      query: { kind: 'steam', groupBy: 'floor', from: NO_SUCH_DAY },
      // The query's own fields first, then the period's it extends.
      fields: [
        KIND_INVALID,
        {
          field: 'groupBy',
          code: 'INVALID_VALUE',
          params: { allowed: ['meter', 'building', 'area'] },
        },
        { field: 'from', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  keeper({
    method: 'GET',
    path: '/maintenance/energy/consumption/export',
    foreign: 'none',
    invalid: {
      query: { kind: 'steam' },
      fields: [KIND_INVALID],
    },
    noStore: true,
  }),
  keeper({
    method: 'GET',
    path: '/maintenance/meters/{id}/consumption',
    foreign: { params: (w) => ({ id: w.bMeterId }), code: 'METER_NOT_FOUND' },
    invalid: {
      query: { from: NO_SUCH_DAY, to: '2026-04-31' },
      fields: [
        { field: 'from', code: 'INVALID_FORMAT' },
        { field: 'to', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  keeper({
    method: 'GET',
    path: '/maintenance/energy/tariffs',
    foreign: 'none',
    invalid: { query: { kind: 'steam' }, fields: [KIND_INVALID] },
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/energy/tariffs',
    foreign: 'none',
    invalid: {
      body: { kind: 'steam', effectiveOn: NO_SUCH_DAY, pricePerUnit: '-1' },
      fields: [
        KIND_INVALID,
        { field: 'effectiveOn', code: 'INVALID_FORMAT' },
        { field: 'pricePerUnit', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  keeper({
    method: 'GET',
    path: '/maintenance/energy/measures',
    foreign: 'none',
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
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/energy/measures',
    foreign: 'none',
    invalid: {
      body: {
        title: '',
        kind: 'steam',
        meterId: 'x',
        startsOn: NO_SUCH_DAY,
        cost: '-5',
      },
      fields: [
        {
          field: 'title',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 120 },
        },
        KIND_INVALID,
        { field: 'meterId', code: 'INVALID_UUID' },
        { field: 'startsOn', code: 'INVALID_FORMAT' },
        { field: 'cost', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  keeper({
    method: 'GET',
    path: '/maintenance/energy/measures/{id}',
    foreign: {
      params: (w) => ({ id: w.bMeasureId }),
      code: 'ENERGY_MEASURE_NOT_FOUND',
    },
    invalid: {
      query: { weeks: '27' },
      fields: [
        { field: 'weeks', code: 'INVALID_NUMBER', params: { min: 1, max: 26 } },
      ],
    },
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/energy/measures/{id}/end',
    foreign: {
      params: (w) => ({ id: w.bMeasureId }),
      body: () => ({ endedOn: '2026-01-02' }),
      code: 'ENERGY_MEASURE_NOT_FOUND',
    },
    invalid: {
      body: { endedOn: NO_SUCH_DAY },
      fields: [{ field: 'endedOn', code: 'INVALID_FORMAT' }],
    },
  }),
];

/**
 * A household's own consumption (ADR 0069), read through its unit by who
 * lives there; a guard has no place in any unit.
 */
export const HOUSEHOLD_CONSUMPTION_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/units/{unitId}/consumption',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      query: { kind: 'steam', from: NO_SUCH_DAY },
      // The query's own fields first, then the period's it extends.
      fields: [KIND_INVALID, { field: 'from', code: 'INVALID_FORMAT' }],
    },
  },
  {
    method: 'GET',
    path: '/units/{unitId}/consumption/benchmark',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      query: { kind: 'water', month: '2026-01' },
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      query: { kind: 'steam', month: '2027-13' },
      fields: [
        KIND_INVALID,
        {
          field: 'month',
          code: 'INVALID_FORMAT',
          params: { format: 'YYYY-MM' },
        },
      ],
    },
  },
];

const IN_A_WEEK = '2099-01-05T08:00:00+02:00';
const LATER = '2099-01-05T12:00:00+02:00';

/** Utility outages (ADR 0066), and the ones a resident was told of. */
export const OUTAGE_ROUTES: Row[] = [
  keeper({
    method: 'GET',
    path: '/maintenance/outages',
    foreign: 'none',
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
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/outages',
    foreign: 'none',
    invalid: {
      body: {
        kind: 'steam',
        planned: 'yes',
        buildings: [''],
        startsAt: '2099-01-05T08:00:00',
        endsAt: '2099-01-05 12:00Z',
      },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: ['water', 'electricity', 'gas', 'other'] },
        },
        { field: 'planned', code: 'INVALID_TYPE' },
        // The scope is required: the whole compound is said, never implied.
        { field: 'scope', code: 'FIELD_REQUIRED' },
        {
          field: 'buildings',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 100 },
        },
        { field: 'startsAt', code: 'INVALID_FORMAT' },
        { field: 'endsAt', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  keeper({
    method: 'GET',
    path: '/maintenance/outages/{id}',
    foreign: {
      params: (w) => ({ id: w.bOutageId }),
      code: 'UTILITY_OUTAGE_NOT_FOUND',
    },
    invalid: 'none',
  }),
  keeper({
    method: 'PATCH',
    path: '/maintenance/outages/{id}',
    foreign: {
      params: (w) => ({ id: w.bOutageId }),
      body: () => ({ endsAt: LATER }),
      code: 'UTILITY_OUTAGE_NOT_FOUND',
    },
    invalid: {
      body: {
        scope: 'street',
        startsAt: IN_A_WEEK.slice(0, 19),
        // A day that does not exist, offset and all.
        endsAt: '2027-02-29T09:00:00Z',
        note: '',
      },
      fields: [
        {
          field: 'scope',
          code: 'INVALID_VALUE',
          params: { allowed: ['compound', 'buildings'] },
        },
        { field: 'startsAt', code: 'INVALID_FORMAT' },
        { field: 'endsAt', code: 'INVALID_FORMAT' },
        { field: 'note', code: 'INVALID_LENGTH', params: { min: 1, max: 500 } },
      ],
    },
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/outages/{id}/end',
    foreign: {
      params: (w) => ({ id: w.bOutageId }),
      code: 'UTILITY_OUTAGE_NOT_FOUND',
    },
    invalid: 'none',
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/outages/{id}/cancel',
    foreign: {
      params: (w) => ({ id: w.bOutageId }),
      body: () => ({ reasonCode: 'not_needed' }),
      code: 'UTILITY_OUTAGE_NOT_FOUND',
    },
    invalid: 'none',
  }),
  {
    method: 'GET',
    path: '/me/outages',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: 'none',
    invalid: 'none',
  },
];

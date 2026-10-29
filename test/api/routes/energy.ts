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

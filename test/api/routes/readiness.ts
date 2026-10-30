import type { Row } from '../registry';

/** A day shaped right that does not exist (ADR 0025, ADR 0067). */
const NO_SUCH_DAY = '2026-02-30';
const READINESS_KINDS = ['season', 'event', 'emergency'];
const ITEM_KINDS = [
  'task',
  'inspection_campaign',
  'contract_review',
  'estimate',
];
const BOOL = ['true', 'false'];
const TITLE = { min: 1, max: 120 };
const LIMIT = { min: 1, max: 100 };

/** What keeps readiness (`readiness.manage`): the supervisor and the manager, never a technician. */
const keeper = (row: Omit<Row, 'auth' | 'as' | 'denied'>): Row => ({
  auth: 'tenant',
  as: 'manager',
  denied: 'technician',
  ...row,
});

/** Readiness programs and their items (ADR 0067). */
export const READINESS_ROUTES: Row[] = [
  keeper({
    method: 'GET',
    path: '/maintenance/readiness/programs',
    foreign: 'none',
    invalid: {
      query: { kind: 'holiday', open: 'yes', limit: '0' },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: READINESS_KINDS },
        },
        { field: 'open', code: 'INVALID_VALUE', params: { allowed: BOOL } },
        { field: 'limit', code: 'INVALID_NUMBER', params: LIMIT },
      ],
    },
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/readiness/programs',
    foreign: 'none',
    invalid: {
      body: {
        kind: 'holiday',
        title: '',
        startsOn: NO_SUCH_DAY,
        endsOn: '2026-13-01',
      },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: READINESS_KINDS },
        },
        { field: 'title', code: 'INVALID_LENGTH', params: TITLE },
        { field: 'startsOn', code: 'INVALID_FORMAT' },
        { field: 'endsOn', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  keeper({
    method: 'GET',
    path: '/maintenance/readiness/programs/{id}',
    foreign: {
      params: (w) => ({ id: w.bProgramId }),
      code: 'READINESS_PROGRAM_NOT_FOUND',
    },
    invalid: 'none',
  }),
  keeper({
    method: 'PATCH',
    path: '/maintenance/readiness/programs/{id}',
    foreign: {
      params: (w) => ({ id: w.bProgramId }),
      body: () => ({}),
      code: 'READINESS_PROGRAM_NOT_FOUND',
    },
    invalid: {
      body: { title: '', startsOn: NO_SUCH_DAY, endsOn: '2027-02-29' },
      fields: [
        { field: 'title', code: 'INVALID_LENGTH', params: TITLE },
        { field: 'startsOn', code: 'INVALID_FORMAT' },
        { field: 'endsOn', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/readiness/programs/{id}/close',
    foreign: {
      params: (w) => ({ id: w.bProgramId }),
      code: 'READINESS_PROGRAM_NOT_FOUND',
    },
    invalid: 'none',
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/readiness/programs/{id}/copy',
    foreign: {
      params: (w) => ({ id: w.bProgramId }),
      body: () => ({ startsOn: '2099-03-01' }),
      code: 'READINESS_PROGRAM_NOT_FOUND',
    },
    invalid: {
      body: { startsOn: NO_SUCH_DAY },
      fields: [{ field: 'startsOn', code: 'INVALID_FORMAT' }],
    },
  }),
  keeper({
    method: 'GET',
    path: '/maintenance/readiness/programs/{id}/items',
    foreign: {
      params: (w) => ({ id: w.bProgramId }),
      code: 'READINESS_PROGRAM_NOT_FOUND',
    },
    invalid: {
      query: { limit: '0' },
      fields: [{ field: 'limit', code: 'INVALID_NUMBER', params: LIMIT }],
    },
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/readiness/programs/{id}/items',
    // The owner is checked first (accounts are locked before the program):
    // A's own manager, so the program is what is not found.
    foreign: {
      params: (w) => ({ id: w.bProgramId }),
      body: (w) => ({
        kind: 'task',
        title: 'Check the pumps',
        ownerId: w.a.ids.manager,
        dueOn: '2099-01-01',
      }),
      code: 'READINESS_PROGRAM_NOT_FOUND',
    },
    invalid: {
      body: {
        kind: 'chore',
        title: '',
        ownerId: 'x',
        dueOn: NO_SUCH_DAY,
        estimateAmount: '1.234',
        contractId: 'x',
        checklistId: 'x',
      },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: ITEM_KINDS },
        },
        { field: 'title', code: 'INVALID_LENGTH', params: TITLE },
        { field: 'ownerId', code: 'INVALID_UUID' },
        { field: 'dueOn', code: 'INVALID_FORMAT' },
        {
          field: 'estimateAmount',
          code: 'INVALID_FORMAT',
          params: { format: 'amount' },
        },
        { field: 'contractId', code: 'INVALID_UUID' },
        { field: 'checklistId', code: 'INVALID_UUID' },
      ],
    },
  }),
  keeper({
    method: 'GET',
    path: '/maintenance/readiness/programs/{id}/contracts-due',
    foreign: {
      params: (w) => ({ id: w.bProgramId }),
      code: 'READINESS_PROGRAM_NOT_FOUND',
    },
    invalid: 'none',
  }),
  keeper({
    method: 'PATCH',
    path: '/maintenance/readiness/items/{itemId}',
    foreign: {
      params: (w) => ({ itemId: w.bReadinessItemId }),
      body: () => ({}),
      code: 'READINESS_ITEM_NOT_FOUND',
    },
    invalid: {
      body: {
        title: '',
        ownerId: 'x',
        dueOn: '2026-04-31',
        estimateAmount: 'abc',
      },
      fields: [
        { field: 'title', code: 'INVALID_LENGTH', params: TITLE },
        { field: 'ownerId', code: 'INVALID_UUID' },
        { field: 'dueOn', code: 'INVALID_FORMAT' },
        {
          field: 'estimateAmount',
          code: 'INVALID_FORMAT',
          params: { format: 'amount' },
        },
      ],
    },
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/readiness/items/{itemId}/done',
    foreign: {
      params: (w) => ({ itemId: w.bReadinessItemId }),
      body: () => ({}),
      code: 'READINESS_ITEM_NOT_FOUND',
    },
    invalid: {
      body: { decision: 'extend' },
      fields: [
        {
          field: 'decision',
          code: 'INVALID_VALUE',
          params: { allowed: ['renew', 'replace', 'end'] },
        },
      ],
    },
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/readiness/items/{itemId}/cancel',
    foreign: {
      params: (w) => ({ itemId: w.bReadinessItemId }),
      body: () => ({ reasonCode: 'not_needed' }),
      code: 'READINESS_ITEM_NOT_FOUND',
    },
    invalid: 'none',
  }),
  // An owner's own items: any staff member or the manager, no permission.
  {
    method: 'GET',
    path: '/staff/readiness-items',
    auth: 'tenant',
    as: 'manager',
    denied: 'none',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/readiness-items/{itemId}/done',
    auth: 'tenant',
    as: 'manager',
    denied: 'none',
    foreign: {
      params: (w) => ({ itemId: w.bReadinessItemId }),
      body: () => ({}),
      code: 'READINESS_ITEM_NOT_FOUND',
    },
    invalid: {
      body: { decision: 'extend' },
      fields: [
        {
          field: 'decision',
          code: 'INVALID_VALUE',
          params: { allowed: ['renew', 'replace', 'end'] },
        },
      ],
    },
  },
];

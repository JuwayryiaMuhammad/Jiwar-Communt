import type { Row } from '../registry';

const HAZARDS = [
  'hot_work',
  'height',
  'live_electrical',
  'confined_space',
  'pool_chemicals',
];
const STATUSES = ['requested', 'approved', 'rejected', 'revoked', 'closed'];
const LIMIT = { min: 1, max: 100 };
const IN_AN_HOUR = () => new Date(Date.now() + 3_600_000).toISOString();

/** Who decides permits and keeps the instructions (`safety.manage`): never a technician. */
const keeper = (row: Omit<Row, 'auth' | 'as' | 'denied'>): Row => ({
  auth: 'tenant',
  as: 'manager',
  denied: 'technician',
  ...row,
});
/** The technician's own ticket (`tickets.work`): never the manager. */
const technician = (row: Omit<Row, 'auth' | 'as' | 'denied'>): Row => ({
  auth: 'tenant',
  as: 'technician',
  denied: 'manager',
  ...row,
});

/** Work permits, hazards and safety instructions (ADR 0067). */
export const FIELD_SAFETY_ROUTES: Row[] = [
  keeper({
    method: 'GET',
    path: '/maintenance/work-permits',
    foreign: 'none',
    invalid: {
      query: { status: 'open', ticketId: 'x', limit: '0' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: STATUSES },
        },
        { field: 'ticketId', code: 'INVALID_UUID' },
        { field: 'limit', code: 'INVALID_NUMBER', params: LIMIT },
      ],
    },
  }),
  keeper({
    method: 'GET',
    path: '/maintenance/work-permits/{id}',
    foreign: {
      params: (w) => ({ id: w.bWorkPermitId }),
      code: 'WORK_PERMIT_NOT_FOUND',
    },
    invalid: 'none',
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/work-permits/{id}/approve',
    foreign: {
      params: (w) => ({ id: w.bWorkPermitId }),
      code: 'WORK_PERMIT_NOT_FOUND',
    },
    invalid: 'none',
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/work-permits/{id}/reject',
    foreign: {
      params: (w) => ({ id: w.bWorkPermitId }),
      body: () => ({ reasonCode: 'other' }),
      code: 'WORK_PERMIT_NOT_FOUND',
    },
    invalid: 'none',
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/work-permits/{id}/revoke',
    foreign: {
      params: (w) => ({ id: w.bWorkPermitId }),
      body: () => ({ reasonCode: 'other' }),
      code: 'WORK_PERMIT_NOT_FOUND',
    },
    invalid: 'none',
  }),
  keeper({
    method: 'GET',
    path: '/maintenance/tickets/{id}/permits',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: 'none',
  }),
  technician({
    method: 'GET',
    path: '/technician/tickets/{id}/permits',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: 'none',
  }),
  technician({
    method: 'POST',
    path: '/technician/tickets/{id}/permits',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: () => ({
        hazard: 'height',
        precautions: 'Harness and a spotter',
        expiresAt: IN_AN_HOUR(),
      }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: {
      body: {
        hazard: 'fire',
        precautions: '',
        expiresAt: '2099-01-05T08:00:00',
      },
      fields: [
        {
          field: 'hazard',
          code: 'INVALID_VALUE',
          params: { allowed: HAZARDS },
        },
        {
          field: 'precautions',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 2000 },
        },
        { field: 'expiresAt', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  technician({
    method: 'GET',
    path: '/technician/tickets/{id}/safety',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: 'none',
  }),
  technician({
    method: 'POST',
    path: '/technician/tickets/{id}/safety/acknowledge',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: () => ({ instructionId: '0192a5f0-1c2b-7d3e-8f40-000000006706' }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: {
      body: { instructionId: 'x' },
      fields: [{ field: 'instructionId', code: 'INVALID_UUID' }],
    },
  }),
  keeper({
    method: 'PUT',
    path: '/maintenance/categories/{id}/permit-hazards',
    foreign: {
      params: (w) => ({ id: w.bCategoryId }),
      body: () => ({ hazards: ['height'] }),
      code: 'TICKET_CATEGORY_NOT_FOUND',
    },
    invalid: {
      body: { hazards: ['fire'] },
      fields: [
        {
          field: 'hazards',
          code: 'INVALID_VALUE',
          params: { allowed: HAZARDS },
        },
      ],
    },
  }),
  keeper({
    method: 'GET',
    path: '/maintenance/categories/{id}/safety-instructions',
    foreign: {
      params: (w) => ({ id: w.bCategoryId }),
      code: 'TICKET_CATEGORY_NOT_FOUND',
    },
    invalid: 'none',
  }),
  keeper({
    method: 'POST',
    path: '/maintenance/categories/{id}/safety-instructions',
    foreign: {
      params: (w) => ({ id: w.bCategoryId }),
      body: () => ({ textEn: 'Wear gloves', textAr: 'ارتدِ القفازات' }),
      code: 'TICKET_CATEGORY_NOT_FOUND',
    },
    invalid: {
      body: { textEn: '', textAr: 5 },
      fields: [
        {
          field: 'textEn',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 4000 },
        },
        { field: 'textAr', code: 'INVALID_TYPE' },
      ],
    },
  }),
  keeper({
    method: 'PUT',
    path: '/maintenance/asset-types/{id}/permit-hazards',
    foreign: {
      params: (w) => ({ id: w.bAssetTypeId }),
      body: () => ({ hazards: [] }),
      code: 'ASSET_TYPE_NOT_FOUND',
    },
    invalid: {
      body: { hazards: 'height' },
      fields: [{ field: 'hazards', code: 'INVALID_TYPE' }],
    },
  }),
];

import type { Row } from '../registry';

/** A ticket's costs (ADR 0065): dispatch's. */
export const COST_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/maintenance/tickets/{id}/costs',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: { params: (w) => ({ id: w.bTicketId }), code: 'TICKET_NOT_FOUND' },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/maintenance/tickets/{id}/costs',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: () => ({
        kind: 'labour',
        description: 'Two hours',
        quantity: '2',
        unitAmount: '80',
      }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: {
      body: { kind: 'part', description: '', quantity: '0', unitAmount: '-1' },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: ['labour', 'contractor', 'other'] },
        },
        {
          field: 'description',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 200 },
        },
        { field: 'quantity', code: 'INVALID_FORMAT' },
        { field: 'unitAmount', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/ticket-costs/{id}/void',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bCostEntryId }),
      body: () => ({ reasonCode: 'duplicate' }),
      code: 'TICKET_COST_ENTRY_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: ['x'] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
];

/** The technician's suggested quotes, and dispatch's decision (ADR 0065). */
export const QUOTE_SUGGESTION_ROUTES: Row[] = [
  ...(['technician', 'manager'] as const).map((as): Row => ({
    method: 'GET',
    path:
      as === 'technician'
        ? '/technician/tickets/{id}/quote-suggestions'
        : '/maintenance/tickets/{id}/quote-suggestions',
    auth: 'tenant',
    as,
    denied: as === 'technician' ? 'manager' : 'technician',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: 'none',
  })),
  {
    method: 'POST',
    path: '/technician/tickets/{id}/quote-suggestions',
    auth: 'tenant',
    as: 'technician',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: () => ({ amount: '300' }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: {
      body: { amount: '0', note: '' },
      fields: [
        { field: 'amount', code: 'INVALID_FORMAT' },
        {
          field: 'note',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 1000 },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/quote-suggestions/{id}/send',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bQuoteSuggestionId }),
      body: () => ({}),
      code: 'QUOTE_SUGGESTION_NOT_FOUND',
    },
    invalid: {
      body: { amount: 'x' },
      fields: [{ field: 'amount', code: 'INVALID_FORMAT' }],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/quote-suggestions/{id}/dismiss',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bQuoteSuggestionId }),
      body: () => ({ reasonCode: 'not_needed' }),
      code: 'QUOTE_SUGGESTION_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: ['x'] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
];

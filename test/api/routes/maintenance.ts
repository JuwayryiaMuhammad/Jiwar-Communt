import type { Row } from '../registry';

const PRIORITIES = ['normal', 'urgent', 'emergency'];

/** Maintenance: categories and settings (ADR 0032). */
export const MAINTENANCE_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/maintenance/categories',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/maintenance/categories',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { key: 'Pool!', nameAr: '', nameEn: 'Pool', defaultPriority: 'x' },
      fields: [
        { field: 'key', code: 'INVALID_FORMAT' },
        {
          field: 'nameAr',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 80 },
        },
        {
          field: 'defaultPriority',
          code: 'INVALID_VALUE',
          params: { allowed: PRIORITIES },
        },
      ],
    },
  },
  {
    method: 'PATCH',
    path: '/maintenance/categories/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'family',
    foreign: {
      params: (w) => ({ id: w.bCategoryId }),
      body: () => ({ active: false }),
      code: 'TICKET_CATEGORY_NOT_FOUND',
    },
    invalid: {
      body: { active: 'no' },
      fields: [{ field: 'active', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/maintenance/settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { autoCloseHours: 0, reopenDays: 91, maxReportPhotos: 1.5 },
      fields: [
        {
          field: 'autoCloseHours',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 720 },
        },
        {
          field: 'reopenDays',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 90 },
        },
        {
          field: 'maxReportPhotos',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 10 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/ticket-categories',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
  },
];

const STATUSES = [
  'new',
  'assigned',
  'in_progress',
  'on_hold',
  'completed',
  'closed',
  'cancelled',
];

/** A ticket body that passes validation (the lookup is what fails). */
export const ticketBody = (unitId: string, categoryId: string) => ({
  unitId,
  categoryId,
  description: 'A leak under the sink',
});

/** Tickets: residents, and dispatch (ADR 0032). */
export const TICKET_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/tickets',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: () => ({}),
      body: (w) => ticketBody(w.b.homeUnitId, w.aCategoryId),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { categoryId: 'x', priority: 'high', description: '' },
      fields: [
        { field: 'categoryId', code: 'INVALID_UUID' },
        {
          field: 'priority',
          code: 'INVALID_VALUE',
          params: { allowed: PRIORITIES },
        },
        {
          field: 'description',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 2000 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/tickets',
    auth: 'tenant',
    as: 'family',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { status: 'open' },
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
    method: 'GET',
    path: '/tickets/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/tickets/{id}/photos',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: (w) => ({ fileId: w.bFileId }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: {
      body: { fileId: 'x' },
      fields: [{ field: 'fileId', code: 'INVALID_UUID' }],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/tickets',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { unassigned: 'yes' },
      fields: [
        {
          field: 'unassigned',
          code: 'INVALID_VALUE',
          params: { allowed: ['true', 'false'] },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/tickets',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: () => ({}),
      body: (w) => ({
        ...ticketBody(w.b.homeUnitId, w.aCategoryId),
        reporterAccountId: w.a.ids.owner,
      }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { reporterAccountId: 'x', categoryId: 'y', description: '' },
      // A subclass's own fields come first.
      fields: [
        { field: 'reporterAccountId', code: 'INVALID_UUID' },
        { field: 'categoryId', code: 'INVALID_UUID' },
        {
          field: 'description',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 2000 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/tickets/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/maintenance/tickets/{id}/history',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/maintenance/tickets/{id}/assignments',
    auth: 'tenant',
    as: 'manager',
    denied: 'family',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: 'none',
  },
];

const HOLD_REASONS = ['awaiting_resident', 'awaiting_parts', 'other'];

/** A technician action on another compound's ticket: just not found. */
const technicianAction = (
  verb: string,
  invalid: Row['invalid'] = 'none',
  body?: object,
): Row => ({
  method: 'POST',
  path: `/technician/tickets/{id}/${verb}`,
  auth: 'tenant',
  as: 'technician',
  denied: 'manager',
  foreign: {
    params: (w) => ({ id: w.bTicketId }),
    ...(body ? { body: () => body } : {}),
    code: 'TICKET_NOT_FOUND',
  },
  invalid,
});

/** The technician's workflow and manual dispatch (ADR 0032). */
export const WORK_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/technician/tickets',
    auth: 'tenant',
    as: 'technician',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { status: 'done' },
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
    method: 'GET',
    path: '/technician/tickets/{id}',
    auth: 'tenant',
    as: 'technician',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  technicianAction('start'),
  technicianAction(
    'hold',
    {
      body: { holdReason: 'lunch' },
      fields: [
        {
          field: 'holdReason',
          code: 'INVALID_VALUE',
          params: { allowed: HOLD_REASONS },
        },
      ],
    },
    { holdReason: 'awaiting_parts' },
  ),
  technicianAction('resume'),
  technicianAction('complete'),
  technicianAction(
    'decline',
    {
      body: { reasonCode: 5 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    { reasonCode: 'unavailable' },
  ),
  {
    ...technicianAction(
      'photos',
      {
        body: { fileId: 'x', kind: 'during' },
        fields: [
          {
            field: 'kind',
            code: 'INVALID_VALUE',
            params: { allowed: ['before', 'after'] },
          },
          { field: 'fileId', code: 'INVALID_UUID' },
        ],
      },
      { fileId: '00000000-0000-7000-8000-000000000000', kind: 'before' },
    ),
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: (w) => ({ fileId: w.bFileId, kind: 'before' }),
      code: 'TICKET_NOT_FOUND',
    },
  },
  {
    method: 'POST',
    path: '/maintenance/tickets/{id}/assign',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: (w) => ({ technicianId: w.a.ids.technician }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: {
      body: { technicianId: 'x' },
      fields: [{ field: 'technicianId', code: 'INVALID_UUID' }],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/tickets/{id}/reassign',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: (w) => ({
        technicianId: w.a.ids.technician,
        reasonCode: 'workload',
      }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: {
      body: { technicianId: 'x', reasonCode: 1 },
      fields: [
        { field: 'reasonCode', code: 'INVALID_TYPE' },
        { field: 'technicianId', code: 'INVALID_UUID' },
      ],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/tickets/{id}/priority',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: () => ({ priority: 'urgent', reasonCode: 'reassessed' }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: {
      body: { priority: 'high' },
      fields: [
        {
          field: 'priority',
          code: 'INVALID_VALUE',
          params: { allowed: PRIORITIES },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/technicians',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
  },
];

import type { Row } from '../registry';

const PRIORITIES = ['normal', 'urgent', 'emergency'];
/** ADR 0038: the rooms of a unit's ticket. */
const UNIT_LOCATIONS = [
  'kitchen',
  'bathroom',
  'living_room',
  'bedroom',
  'balcony',
  'other',
];

/** A valid body for a category's SLA targets (ADR 0034). */
const SLA_TARGETS = {
  emergency: { responseMinutes: 60, resolutionMinutes: 1440 },
  urgent: { responseMinutes: 240, resolutionMinutes: 4320 },
  normal: { responseMinutes: 1440, resolutionMinutes: 10080 },
};

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
    method: 'PUT',
    path: '/maintenance/categories/{id}/specialties',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bCategoryId }),
      body: () => ({ specialtyIds: [] }),
      code: 'TICKET_CATEGORY_NOT_FOUND',
    },
    invalid: {
      body: { specialtyIds: 'x' },
      fields: [{ field: 'specialtyIds', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'PUT',
    path: '/maintenance/categories/{id}/sla-targets',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bCategoryId }),
      body: () => SLA_TARGETS,
      code: 'TICKET_CATEGORY_NOT_FOUND',
    },
    invalid: {
      body: {
        ...SLA_TARGETS,
        urgent: { responseMinutes: 4, resolutionMinutes: 1.5 },
      },
      fields: [
        {
          field: 'urgent.responseMinutes',
          code: 'INVALID_NUMBER',
          params: { min: 5, max: 10080 },
        },
        {
          field: 'urgent.resolutionMinutes',
          code: 'INVALID_NUMBER',
          params: { min: 15, max: 43200 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/sla-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/maintenance/sla-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { slaEnabled: 'yes' },
      fields: [{ field: 'slaEnabled', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/dispatch-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/maintenance/dispatch-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: {
        autoDispatchEnabled: 'yes',
        weightAssigned: -1,
        weightOnHold: 1.234,
        multiplierNormal: 0,
        multiplierEmergency: 101,
      },
      fields: [
        { field: 'autoDispatchEnabled', code: 'INVALID_TYPE' },
        {
          field: 'weightAssigned',
          code: 'INVALID_NUMBER',
          params: { min: 0, max: 100 },
        },
        {
          field: 'weightOnHold',
          code: 'INVALID_NUMBER',
          params: { min: 0, max: 100 },
        },
        {
          field: 'multiplierNormal',
          code: 'INVALID_NUMBER',
          params: { min: 0.1, max: 100 },
        },
        {
          field: 'multiplierEmergency',
          code: 'INVALID_NUMBER',
          params: { min: 0.1, max: 100 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/specialties',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/maintenance/specialties',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { key: 'Pool!', nameAr: '', nameEn: 'Pool' },
      fields: [
        { field: 'key', code: 'INVALID_FORMAT' },
        {
          field: 'nameAr',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 80 },
        },
      ],
    },
  },
  {
    method: 'PATCH',
    path: '/maintenance/specialties/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bSpecialtyId }),
      body: () => ({ active: false }),
      code: 'SPECIALTY_NOT_FOUND',
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
  'en_route',
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
      body: {
        categoryId: 'x',
        priority: 'high',
        description: '',
        unitLocation: 'garage',
      },
      fields: [
        // ADR 0038.
        {
          field: 'unitLocation',
          code: 'INVALID_VALUE',
          params: { allowed: UNIT_LOCATIONS },
        },
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
  // ADR 0038.
  technicianAction('en-route'),
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
    path: '/maintenance/tickets/{id}/auto-assign',
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
    path: '/maintenance/tickets/{id}/dispatch-attempts',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: 'none',
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
    path: '/maintenance/tickets/{id}/sla-events',
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
    method: 'POST',
    path: '/maintenance/tickets/{id}/category',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: (w) => ({ categoryId: w.aCategoryId, reasonCode: 'misclassified' }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: {
      body: { categoryId: 'x' },
      fields: [{ field: 'categoryId', code: 'INVALID_UUID' }],
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
  {
    method: 'POST',
    path: '/maintenance/technicians/{id}/availability',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.b.ids.technician }),
      body: () => ({ state: 'unavailable', reasonCode: 'sick' }),
      code: 'TECHNICIAN_NOT_FOUND',
    },
    invalid: {
      body: { state: 'x' },
      fields: [
        {
          field: 'state',
          code: 'INVALID_VALUE',
          params: { allowed: ['available', 'unavailable'] },
        },
      ],
    },
  },
  {
    method: 'PUT',
    path: '/maintenance/technicians/{id}/specialties',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.b.ids.technician }),
      body: () => ({ specialtyIds: [] }),
      code: 'TECHNICIAN_NOT_FOUND',
    },
    invalid: {
      body: { specialtyIds: 'x' },
      fields: [{ field: 'specialtyIds', code: 'INVALID_TYPE' }],
    },
  },
];

/** A resident's verdict on another compound's ticket: just not found. */
const residentAction = (
  verb: string,
  body: object,
  invalid: Row['invalid'],
): Row => ({
  method: 'POST',
  path: `/tickets/{id}/${verb}`,
  auth: 'tenant',
  as: 'owner',
  denied: 'guard',
  foreign: {
    params: (w) => ({ id: w.bTicketId }),
    body: () => body,
    code: 'TICKET_NOT_FOUND',
  },
  invalid,
});

const REASON_TYPES: Row['invalid'] = {
  body: { reasonCode: 1, reason: 2 },
  fields: [
    { field: 'reasonCode', code: 'INVALID_TYPE' },
    { field: 'reason', code: 'INVALID_TYPE' },
  ],
};

/** Confirmation, rejection, reopen and cancel (ADR 0032). */
export const CONFIRMATION_ROUTES: Row[] = [
  residentAction(
    'cancel',
    { reasonCode: 'duplicate' },
    {
      body: { reasonCode: 1 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  ),
  residentAction(
    'confirm',
    { rating: 5 },
    {
      body: { rating: 6, technicianRating: 0, comment: '' },
      fields: [
        { field: 'rating', code: 'INVALID_NUMBER', params: { min: 1, max: 5 } },
        // ADR 0038.
        {
          field: 'technicianRating',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 5 },
        },
        {
          field: 'comment',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 1000 },
        },
      ],
    },
  ),
  residentAction(
    'reject',
    { reasonCode: 'not_fixed', reason: 'Still leaking' },
    REASON_TYPES,
  ),
  residentAction(
    'reopen',
    { reasonCode: 'problem_returned', reason: 'It is back' },
    REASON_TYPES,
  ),
  {
    method: 'POST',
    path: '/maintenance/tickets/{id}/cancel',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: () => ({ reasonCode: 'invalid' }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: ['x'] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
];

const BODY_LENGTH = {
  body: { body: '' },
  fields: [
    { field: 'body', code: 'INVALID_LENGTH', params: { min: 1, max: 2000 } },
  ],
};

/** A ticket's thread, per audience (ADR 0032). */
export const MESSAGE_ROUTES: Row[] = (
  [
    ['/tickets/{id}/messages', 'owner', 'guard'],
    ['/technician/tickets/{id}/messages', 'technician', 'manager'],
    ['/maintenance/tickets/{id}/messages', 'manager', 'technician'],
  ] as const
).flatMap(([path, as, denied]): Row[] => [
  {
    method: 'GET',
    path,
    auth: 'tenant',
    as,
    denied,
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path,
    auth: 'tenant',
    as,
    denied,
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: () => ({ body: 'Hello' }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: BODY_LENGTH,
  },
]);

/** The technician's own availability (ADR 0033). */
export const AVAILABILITY_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/technician/availability',
    auth: 'tenant',
    as: 'technician',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/technician/availability',
    auth: 'tenant',
    as: 'technician',
    denied: 'manager',
    foreign: 'none',
    invalid: {
      body: { state: 'x' },
      fields: [
        {
          field: 'state',
          code: 'INVALID_VALUE',
          params: { allowed: ['available', 'unavailable'] },
        },
      ],
    },
  },
];

// --- visits (ADR 0034) --------------------------------------------------------

/** A valid window: tomorrow, one hour (computed when the row runs). */
const visitWindow = () => ({
  startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  endsAt: new Date(Date.now() + 86_400_000 + 3_600_000).toISOString(),
});

const WINDOW_INVALID: Row['invalid'] = {
  body: { startsAt: 'tomorrow' },
  fields: [
    { field: 'startsAt', code: 'INVALID_FORMAT' },
    { field: 'endsAt', code: 'FIELD_REQUIRED' },
  ],
};

const RESCHEDULE_INVALID: Row['invalid'] = {
  body: { startsAt: 'tomorrow', reasonCode: 7 },
  // The subclass's own field first (class-validator's order).
  fields: [
    { field: 'reasonCode', code: 'INVALID_TYPE' },
    { field: 'startsAt', code: 'INVALID_FORMAT' },
    { field: 'endsAt', code: 'FIELD_REQUIRED' },
  ],
};

const CODE_INVALID: Row['invalid'] = {
  body: { reasonCode: 7 },
  fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
};

/** One action on a visit of another compound's ticket: just not found. */
const visitAction = (
  base: '/tickets' | '/technician/tickets' | '/maintenance/tickets',
  verb: string,
  invalid: Row['invalid'],
  body?: () => object,
): Row => ({
  method: 'POST',
  path: `${base}/{id}/visits/{visitId}/${verb}`,
  auth: 'tenant',
  as:
    base === '/tickets'
      ? 'owner'
      : base === '/technician/tickets'
        ? 'technician'
        : 'manager',
  denied: base === '/maintenance/tickets' ? 'technician' : 'guard',
  foreign: {
    params: (w) => ({ id: w.bTicketId, visitId: w.bVisitId }),
    ...(body ? { body } : {}),
    code: 'TICKET_NOT_FOUND',
  },
  invalid,
});

const rescheduleBody = () => ({
  ...visitWindow(),
  reasonCode: 'schedule_conflict',
});

/** Visits: the residents', the technician's and dispatch's routes. */
export const VISIT_ROUTES: Row[] = [
  // ADR 0038.
  {
    method: 'GET',
    path: '/tickets/{id}/visit-slots',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: {
      query: { days: '15', from: '11/10/2026' },
      fields: [
        {
          field: 'from',
          code: 'INVALID_FORMAT',
          params: { format: 'YYYY-MM-DD' },
        },
        { field: 'days', code: 'INVALID_NUMBER', params: { min: 1, max: 14 } },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/tickets/{id}/visits',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  visitAction('/tickets', 'confirm', 'none'),
  visitAction('/tickets', 'counter', WINDOW_INVALID, visitWindow),
  visitAction('/tickets', 'reschedule', RESCHEDULE_INVALID, rescheduleBody),
  visitAction('/tickets', 'cancel', CODE_INVALID, () => ({
    reasonCode: 'other',
  })),
  // ADR 0038.
  visitAction('/tickets', 'confirm-arrival', 'none'),
  visitAction('/tickets', 'absence-consent', 'none'),
  {
    ...visitAction('/tickets', 'absence-consent', 'none'),
    method: 'DELETE',
  },
  {
    ...visitAction(
      '/tickets',
      'receiver',
      {
        body: { accountId: 'x' },
        fields: [{ field: 'accountId', code: 'INVALID_UUID' }],
      },
      () => ({ accountId: '00000000-0000-7000-8000-000000000000' }),
    ),
    method: 'PUT',
  },
  { ...visitAction('/tickets', 'receiver', 'none'), method: 'DELETE' },
  {
    method: 'GET',
    path: '/technician/tickets/{id}/visits',
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
  {
    method: 'POST',
    path: '/technician/tickets/{id}/visits',
    auth: 'tenant',
    as: 'technician',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: visitWindow,
      code: 'TICKET_NOT_FOUND',
    },
    invalid: WINDOW_INVALID,
  },
  visitAction('/technician/tickets', 'confirm', 'none'),
  visitAction('/technician/tickets', 'counter', WINDOW_INVALID, visitWindow),
  visitAction(
    '/technician/tickets',
    'reschedule',
    RESCHEDULE_INVALID,
    rescheduleBody,
  ),
  visitAction('/technician/tickets', 'cancel', CODE_INVALID, () => ({
    reasonCode: 'other',
  })),
  { ...visitAction('/technician/tickets', 'arrive', 'none'), noStore: true },
  visitAction('/technician/tickets', 'done', 'none'),
  visitAction('/technician/tickets', 'no-access', 'none'),
  {
    method: 'GET',
    path: '/maintenance/tickets/{id}/visits',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/maintenance/tickets/{id}/visit-events',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/maintenance/tickets/{id}/visits',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: visitWindow,
      code: 'TICKET_NOT_FOUND',
    },
    invalid: WINDOW_INVALID,
  },
  visitAction('/maintenance/tickets', 'confirm', 'none'),
  visitAction('/maintenance/tickets', 'counter', WINDOW_INVALID, visitWindow),
  visitAction(
    '/maintenance/tickets',
    'reschedule',
    RESCHEDULE_INVALID,
    rescheduleBody,
  ),
  visitAction('/maintenance/tickets', 'cancel', CODE_INVALID, () => ({
    reasonCode: 'other',
  })),
  {
    method: 'GET',
    path: '/me/units/{unitId}/visits',
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

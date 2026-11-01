import type { Row } from '../registry';

const VALID_SCHEDULE = {
  days: [1],
  windows: [{ from: '06:00', to: '14:00' }],
};

/**
 * The field team (ADR 0078): the technicians' roster on the guards' one,
 * as the field team keeps it and as a technician reads their own. A
 * technician's row of the other compound is the guards' world row: either
 * way it is not found.
 */
export const DUTY_ROSTER_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/field-team/technicians',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/field-team/zones',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/field-team/roster/templates',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: {
        technicianId: 'tech-1',
        schedule: VALID_SCHEDULE,
        effectiveFrom: '2026-02-30',
        effectiveUntil: '2026-04-31',
      },
      fields: [
        { field: 'technicianId', code: 'INVALID_UUID' },
        { field: 'effectiveFrom', code: 'INVALID_FORMAT' },
        { field: 'effectiveUntil', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/field-team/roster/templates',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { state: 'open' },
      fields: [{ field: 'state', code: 'INVALID_VALUE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/field-team/roster/templates/{id}/end',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bRosterTemplateId }),
      code: 'ROSTER_TEMPLATE_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/field-team/roster/slots',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: {
        technicianId: 'tech-1',
        startsAt: '2027-02-29T09:00:00Z',
        endsAt: '2026-11-01T10:00:00Z',
      },
      fields: [
        { field: 'technicianId', code: 'INVALID_UUID' },
        { field: 'startsAt', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/field-team/roster/slots',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { from: '2027-02-29', to: '2026-13-01' },
      fields: [
        { field: 'from', code: 'INVALID_FORMAT' },
        { field: 'to', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/field-team/roster/slots/{id}/cancel',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bRosterSlotId }),
      body: () => ({ reasonCode: 'other' }),
      code: 'ROSTER_SLOT_NOT_FOUND',
    },
    invalid: {
      body: {},
      fields: [{ field: 'reasonCode', code: 'FIELD_REQUIRED' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/field-team/attendance',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { from: '2026-02-30', technicianId: 'tech-1' },
      fields: [
        { field: 'technicianId', code: 'INVALID_UUID' },
        { field: 'from', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/maintenance/my-roster',
    auth: 'tenant',
    as: 'technician',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { to: '2026-04-31' },
      fields: [{ field: 'to', code: 'INVALID_FORMAT' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/maintenance/my-roster/attendance',
    auth: 'tenant',
    as: 'technician',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { from: '2026-02-30' },
      fields: [{ field: 'from', code: 'INVALID_FORMAT' }],
    },
    noStore: true,
  },
];

/**
 * Instructions to the technicians (ADR 0078). The other compound's row is
 * the guards' world instruction: not found either way.
 */
export const TECHNICIAN_INSTRUCTION_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/staff/field-team/instructions',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: {
        title: '',
        body: 'Words',
        validFrom: '2026-02-30',
        validUntil: '2027-02-29',
      },
      fields: [
        {
          field: 'title',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 120 },
        },
        { field: 'validFrom', code: 'INVALID_FORMAT' },
        { field: 'validUntil', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/field-team/instructions',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { state: 'old' },
      fields: [{ field: 'state', code: 'INVALID_VALUE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/field-team/instructions/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bInstructionId }),
      code: 'GUARD_INSTRUCTION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/field-team/instructions/{id}/archive',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bInstructionId }),
      code: 'GUARD_INSTRUCTION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/maintenance/instructions',
    auth: 'tenant',
    as: 'technician',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { status: 'unread' },
      fields: [{ field: 'status', code: 'INVALID_VALUE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/maintenance/instructions/{id}',
    auth: 'tenant',
    as: 'technician',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bInstructionId }),
      code: 'GUARD_INSTRUCTION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/maintenance/instructions/{id}/acknowledge',
    auth: 'tenant',
    as: 'technician',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bInstructionId }),
      code: 'GUARD_INSTRUCTION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
];

import type { Row } from '../registry';

/** The compound's permit rules (ADR 0049). */
export const PERMIT_SETTINGS_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/community/permit-rules',
    auth: 'tenant',
    as: 'owner',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/permit-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/staff/permit-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { workDays: [], workHours: { from: '9', to: '17:00' } },
      fields: [
        {
          field: 'workDays',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 7 },
        },
        { field: 'workHours.from', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
];

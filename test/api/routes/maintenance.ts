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

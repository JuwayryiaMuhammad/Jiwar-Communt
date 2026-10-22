import { PARTNER_CATEGORIES } from '../../../src/partners/categories';
import type { Row } from '../registry';

/**
 * Partners (ADR 0060): the catalogue residents find partners in, their
 * favourites, and the staff's set-up. Every response of the phase is
 * no-store.
 */
export const PARTNER_CATALOGUE_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/partner-categories',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/partners',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { openNow: 'yes' },
      fields: [
        {
          field: 'openNow',
          code: 'INVALID_VALUE',
          params: { allowed: ['true', 'false'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/partners/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPartnerId }),
      code: 'PARTNER_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PUT',
    path: '/partners/{id}/favourite',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPartnerId }),
      code: 'PARTNER_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'DELETE',
    path: '/partners/{id}/favourite',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPartnerId }),
      code: 'PARTNER_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/partners',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/partners/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPartnerId }),
      code: 'PARTNER_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/partners',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: {
        nameEn: 'Cleaners',
        nameAr: 'منظفون',
        businessPhone: 'call us',
        services: [{ category: 'home_services' }],
      },
      fields: [{ field: 'businessPhone', code: 'INVALID_PHONE' }],
    },
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/staff/partners/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bPartnerId }),
      code: 'PARTNER_NOT_FOUND',
      body: () => ({ homeVisit: true }),
    },
    invalid: {
      body: { homeVisit: 'yes' },
      fields: [{ field: 'homeVisit', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'PUT',
    path: '/staff/partners/{id}/services',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPartnerId }),
      code: 'PARTNER_NOT_FOUND',
      body: () => ({ services: [{ category: 'pets' }] }),
    },
    invalid: {
      body: { services: [{ category: 'taxi' }] },
      fields: [
        {
          field: 'services.0.category',
          code: 'INVALID_VALUE',
          params: { allowed: [...PARTNER_CATEGORIES] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'PUT',
    path: '/staff/partners/{id}/hours',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPartnerId }),
      code: 'PARTNER_NOT_FOUND',
      body: () => ({
        windows: [{ weekday: 1, startMinute: 540, endMinute: 1020 }],
      }),
    },
    invalid: {
      body: { windows: [{ weekday: 7, startMinute: 540, endMinute: 1020 }] },
      fields: [
        {
          field: 'windows.0.weekday',
          code: 'INVALID_NUMBER',
          params: { min: 0, max: 6 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'PUT',
    path: '/staff/partners/{id}/prices',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPartnerId }),
      code: 'PARTNER_NOT_FOUND',
      body: () => ({
        items: [
          { nameEn: 'Visit', nameAr: 'زيارة', price: '150', unit: 'visit_fee' },
        ],
      }),
    },
    invalid: {
      body: {
        items: [
          { nameEn: 'Visit', nameAr: 'زيارة', price: '-1', unit: 'visit_fee' },
        ],
      },
      fields: [{ field: 'items.0.price', code: 'INVALID_FORMAT' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/partner-subcategories',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/partner-subcategories',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: {
        category: 'home_services',
        key: 'Window Cleaning',
        nameEn: 'Windows',
        nameAr: 'نوافذ',
      },
      fields: [{ field: 'key', code: 'INVALID_FORMAT' }],
    },
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/staff/partner-subcategories/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bSubcategoryId }),
      code: 'PARTNER_SUBCATEGORY_NOT_FOUND',
      body: () => ({ position: 3 }),
    },
    invalid: {
      body: { position: 1001 },
      fields: [
        {
          field: 'position',
          code: 'INVALID_NUMBER',
          params: { min: 0, max: 1000 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/partner-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/staff/partner-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { deskLinkDays: 3 },
      fields: [
        {
          field: 'deskLinkDays',
          code: 'INVALID_NUMBER',
          params: { min: 7, max: 365 },
        },
      ],
    },
    noStore: true,
  },
];

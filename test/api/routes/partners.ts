import { newId } from '../../../src/core/common/uuid';
import { PARTNER_CATEGORIES } from '../../../src/partners/categories';
import { at, day } from '../../setup/compound-clock';
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

const WINDOW = () => {
  // Two days ahead, 10:00–12:00 in the compound: always 15 minutes to 14
  // days ahead.
  const start = at(day(2), 10);
  return {
    windowStartsAt: start.toISOString(),
    windowEndsAt: at(day(2), 12).toISOString(),
  };
};

/**
 * A resident's requests to partners, the management's relay and the desk
 * links (ADR 0060).
 */
export const PARTNER_REQUEST_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/partner-requests',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: {
        partnerId: newId(),
        unitId: newId(),
        category: 'taxi',
        ...WINDOW(),
      },
      fields: [
        {
          field: 'category',
          code: 'INVALID_VALUE',
          params: {
            allowed: [
              'gas_water',
              'pharmacy',
              'grocery',
              'home_services',
              'laundry',
              'gardening',
              'beauty_at_home',
              'repair',
              'pets',
              'events',
              'moving_storage',
              'car_services',
              'elderly_care',
            ],
          },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/partner-requests',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { state: 'open' },
      fields: [
        {
          field: 'state',
          code: 'INVALID_VALUE',
          params: { allowed: ['live', 'closed'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/partner-requests/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPartnerRequestId }),
      code: 'PARTNER_REQUEST_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/partner-requests/{id}/cancel',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPartnerRequestId }),
      code: 'PARTNER_REQUEST_NOT_FOUND',
      body: () => ({ reasonCode: 'no_longer_needed' }),
    },
    invalid: {
      body: { reasonCode: 7 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  ...(['accept-proposal', 'decline-proposal', 'done', 'no-show'] as const).map(
    (verb): Row => ({
      method: 'POST',
      path: `/partner-requests/{id}/${verb}`,
      auth: 'tenant',
      as: 'owner',
      denied: 'guard',
      foreign: {
        params: (w) => ({ id: w.bPartnerRequestId }),
        code: 'PARTNER_REQUEST_NOT_FOUND',
      },
      // No body: nothing to validate.
      invalid: 'none',
      noStore: true,
    }),
  ),
  {
    method: 'GET',
    path: '/staff/partner-requests',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'open' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: {
            allowed: [
              'pending',
              'proposed',
              'accepted',
              'declined',
              'cancelled',
              'expired',
              'done',
              'partner_no_show',
              'lapsed',
            ],
          },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/partner-requests/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPartnerRequestId }),
      code: 'PARTNER_REQUEST_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/partner-requests/{id}/accept',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bPartnerRequestId }),
      code: 'PARTNER_REQUEST_NOT_FOUND',
      body: () => ({ staffCount: 2 }),
    },
    invalid: {
      body: { staffCount: 6 },
      fields: [
        {
          field: 'staffCount',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 5 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/partner-requests/{id}/decline',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPartnerRequestId }),
      code: 'PARTNER_REQUEST_NOT_FOUND',
      body: () => ({ reasonCode: 'unavailable' }),
    },
    invalid: {
      body: { reasonCode: 7 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/partner-requests/{id}/propose',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPartnerRequestId }),
      code: 'PARTNER_REQUEST_NOT_FOUND',
      body: () => WINDOW(),
    },
    invalid: {
      body: { windowStartsAt: 'soon', windowEndsAt: WINDOW().windowEndsAt },
      fields: [{ field: 'windowStartsAt', code: 'INVALID_FORMAT' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/partner-requests/{id}/done',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPartnerRequestId }),
      code: 'PARTNER_REQUEST_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/partner-requests/{id}/cancel',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPartnerRequestId }),
      code: 'PARTNER_REQUEST_NOT_FOUND',
      body: () => ({ reasonCode: 'emergency' }),
    },
    invalid: {
      body: { reasonCode: ['emergency'] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/partners/{id}/desk-link',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bPartnerId }),
      code: 'PARTNER_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/partners/{id}/desk-link/revoke',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPartnerId }),
      code: 'PARTNER_NOT_FOUND',
    },
    invalid: 'none',
  },
];

/** The partner's desk (ADR 0060): public, the link's token in the body. */
export const PARTNER_DESK_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/public/partner-desk/lookup',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    noStore: true,
    invalid: {
      body: { token: 5, partnerId: 'x' },
      fields: [
        { field: 'partnerId', code: 'FIELD_NOT_ALLOWED' },
        { field: 'token', code: 'INVALID_TYPE' },
      ],
    },
  },
  ...(
    [
      ['accept', { staffCount: 1 }],
      ['decline', { reasonCode: 'unavailable' }],
      ['propose', WINDOW()],
      ['done', {}],
      ['cancel', { reasonCode: 'emergency' }],
    ] as const
  ).map(([verb, body]): Row => ({
    method: 'POST',
    path: `/public/partner-desk/requests/{id}/${verb}`,
    auth: 'public',
    denied: 'none',
    foreign: {
      params: (w) => ({ id: w.bPartnerRequestId }),
      code: 'PARTNER_REQUEST_NOT_FOUND',
      body: (w) => ({ token: w.aDeskToken, ...body }),
    },
    noStore: true,
    invalid: {
      body: { ...body, token: 5 },
      fields: [{ field: 'token', code: 'INVALID_TYPE' }],
    },
  })),
];

/** Ratings and complaints (ADR 0060). */
export const PARTNER_FEEDBACK_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/partner-requests/{id}/rating',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPartnerRequestId }),
      code: 'PARTNER_REQUEST_NOT_FOUND',
      body: () => ({ stars: 4 }),
    },
    invalid: {
      body: { stars: 6 },
      fields: [
        { field: 'stars', code: 'INVALID_NUMBER', params: { min: 1, max: 5 } },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/partner-requests/{id}/complaint',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPartnerRequestId }),
      code: 'PARTNER_REQUEST_NOT_FOUND',
      body: () => ({
        reason: 'late',
        compensationAsk: 'none',
        message: 'They came two hours late.',
      }),
    },
    invalid: {
      body: { reason: 'late', compensationAsk: 'none', message: '' },
      fields: [
        {
          field: 'message',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 4000 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/partner-complaints',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { decided: 'yes' },
      fields: [
        {
          field: 'decided',
          code: 'INVALID_VALUE',
          params: { allowed: ['true', 'false'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/partner-complaints/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bComplaintIdOfPartner }),
      code: 'PARTNER_COMPLAINT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/partner-complaints/{id}/decide',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bComplaintIdOfPartner }),
      code: 'PARTNER_COMPLAINT_NOT_FOUND',
      body: () => ({ outcome: 'upheld', compensation: 'redo' }),
    },
    invalid: {
      body: { outcome: 'maybe', compensation: 'none' },
      fields: [
        {
          field: 'outcome',
          code: 'INVALID_VALUE',
          params: { allowed: ['upheld', 'not_upheld'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/partner-ratings',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { partnerId: 'x' },
      fields: [{ field: 'partnerId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
];

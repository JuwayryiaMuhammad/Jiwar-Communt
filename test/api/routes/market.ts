import type { Row } from '../registry';

const LISTING_404 = 'MARKET_LISTING_NOT_FOUND';

/**
 * The market (ADR 0071): the residents' listings, their own, the handlers'
 * review and the settings. Every response is no-store.
 */
export const MARKET_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/market/listings',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: {
        kind: 'auction',
        category: 'furniture',
        title: 'ab',
        body: 'A table',
        price: '-5',
      },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: {
            allowed: [
              'sell',
              'give',
              'wanted',
              'service',
              'unit_sale',
              'unit_rent',
            ],
          },
        },
        {
          field: 'title',
          code: 'INVALID_LENGTH',
          params: { min: 3, max: 80 },
        },
        { field: 'price', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/market/listings',
    auth: 'tenant',
    as: 'family',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { sort: 'cheapest' },
      fields: [
        {
          field: 'sort',
          code: 'INVALID_VALUE',
          params: { allowed: ['newest', 'price_asc', 'price_desc'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/market/listings/{id}',
    auth: 'tenant',
    as: 'tenant',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bListingId }),
      code: LISTING_404,
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/market/listings/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bListingId }),
      body: () => ({ negotiable: true }),
      code: LISTING_404,
    },
    invalid: {
      body: { negotiable: 'yes' },
      fields: [{ field: 'negotiable', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/market/listings/{id}/withdraw',
    auth: 'tenant',
    as: 'owner',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bListingId }),
      code: LISTING_404,
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/market/listings/{id}/sold',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bListingId }),
      code: LISTING_404,
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/me/market/listings',
    auth: 'tenant',
    as: 'landlord',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/market/review',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'live' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['pending_review', 'under_review'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/market/review/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'family',
    foreign: {
      params: (w) => ({ id: w.bListingId }),
      code: LISTING_404,
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/market/review/{id}/approve',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bListingId }),
      code: LISTING_404,
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/market/review/{id}/reject',
    auth: 'tenant',
    as: 'manager',
    denied: 'tenant',
    foreign: {
      params: (w) => ({ id: w.bListingId }),
      body: () => ({ reasonCode: 'duplicate' }),
      code: LISTING_404,
    },
    invalid: {
      body: { reasonCode: 5 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/market/review/{id}/remove',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bListingId }),
      body: () => ({ reasonCode: 'scam' }),
      code: LISTING_404,
    },
    invalid: {
      body: { reasonCode: 7 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/market/settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/market/settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { expiryDays: 0, requiresReview: 'no' },
      fields: [
        { field: 'requiresReview', code: 'INVALID_TYPE' },
        {
          field: 'expiryDays',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 180 },
        },
      ],
    },
    noStore: true,
  },
];

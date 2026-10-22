import type { Row } from '../registry';

/** The resident's lists across the domains (ADR 0058). */
export const RESIDENT_ITEM_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/me/appeals',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: 'none',
    invalid: {
      query: { state: 'done' },
      fields: [
        {
          field: 'state',
          code: 'INVALID_VALUE',
          params: { allowed: ['open', 'closed'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/me/search',
    auth: 'tenant',
    as: 'owner',
    // The account kind is judged after `q` is validated; the staff's 403 is
    // in test/resident-items/resident-items.e2e-spec.ts.
    denied: 'none',
    foreign: 'none',
    invalid: {
      query: { q: 'x' },
      fields: [
        { field: 'q', code: 'INVALID_LENGTH', params: { min: 2, max: 64 } },
      ],
    },
    noStore: true,
  },
];

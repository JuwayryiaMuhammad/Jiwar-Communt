import type { Row } from '../registry';

const PERIODS = { min: 1, max: 26 };
const badQuery = {
  query: { by: 'day', periods: '0' },
  fields: [
    {
      field: 'by',
      code: 'INVALID_VALUE',
      params: { allowed: ['week', 'month'] },
    },
    { field: 'periods', code: 'INVALID_NUMBER', params: PERIODS },
  ],
};

/**
 * Cash flow and liquidity (ADR 0091): the forecast and its CSV, read with
 * `finance.cashflow`; the compound's minimum cash, set with
 * `finance.treasury`. Every response no-store: balances.
 */
export const CASH_FLOW_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/finance/cash-flow',
    noStore: true,
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: badQuery,
  },
  {
    method: 'GET',
    path: '/staff/finance/cash-flow/export',
    noStore: true,
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: badQuery,
  },
  {
    method: 'GET',
    path: '/staff/finance/cash-flow/settings',
    noStore: true,
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/staff/finance/cash-flow/settings',
    noStore: true,
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { minimumCash: '12.345' },
      fields: [{ field: 'minimumCash', code: 'INVALID_FORMAT' }],
    },
  },
];

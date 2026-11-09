import { day } from '../../setup/compound-clock';
import type { Row } from '../registry';

/** Read with `finance.ledger`, which a technician never holds. */
const reader = (row: Omit<Row, 'auth' | 'as' | 'denied'>): Row => ({
  auth: 'tenant',
  as: 'manager',
  denied: 'technician',
  noStore: true,
  ...row,
});
const badDay = {
  query: { asOf: '2026-02-30' },
  fields: [{ field: 'asOf', code: 'INVALID_FORMAT' }],
};
const badPeriod = {
  query: { from: '2026-02-30', to: '2026-13-01' },
  fields: [
    { field: 'from', code: 'INVALID_FORMAT' },
    { field: 'to', code: 'INVALID_FORMAT' },
  ],
};
const period = () => ({ from: day(0), to: day(0) });
const badMonth = {
  body: { month: '2026-13' },
  fields: [{ field: 'month', code: 'INVALID_FORMAT' }],
};

/**
 * The general ledger (ADR 0092): the chart, an account's ledger, the
 * statements, the journal and its export, the reconciliation, manual
 * entries and the months. Every response no-store: the compound's books.
 * Reopening a month is the manager's alone (`finance.ledger_reopen`).
 */
export const GL_ROUTES: Row[] = [
  reader({
    method: 'GET',
    path: '/staff/finance/gl/accounts',
    foreign: 'none',
    invalid: badDay,
  }),
  reader({
    method: 'POST',
    path: '/staff/finance/gl/accounts',
    foreign: {
      params: () => ({}),
      body: (w) => ({
        parentId: w.bGlAccountId,
        code: '1900.01',
        nameEn: 'Foreign',
        nameAr: 'أجنبي',
      }),
      code: 'GL_ACCOUNT_NOT_FOUND',
    },
    invalid: {
      body: {
        parentId: '00000000-0000-4000-8000-000000000092',
        code: '12',
        nameEn: 'A',
        nameAr: 'أ',
      },
      fields: [{ field: 'code', code: 'INVALID_FORMAT' }],
    },
  }),
  reader({
    method: 'GET',
    path: '/staff/finance/gl/accounts/{id}',
    foreign: {
      params: (w) => ({ id: w.bGlAccountId }),
      code: 'GL_ACCOUNT_NOT_FOUND',
    },
    invalid: 'none',
  }),
  reader({
    method: 'PATCH',
    path: '/staff/finance/gl/accounts/{id}',
    foreign: {
      params: (w) => ({ id: w.bGlAccountId }),
      body: () => ({ nameEn: 'Renamed' }),
      code: 'GL_ACCOUNT_NOT_FOUND',
    },
    invalid: {
      body: { nameEn: '' },
      fields: [
        {
          field: 'nameEn',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 100 },
        },
      ],
    },
  }),
  reader({
    method: 'DELETE',
    path: '/staff/finance/gl/accounts/{id}',
    foreign: {
      params: (w) => ({ id: w.bGlAccountId }),
      code: 'GL_ACCOUNT_NOT_FOUND',
    },
    invalid: 'none',
  }),
  reader({
    method: 'GET',
    path: '/staff/finance/gl/accounts/{id}/ledger',
    foreign: {
      params: (w) => ({ id: w.bGlAccountId }),
      query: period(),
      code: 'GL_ACCOUNT_NOT_FOUND',
    },
    invalid: badPeriod,
  }),
  reader({
    method: 'GET',
    path: '/staff/finance/gl/accounts/{id}/ledger/export',
    foreign: {
      params: (w) => ({ id: w.bGlAccountId }),
      query: period(),
      code: 'GL_ACCOUNT_NOT_FOUND',
    },
    invalid: badPeriod,
  }),
  reader({
    method: 'GET',
    path: '/staff/finance/gl/trial-balance',
    foreign: 'none',
    invalid: badDay,
  }),
  reader({
    method: 'GET',
    path: '/staff/finance/gl/income-statement',
    foreign: 'none',
    invalid: badPeriod,
  }),
  reader({
    method: 'GET',
    path: '/staff/finance/gl/balance-sheet',
    foreign: 'none',
    invalid: badDay,
  }),
  reader({
    method: 'GET',
    path: '/staff/finance/gl/reconciliation',
    foreign: 'none',
    invalid: 'none',
  }),
  reader({
    method: 'GET',
    path: '/staff/finance/gl/entries',
    foreign: 'none',
    invalid: badPeriod,
  }),
  reader({
    method: 'GET',
    path: '/staff/finance/gl/entries/{id}',
    foreign: {
      params: (w) => ({ id: w.bGlEntryId }),
      code: 'GL_ENTRY_NOT_FOUND',
    },
    invalid: 'none',
  }),
  reader({
    method: 'POST',
    path: '/staff/finance/gl/entries/{id}/reverse',
    foreign: {
      params: (w) => ({ id: w.bGlEntryId }),
      body: () => ({ postedOn: day(0), memo: 'Reversed' }),
      code: 'GL_ENTRY_NOT_FOUND',
    },
    invalid: {
      body: { postedOn: '2026-02-30', memo: 'Reversed' },
      fields: [{ field: 'postedOn', code: 'INVALID_FORMAT' }],
    },
  }),
  reader({
    method: 'GET',
    path: '/staff/finance/gl/journal/export',
    foreign: 'none',
    invalid: badPeriod,
  }),
  reader({
    method: 'GET',
    path: '/staff/finance/gl/manual-entries',
    foreign: 'none',
    invalid: {
      query: { status: 'posted' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['pending', 'approved', 'rejected', 'withdrawn'] },
        },
      ],
    },
  }),
  reader({
    method: 'POST',
    path: '/staff/finance/gl/manual-entries',
    foreign: {
      params: () => ({}),
      body: (w) => ({
        postedOn: day(0),
        memo: 'Foreign',
        lines: [
          { accountId: w.bGlAccountId, debit: '1' },
          { accountId: w.bGlAccountId, credit: '1' },
        ],
      }),
      code: 'GL_ACCOUNT_NOT_FOUND',
    },
    invalid: {
      body: { postedOn: '2026-02-30', memo: 'x', lines: [] },
      fields: [
        { field: 'postedOn', code: 'INVALID_FORMAT' },
        { field: 'lines', code: 'INVALID_LENGTH', params: { min: 2, max: 50 } },
      ],
    },
  }),
  reader({
    method: 'GET',
    path: '/staff/finance/gl/manual-entries/{id}',
    foreign: {
      params: (w) => ({ id: w.bGlManualEntryId }),
      code: 'GL_MANUAL_ENTRY_NOT_FOUND',
    },
    invalid: 'none',
  }),
  ...(['approve', 'withdraw'] as const).map((action) =>
    reader({
      method: 'POST',
      path: `/staff/finance/gl/manual-entries/{id}/${action}`,
      foreign: {
        params: (w) => ({ id: w.bGlManualEntryId }),
        code: 'GL_MANUAL_ENTRY_NOT_FOUND',
      },
      invalid: 'none',
    }),
  ),
  reader({
    method: 'POST',
    path: '/staff/finance/gl/manual-entries/{id}/reject',
    foreign: {
      params: (w) => ({ id: w.bGlManualEntryId }),
      body: () => ({ reasonCode: 'not_needed' }),
      code: 'GL_MANUAL_ENTRY_NOT_FOUND',
    },
    invalid: 'none',
  }),
  reader({
    method: 'GET',
    path: '/staff/finance/gl/periods',
    foreign: 'none',
    invalid: 'none',
  }),
  reader({
    method: 'POST',
    path: '/staff/finance/gl/periods/close',
    foreign: 'none',
    invalid: badMonth,
  }),
  reader({
    method: 'POST',
    path: '/staff/finance/gl/periods/reopen',
    foreign: 'none',
    invalid: {
      ...badMonth,
      body: { ...badMonth.body, reasonCode: 'correction' },
    },
  }),
];

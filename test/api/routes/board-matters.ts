import type { Row } from '../registry';

const pageInvalid = {
  query: { limit: '0' },
  fields: [
    { field: 'limit', code: 'INVALID_NUMBER', params: { min: 1, max: 100 } },
  ],
};

const APPROVAL_TYPES = [
  'annual_budget',
  'budget_increase',
  'major_contract',
  'exceptional_fee',
  'waiver_above_limit',
  'payment_plan_above_limit',
  'legal_escalation',
];

/** Approval requests, the staff's side (ADR 0055). */
export const STAFF_APPROVAL_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/staff/governance/approvals',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { type: 'king', context: 'c', impact: 'i' },
      fields: [
        {
          field: 'type',
          code: 'INVALID_VALUE',
          params: { allowed: APPROVAL_TYPES },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/governance/approvals',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: pageInvalid,
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/governance/approvals/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bApprovalId }),
      code: 'APPROVAL_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/governance/approvals/{id}/withdraw',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bApprovalId }),
      body: () => ({ reasonCode: 'other' }),
      code: 'APPROVAL_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 7 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/governance/approvals/{id}/implemented',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bApprovalId }),
      body: () => ({}),
      code: 'APPROVAL_NOT_FOUND',
    },
    invalid: {
      body: { note: '' },
      fields: [
        {
          field: 'note',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 1000 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/governance/settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/staff/governance/settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { items: [{ type: 'king' }] },
      fields: [
        {
          field: 'items.0.type',
          code: 'INVALID_VALUE',
          params: { allowed: [...APPROVAL_TYPES, 'board_appeal'] },
        },
      ],
    },
    noStore: true,
  },
];

/** The board's requests and motions (ADR 0055): A's landlord sits on A's board. */
export const BOARD_APPROVAL_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/board/approvals',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: 'none',
    invalid: pageInvalid,
    noStore: true,
  },
  {
    method: 'GET',
    path: '/board/approvals/{id}',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bApprovalId }),
      code: 'APPROVAL_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/board/approvals/{id}/motions',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bApprovalId }),
      body: () => ({ outcome: 'approve', rationale: 'Sound.' }),
      code: 'APPROVAL_NOT_FOUND',
    },
    invalid: {
      body: { outcome: 'maybe', rationale: 'Sound.' },
      fields: [
        {
          field: 'outcome',
          code: 'INVALID_VALUE',
          params: { allowed: ['approve', 'reject'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/board/motions/{id}/votes',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bBoardMotionId }),
      body: () => ({ choice: 'for' }),
      code: 'BOARD_MOTION_NOT_FOUND',
    },
    invalid: {
      body: { choice: 'maybe' },
      fields: [
        {
          field: 'choice',
          code: 'INVALID_VALUE',
          params: { allowed: ['for', 'against'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/board/motions/{id}/close',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bBoardMotionId }),
      code: 'BOARD_MOTION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/board/motions/{id}/withdraw',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bBoardMotionId }),
      code: 'BOARD_MOTION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
];

const BUDGET_CATEGORIES = [
  'security',
  'cleaning',
  'landscaping',
  'maintenance',
  'utilities',
  'staff',
  'insurance',
  'administration',
  'reserve_fund',
  'other',
];

/** The budget and expenses (ADR 0055): finance.budget's. */
export const BUDGET_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/finance/budget-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/staff/finance/budget-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { fiscalYearStartMonth: 13 },
      fields: [
        {
          field: 'fiscalYearStartMonth',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 12 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/finance/budgets',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { fiscalYear: 2027, copyFromId: 'x' },
      fields: [{ field: 'copyFromId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/finance/budgets',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: pageInvalid,
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/finance/budgets/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bBudgetId }),
      code: 'BUDGET_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PUT',
    path: '/staff/finance/budgets/{id}/lines',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bBudgetId }),
      body: () => ({ lines: [] }),
      code: 'BUDGET_NOT_FOUND',
    },
    invalid: {
      body: { lines: [{ category: 'king', amount: '1.00' }] },
      fields: [
        {
          field: 'lines.0.category',
          code: 'INVALID_VALUE',
          params: { allowed: BUDGET_CATEGORIES },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/finance/expenses',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: {
        budgetLineId: 'x',
        vendor: 'v',
        amount: '1.00',
        spentOn: '2027-01-01',
        invoiceFileId: '0193b8a4-0000-7000-8000-000000000000',
      },
      fields: [{ field: 'budgetLineId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/finance/expenses',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: pageInvalid,
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/finance/expenses/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bExpenseId }),
      code: 'EXPENSE_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/finance/expenses/{id}/void',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bExpenseId }),
      body: () => ({ reasonCode: 'other' }),
      code: 'EXPENSE_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 7 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/finance/expense-authorizations',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
];

/** Budget vs actual (ADR 0055): finance.reports. */
export const BUDGET_REPORT_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/finance/reports/budget-vs-actual',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { budgetId: 'x' },
      fields: [{ field: 'budgetId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/finance/reports/budget-vs-actual/export',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { budgetId: 'x' },
      fields: [{ field: 'budgetId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
];

const APPEAL_KINDS = [
  'vehicle_fine',
  'unit_violation',
  'booking_suspension',
  'invoice_dispute',
];
const APPEAL_STATUSES = ['pending', 'upheld', 'overturned', 'withdrawn'];

/** Appeals to the board (ADR 0055): the owners', the management's, the board's. */
export const BOARD_APPEAL_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/governance/board-appeals',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: {
        kind: 'king',
        subjectId: '0193b8a4-0000-7000-8000-000000000000',
        grounds: 'g',
      },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: APPEAL_KINDS },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/governance/board-appeals',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: pageInvalid,
    noStore: true,
  },
  {
    method: 'GET',
    path: '/governance/board-appeals/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bBoardAppealId }),
      code: 'BOARD_APPEAL_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/governance/board-appeals/{id}/withdraw',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bBoardAppealId }),
      code: 'BOARD_APPEAL_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/governance/board-appeals',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'king' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: APPEAL_STATUSES },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/governance/board-appeals/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bBoardAppealId }),
      code: 'BOARD_APPEAL_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/governance/board-appeals/{id}/followed-up',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bBoardAppealId }),
      code: 'BOARD_APPEAL_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/board/appeals',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: 'none',
    invalid: pageInvalid,
    noStore: true,
  },
  {
    method: 'GET',
    path: '/board/appeals/{id}',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bBoardAppealId }),
      code: 'BOARD_APPEAL_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/board/appeals/{id}/motions',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bBoardAppealId }),
      body: () => ({ outcome: 'uphold', rationale: 'Sound.' }),
      code: 'BOARD_APPEAL_NOT_FOUND',
    },
    invalid: {
      body: { outcome: 'approve', rationale: 'Sound.' },
      fields: [
        {
          field: 'outcome',
          code: 'INVALID_VALUE',
          params: { allowed: ['uphold', 'overturn'] },
        },
      ],
    },
    noStore: true,
  },
];

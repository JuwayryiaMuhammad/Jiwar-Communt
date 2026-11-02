import { newId } from '../../../src/core/common/uuid';
import { day } from '../../setup/compound-clock';
import type { Row } from '../registry';

const LIMIT = { min: 1, max: 100 };
const reason = (field = 'reasonCode') => [{ field, code: 'INVALID_TYPE' }];

/**
 * Treasury and custody (ADR 0085): the bank and cash accounts, their
 * movements, transfers and adjustments; bank statements imported and
 * matched; custody hand-ins and their investigations; the collector's own
 * custody; the cheque register.
 */
export const TREASURY_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/finance/cash-accounts',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { includeRetired: 'yes' },
      fields: [
        {
          field: 'includeRetired',
          code: 'INVALID_VALUE',
          params: { allowed: ['true', 'false'] },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/staff/finance/cash-accounts',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { kind: 'safe', name: '', openedOn: '2026-02-30' },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: ['bank', 'cash'] },
        },
        { field: 'name', code: 'INVALID_LENGTH', params: { min: 1, max: 100 } },
        { field: 'openedOn', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/finance/cash-accounts/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bCashAccountId }),
      code: 'CASH_ACCOUNT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/staff/finance/cash-accounts/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bCashAccountId }),
      body: () => ({ name: 'Renamed' }),
      code: 'CASH_ACCOUNT_NOT_FOUND',
    },
    invalid: {
      body: { numberLast4: '12a4' },
      fields: [{ field: 'numberLast4', code: 'INVALID_FORMAT' }],
    },
  },
  {
    method: 'POST',
    path: '/staff/finance/cash-accounts/{id}/retire',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bCashAccountId }),
      code: 'CASH_ACCOUNT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/finance/cash-accounts/{id}/adjustments',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bCashAccountId }),
      body: () => ({ amount: '1', reasonCode: 'other', onDay: day(0) }),
      code: 'CASH_ACCOUNT_NOT_FOUND',
    },
    invalid: {
      body: { amount: '1.234', reasonCode: 7, onDay: '2026-02-30' },
      fields: [
        { field: 'amount', code: 'INVALID_FORMAT' },
        { field: 'reasonCode', code: 'INVALID_TYPE' },
        { field: 'onDay', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/finance/cash-movements',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { accountId: 'x', from: '2026-02-30', limit: '0' },
      fields: [
        { field: 'accountId', code: 'INVALID_UUID' },
        { field: 'from', code: 'INVALID_FORMAT' },
        { field: 'limit', code: 'INVALID_NUMBER', params: LIMIT },
      ],
    },
  },
  {
    method: 'POST',
    path: '/staff/finance/cash-transfers',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: () => ({}),
      body: (w) => ({
        fromAccountId: w.bCashAccountId,
        toAccountId: newId(),
        amount: '1',
        onDay: day(0),
      }),
      code: 'CASH_ACCOUNT_NOT_FOUND',
    },
    invalid: {
      body: {
        fromAccountId: 'x',
        toAccountId: 'y',
        amount: '0',
        onDay: '2026-02-30',
      },
      fields: [
        { field: 'fromAccountId', code: 'INVALID_UUID' },
        { field: 'toAccountId', code: 'INVALID_UUID' },
        { field: 'amount', code: 'INVALID_FORMAT' },
        { field: 'onDay', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'POST',
    path: '/staff/finance/cash-accounts/{id}/statement-imports',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bCashAccountId }),
      body: () => ({ fileId: newId() }),
      code: 'CASH_ACCOUNT_NOT_FOUND',
    },
    invalid: {
      body: { fileId: 'x' },
      fields: [{ field: 'fileId', code: 'INVALID_UUID' }],
    },
  },
  {
    method: 'GET',
    path: '/staff/finance/statement-imports',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { accountId: 'x' },
      fields: [{ field: 'accountId', code: 'INVALID_UUID' }],
    },
  },
  {
    method: 'GET',
    path: '/staff/finance/statement-imports/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bStatementImportId }),
      code: 'STATEMENT_IMPORT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/finance/statement-imports/{id}/apply',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bStatementImportId }),
      code: 'STATEMENT_IMPORT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/finance/statement-lines',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { status: 'open' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['matched', 'unmatched'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/finance/statement-lines/{id}/candidates',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bStatementLineId }),
      code: 'STATEMENT_LINE_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/finance/statement-lines/{id}/match',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bStatementLineId }),
      body: () => ({ kind: 'adjustment', reasonCode: 'bank_charge' }),
      code: 'STATEMENT_LINE_NOT_FOUND',
    },
    invalid: {
      body: { kind: 'x', targetId: 'y' },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: ['payment', 'cheque', 'transfer', 'adjustment'] },
        },
        { field: 'targetId', code: 'INVALID_UUID' },
      ],
    },
  },
  {
    method: 'POST',
    path: '/staff/finance/statement-matches/{id}/undo',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bStatementMatchId }),
      code: 'STATEMENT_MATCH_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/finance/custody',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/finance/custody/{accountId}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ accountId: w.bCustodianId }),
      code: 'CUSTODIAN_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/finance/custody/{accountId}/handins',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ accountId: w.bCustodianId }),
      body: () => ({ cashAccountId: newId(), expected: '1', counted: '1' }),
      code: 'CUSTODIAN_NOT_FOUND',
    },
    invalid: {
      body: { cashAccountId: 'x', expected: '-1', counted: 'abc' },
      fields: [
        { field: 'cashAccountId', code: 'INVALID_UUID' },
        { field: 'expected', code: 'INVALID_FORMAT' },
        { field: 'counted', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/finance/custody-handins',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { status: 'open' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['balanced', 'variance', 'resolved'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/finance/custody-handins/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bHandinId }),
      code: 'CUSTODY_HANDIN_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/finance/custody-handins/{id}/resolve',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bHandinId }),
      body: () => ({ reasonCode: 'written_off' }),
      code: 'CUSTODY_HANDIN_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 7, recoveredAmount: 'x' },
      fields: [
        { field: 'reasonCode', code: 'INVALID_TYPE' },
        { field: 'recoveredAmount', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'POST',
    path: '/staff/finance/custody-handins/{id}/investigation',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bHandinId }),
      body: () => ({ ownerId: newId(), dueOn: day(1) }),
      code: 'CUSTODY_HANDIN_NOT_FOUND',
    },
    invalid: {
      body: { ownerId: 'x', dueOn: '2026-02-30' },
      fields: [
        { field: 'ownerId', code: 'INVALID_UUID' },
        { field: 'dueOn', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/finance/custody-investigations',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { status: 'closed' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['open', 'decided'] },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/staff/finance/custody-investigations/{id}/decide',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bInvestigationId }),
      body: () => ({ reasonCode: 'explained' }),
      code: 'CUSTODY_INVESTIGATION_NOT_FOUND',
    },
    invalid: { body: { reasonCode: 7 }, fields: reason() },
  },
  {
    method: 'GET',
    path: '/collector/custody',
    auth: 'tenant',
    as: 'collector',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/units/{unitId}/cheques',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      body: () => ({
        number: 'Q1',
        amount: '10',
        dueOn: day(0),
        receivedOn: day(0),
      }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: {
        number: 'bad number!',
        amount: '10',
        dueOn: '2026-02-30',
        receivedOn: '2026-04-31',
      },
      fields: [
        { field: 'number', code: 'INVALID_FORMAT' },
        { field: 'dueOn', code: 'INVALID_FORMAT' },
        { field: 'receivedOn', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/finance/cheques',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { status: 'paid', unitId: 'x' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: {
            allowed: [
              'received',
              'deposited',
              'cleared',
              'bounced',
              'returned',
            ],
          },
        },
        { field: 'unitId', code: 'INVALID_UUID' },
      ],
    },
  },
  {
    method: 'POST',
    path: '/staff/finance/cheques/{id}/deposit',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bChequeId }),
      body: () => ({ accountId: newId() }),
      code: 'CHEQUE_NOT_FOUND',
    },
    invalid: {
      body: { accountId: 'x' },
      fields: [{ field: 'accountId', code: 'INVALID_UUID' }],
    },
  },
  {
    method: 'POST',
    path: '/staff/finance/cheques/{id}/clear',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: { params: (w) => ({ id: w.bChequeId }), code: 'CHEQUE_NOT_FOUND' },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/finance/cheques/{id}/bounce',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bChequeId }),
      body: () => ({ reasonCode: 'stopped' }),
      code: 'CHEQUE_NOT_FOUND',
    },
    invalid: { body: { reasonCode: 7 }, fields: reason() },
  },
  {
    method: 'POST',
    path: '/staff/finance/cheques/{id}/return',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bChequeId }),
      body: () => ({ reasonCode: 'replaced' }),
      code: 'CHEQUE_NOT_FOUND',
    },
    invalid: { body: { reasonCode: 7 }, fields: reason() },
  },
];

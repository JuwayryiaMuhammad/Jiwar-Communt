import type { Row } from '../registry';

/**
 * The board's work (ADR 0075): units' ownership shares for weighted polls,
 * board meetings and their action items, the handover packs, and the
 * monthly board report.
 */
export const BOARD_WORK_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/governance/unit-shares',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PUT',
    path: '/staff/governance/unit-shares',
    auth: 'tenant',
    as: 'manager',
    denied: 'landlord',
    foreign: 'none',
    invalid: {
      body: { shares: [] },
      fields: [
        {
          field: 'shares',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 500 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/governance/rules',
    auth: 'tenant',
    as: 'manager',
    denied: 'landlord',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/staff/governance/rules',
    auth: 'tenant',
    as: 'manager',
    denied: 'landlord',
    foreign: 'none',
    invalid: {
      body: { candidacyNoDues: 'yes' },
      fields: [{ field: 'candidacyNoDues', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
];

import type { Row } from '../registry';
import type { World } from '../world';

const pageInvalid = {
  query: { limit: '0' },
  fields: [
    { field: 'limit', code: 'INVALID_NUMBER', params: { min: 1, max: 100 } },
  ],
};

const proposal: Row['foreign'] = {
  params: (w) => ({ id: w.bAgendaProposalId }),
  code: 'AGENDA_PROPOSAL_NOT_FOUND',
};
const publication = (body?: (w: World) => object): Row['foreign'] => ({
  params: (w) => ({ id: w.bPublicationId }),
  code: 'BOARD_PUBLICATION_NOT_FOUND',
  ...(body ? { body } : {}),
});

/** Agenda proposals, objections and the follow-up of decisions (ADR 0059). */
export const GOVERNANCE_VOICE_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/governance/agenda-proposals',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { title: '', body: 'Its words.' },
      fields: [
        {
          field: 'title',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 200 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/governance/agenda-proposals',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: pageInvalid,
    noStore: true,
  },
  {
    method: 'GET',
    path: '/governance/agenda-proposals/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: proposal,
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/governance/agenda-proposals/{id}/withdraw',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: proposal,
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/board/agenda-proposals',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'king' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['open', 'accepted', 'declined', 'withdrawn'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/board/agenda-proposals/{id}',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: proposal,
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/board/agenda-proposals/{id}/decide',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: { ...proposal, body: () => ({ outcome: 'accepted' }) },
    invalid: {
      body: { outcome: 'maybe' },
      fields: [
        {
          field: 'outcome',
          code: 'INVALID_VALUE',
          params: { allowed: ['accepted', 'declined'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/governance/publications/{id}/objections',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    // A's owner's own home: the lookup of B's decision is what fails.
    foreign: publication((w) => ({ unitId: w.a.homeUnitId, grounds: 'No.' })),
    invalid: {
      body: { unitId: 'x', grounds: 'No.' },
      fields: [{ field: 'unitId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/governance/objections',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/board/publications/{id}/objections',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: publication(),
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/board/publications/{id}/objections/answer',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: publication(() => ({ body: 'Our reasons.' })),
    invalid: {
      body: { body: '' },
      fields: [
        {
          field: 'body',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 4000 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/governance/approvals/{id}/progress',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bApprovalId }),
      code: 'APPROVAL_NOT_FOUND',
      body: () => ({ status: 'in_progress' }),
    },
    invalid: {
      body: { status: 'done' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: {
            allowed: ['in_progress', 'implemented', 'cannot_implement'],
          },
        },
      ],
    },
    noStore: true,
  },
];

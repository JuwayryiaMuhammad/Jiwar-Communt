import type { Row } from '../registry';

/**
 * Neighbours (ADR 0042): settings, complaint categories and the welcome.
 * Every response of the phase is no-store.
 */
export const NEIGHBOUR_SETUP_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/neighbours/settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/neighbours/settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { maxOpenComplaints: 0, lendingExpiryDays: 91 },
      fields: [
        {
          field: 'maxOpenComplaints',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 50 },
        },
        {
          field: 'lendingExpiryDays',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 90 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbours/complaint-categories',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/neighbours/complaint-categories',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { key: 'Noise!', nameAr: '', nameEn: 'Noise' },
      fields: [
        { field: 'key', code: 'INVALID_FORMAT' },
        {
          field: 'nameAr',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 80 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/neighbours/complaint-categories/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'family',
    foreign: {
      params: (w) => ({ id: w.bComplaintCategoryId }),
      body: () => ({ active: false }),
      code: 'NEIGHBOUR_COMPLAINT_CATEGORY_NOT_FOUND',
    },
    invalid: {
      body: { active: 'no' },
      fields: [{ field: 'active', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbour-complaint-categories',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbours/welcome-template',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PUT',
    path: '/neighbours/welcome-template',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: { enabled: 'yes' },
      fields: [{ field: 'enabled', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbour-welcome',
    auth: 'tenant',
    as: 'family',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
];

/**
 * Complaints between units: the author's routes, the notice's (the unit
 * complained about, by the notice's own id) and the staff's.
 */
export const NEIGHBOUR_COMPLAINT_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/neighbour-complaints',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { categoryId: 'noise', targetUnitCode: '', body: '' },
      fields: [
        { field: 'categoryId', code: 'INVALID_UUID' },
        {
          field: 'targetUnitCode',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 32 },
        },
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
    method: 'GET',
    path: '/neighbour-complaints',
    auth: 'tenant',
    as: 'owner',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { status: 'open' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: {
            allowed: [
              'submitted',
              'under_review',
              'notice_sent',
              'mediation',
              'resolved',
              'dismissed',
            ],
          },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbour-complaints/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bComplaintId }),
      code: 'NEIGHBOUR_COMPLAINT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbour-complaints/{id}/messages',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bComplaintId }),
      code: 'NEIGHBOUR_COMPLAINT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/neighbour-complaints/{id}/messages',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bComplaintId }),
      body: () => ({ body: 'World' }),
      code: 'NEIGHBOUR_COMPLAINT_NOT_FOUND',
    },
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
    path: '/neighbour-complaints/{id}/withdraw',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bComplaintId }),
      code: 'NEIGHBOUR_COMPLAINT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbour-notices',
    auth: 'tenant',
    as: 'tenant',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbour-notices/{id}',
    auth: 'tenant',
    as: 'tenant',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bNoticeId }),
      code: 'NEIGHBOUR_NOTICE_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbour-notices/{id}/messages',
    auth: 'tenant',
    as: 'tenant',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bNoticeId }),
      code: 'NEIGHBOUR_NOTICE_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/neighbour-notices/{id}/messages',
    auth: 'tenant',
    as: 'tenant',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bNoticeId }),
      body: () => ({ body: 'World' }),
      code: 'NEIGHBOUR_NOTICE_NOT_FOUND',
    },
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
    method: 'GET',
    path: '/neighbours/complaints',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { open: 'yes' },
      fields: [
        {
          field: 'open',
          code: 'INVALID_VALUE',
          params: { allowed: ['true', 'false'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbours/complaints/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bComplaintId }),
      code: 'NEIGHBOUR_COMPLAINT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbours/complaints/{id}/messages',
    auth: 'tenant',
    as: 'manager',
    denied: 'family',
    foreign: {
      params: (w) => ({ id: w.bComplaintId }),
      code: 'NEIGHBOUR_COMPLAINT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/neighbours/complaints/{id}/messages',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bComplaintId }),
      body: () => ({ body: 'World' }),
      code: 'NEIGHBOUR_COMPLAINT_NOT_FOUND',
    },
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
    method: 'GET',
    path: '/neighbours/complaints/{id}/unit-messages',
    auth: 'tenant',
    as: 'manager',
    denied: 'family',
    foreign: {
      params: (w) => ({ id: w.bComplaintId }),
      code: 'NEIGHBOUR_COMPLAINT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/neighbours/complaints/{id}/unit-messages',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bComplaintId }),
      body: () => ({ body: 'World' }),
      code: 'NEIGHBOUR_COMPLAINT_NOT_FOUND',
    },
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
    method: 'GET',
    path: '/neighbours/complaints/{id}/notes',
    auth: 'tenant',
    as: 'manager',
    denied: 'family',
    foreign: {
      params: (w) => ({ id: w.bComplaintId }),
      code: 'NEIGHBOUR_COMPLAINT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/neighbours/complaints/{id}/notes',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bComplaintId }),
      body: () => ({ body: 'World' }),
      code: 'NEIGHBOUR_COMPLAINT_NOT_FOUND',
    },
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
    path: '/neighbours/complaints/{id}/notice',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bComplaintId }),
      body: () => ({ body: 'World' }),
      code: 'NEIGHBOUR_COMPLAINT_NOT_FOUND',
    },
    invalid: {
      body: { body: '' },
      fields: [
        {
          field: 'body',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 2000 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/neighbours/complaints/{id}/review',
    auth: 'tenant',
    as: 'manager',
    denied: 'tenant',
    foreign: {
      params: (w) => ({ id: w.bComplaintId }),
      code: 'NEIGHBOUR_COMPLAINT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/neighbours/complaints/{id}/mediation',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bComplaintId }),
      code: 'NEIGHBOUR_COMPLAINT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/neighbours/complaints/{id}/resolve',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bComplaintId }),
      body: () => ({ reasonCode: 'complied' }),
      code: 'NEIGHBOUR_COMPLAINT_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 5 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/neighbours/complaints/{id}/dismiss',
    auth: 'tenant',
    as: 'manager',
    denied: 'landlord',
    foreign: {
      params: (w) => ({ id: w.bComplaintId }),
      body: () => ({ reasonCode: 'unfounded' }),
      code: 'NEIGHBOUR_COMPLAINT_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 5 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbours/units/{unitId}/complaint-history',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ unitId: w.bUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
];

/**
 * The lost-and-found and lending boards, claims and the handover.
 */
export const NEIGHBOUR_BOARD_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/neighbour-posts',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { kind: 'gift', body: '' },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: ['lost', 'found', 'lend', 'borrow'] },
        },
        { field: 'body', code: 'INVALID_LENGTH', params: { min: 1, max: 500 } },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbour-posts',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { board: 'jobs' },
      fields: [
        {
          field: 'board',
          code: 'INVALID_VALUE',
          params: { allowed: ['lost_found', 'lending'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbour-posts/{id}',
    auth: 'tenant',
    as: 'tenant',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bPostId }),
      code: 'NEIGHBOUR_POST_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/neighbour-posts/{id}/close',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPostId }),
      body: () => ({ reasonCode: 'resolved' }),
      code: 'NEIGHBOUR_POST_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 5 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/neighbour-posts/{id}/claims',
    auth: 'tenant',
    as: 'tenant',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPostId }),
      code: 'NEIGHBOUR_POST_NOT_FOUND',
    },
    invalid: {
      body: { note: '' },
      fields: [
        { field: 'note', code: 'INVALID_LENGTH', params: { min: 1, max: 500 } },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbour-claims',
    auth: 'tenant',
    as: 'tenant',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/neighbour-claims/{id}/withdraw',
    auth: 'tenant',
    as: 'tenant',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bClaimId }),
      code: 'NEIGHBOUR_CLAIM_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbours/posts',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { state: 'gone' },
      fields: [
        {
          field: 'state',
          code: 'INVALID_VALUE',
          params: { allowed: ['open', 'expired', 'closed'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/neighbours/posts',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { kind: 'gift', body: '' },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: ['lost', 'found', 'lend', 'borrow'] },
        },
        { field: 'body', code: 'INVALID_LENGTH', params: { min: 1, max: 500 } },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbours/posts/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'family',
    foreign: {
      params: (w) => ({ id: w.bPostId }),
      code: 'NEIGHBOUR_POST_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/neighbours/posts/{id}/remove',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bPostId }),
      body: () => ({ reasonCode: 'duplicate' }),
      code: 'NEIGHBOUR_POST_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 5 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbours/posts/{id}/claims',
    auth: 'tenant',
    as: 'manager',
    denied: 'tenant',
    foreign: {
      params: (w) => ({ id: w.bPostId }),
      code: 'NEIGHBOUR_POST_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/neighbours/posts/{id}/handover',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bPostId }),
      body: (w) => ({ claimId: w.bClaimId }),
      code: 'NEIGHBOUR_POST_NOT_FOUND',
    },
    invalid: {
      body: { claimId: 'mine', recipientAccountId: 'theirs' },
      fields: [
        { field: 'claimId', code: 'INVALID_UUID' },
        { field: 'recipientAccountId', code: 'FIELD_NOT_ALLOWED' },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/neighbours/claims/{id}/decline',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bClaimId }),
      body: () => ({ reasonCode: 'not_the_owner' }),
      code: 'NEIGHBOUR_CLAIM_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 5 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
];

/**
 * Masked contact: conversations, blocks, and the staff's reported cases.
 */
export const NEIGHBOUR_CONTACT_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/neighbour-posts/{id}/conversations',
    auth: 'tenant',
    as: 'tenant',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPostId }),
      body: () => ({ body: 'World' }),
      code: 'NEIGHBOUR_POST_NOT_FOUND',
    },
    invalid: {
      body: { body: '' },
      fields: [
        {
          field: 'body',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 2000 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbour-conversations',
    auth: 'tenant',
    as: 'tenant',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbour-conversations/{id}',
    auth: 'tenant',
    as: 'tenant',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bConversationId }),
      code: 'NEIGHBOUR_CONVERSATION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbour-conversations/{id}/messages',
    auth: 'tenant',
    as: 'owner',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bConversationId }),
      code: 'NEIGHBOUR_CONVERSATION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/neighbour-conversations/{id}/messages',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bConversationId }),
      body: () => ({ body: 'World' }),
      code: 'NEIGHBOUR_CONVERSATION_NOT_FOUND',
    },
    invalid: {
      body: { body: '' },
      fields: [
        {
          field: 'body',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 2000 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/neighbour-conversations/{id}/reveal',
    auth: 'tenant',
    as: 'tenant',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bConversationId }),
      code: 'NEIGHBOUR_CONVERSATION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'DELETE',
    path: '/neighbour-conversations/{id}/reveal',
    auth: 'tenant',
    as: 'tenant',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bConversationId }),
      code: 'NEIGHBOUR_CONVERSATION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/neighbour-conversations/{id}/block',
    auth: 'tenant',
    as: 'tenant',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bConversationId }),
      code: 'NEIGHBOUR_CONVERSATION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/neighbour-conversations/{id}/report',
    auth: 'tenant',
    as: 'tenant',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bConversationId }),
      body: () => ({ reasonCode: 'spam' }),
      code: 'NEIGHBOUR_CONVERSATION_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 'spam', note: '' },
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
    path: '/neighbour-blocks',
    auth: 'tenant',
    as: 'tenant',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'DELETE',
    path: '/neighbour-blocks/{id}',
    auth: 'tenant',
    as: 'tenant',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bBlockId }),
      code: 'NEIGHBOUR_BLOCK_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbours/reports',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'new' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['open', 'closed'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbours/reports/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bReportId }),
      code: 'NEIGHBOUR_REPORT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/neighbours/reports/{id}/messages',
    auth: 'tenant',
    as: 'manager',
    denied: 'tenant',
    foreign: {
      params: (w) => ({ id: w.bReportId }),
      code: 'NEIGHBOUR_REPORT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/neighbours/reports/{id}/close',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bReportId }),
      body: () => ({ reasonCode: 'no_action' }),
      code: 'NEIGHBOUR_REPORT_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 5 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
];

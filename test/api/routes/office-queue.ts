import type { Row } from '../registry';

const NAME = { min: 1, max: 80 };

/**
 * Announcements and the office queue (ADR 0080): an announcement's
 * delivery and its one reminder, the announcement and reply templates, a
 * conversation the management starts, a request's topic and conversion,
 * official letters and their public check, and a unit's correspondence.
 */
export const OFFICE_QUEUE_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/community/announcements/{id}/delivery',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bAnnouncementId }),
      code: 'ANNOUNCEMENT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/community/announcements/{id}/remind',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bAnnouncementId }),
      code: 'ANNOUNCEMENT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/community/announcement-templates',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/community/announcement-templates',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { name: '', titleEn: 'x', bodyEn: 'y' },
      fields: [{ field: 'name', code: 'INVALID_LENGTH', params: NAME }],
    },
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/community/announcement-templates/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bAnnouncementTemplateId }),
      body: () => ({ name: 'World' }),
      code: 'ANNOUNCEMENT_TEMPLATE_NOT_FOUND',
    },
    invalid: {
      body: { name: '' },
      fields: [{ field: 'name', code: 'INVALID_LENGTH', params: NAME }],
    },
    noStore: true,
  },
  {
    method: 'DELETE',
    path: '/community/announcement-templates/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bAnnouncementTemplateId }),
      code: 'ANNOUNCEMENT_TEMPLATE_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/management/outreach',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: () => ({}),
      body: (w) => ({
        residentAccountId: w.a.ids.owner,
        topicId: w.aManagementTopicId,
        unitId: w.bUnitId,
        body: 'The office writes',
      }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { residentAccountId: 'x', topicId: 'y', body: '' },
      fields: [
        { field: 'residentAccountId', code: 'INVALID_UUID' },
        { field: 'topicId', code: 'INVALID_UUID' },
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
    path: '/management/requests/{id}/topic',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bManagementRequestId }),
      body: (w) => ({ topicId: w.aManagementTopicId }),
      code: 'MANAGEMENT_REQUEST_NOT_FOUND',
    },
    invalid: {
      body: { topicId: 'x' },
      fields: [{ field: 'topicId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/management/requests/{id}/convert',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bManagementRequestId }),
      body: (w) => ({
        target: 'ticket',
        categoryId: w.aCategoryId,
        description: 'Fix it',
      }),
      code: 'MANAGEMENT_REQUEST_NOT_FOUND',
    },
    invalid: {
      body: { target: 'repair', categoryId: 'x', description: '' },
      fields: [
        {
          field: 'target',
          code: 'INVALID_VALUE',
          params: { allowed: ['ticket', 'work_order'] },
        },
        { field: 'categoryId', code: 'INVALID_UUID' },
        {
          field: 'description',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 2000 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/management/reply-templates',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { topicId: 'x' },
      fields: [{ field: 'topicId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/management/reply-templates',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { name: '', bodyEn: 'x' },
      fields: [{ field: 'name', code: 'INVALID_LENGTH', params: NAME }],
    },
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/management/reply-templates/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bReplyTemplateId }),
      body: () => ({ name: 'World' }),
      code: 'REPLY_TEMPLATE_NOT_FOUND',
    },
    invalid: {
      body: { name: '' },
      fields: [{ field: 'name', code: 'INVALID_LENGTH', params: NAME }],
    },
    noStore: true,
  },
  {
    method: 'DELETE',
    path: '/management/reply-templates/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bReplyTemplateId }),
      code: 'REPLY_TEMPLATE_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/official-letters',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { unitId: 'x' },
      fields: [{ field: 'unitId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/official-letters',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: () => ({}),
      body: (w) => ({
        kind: 'residence_confirmation',
        unitId: w.bUnitId,
        accountId: w.a.ids.owner,
      }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { kind: 'love_letter', unitId: 'x', accountId: 'y' },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: {
            allowed: [
              'residence_confirmation',
              'no_objection',
              'to_whom_it_may_concern',
            ],
          },
        },
        { field: 'unitId', code: 'INVALID_UUID' },
        { field: 'accountId', code: 'INVALID_UUID' },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/official-letters/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bLetterId }),
      code: 'OFFICIAL_LETTER_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/official-letters/{id}/revoke',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bLetterId }),
      body: () => ({ reasonCode: 'issued_in_error' }),
      code: 'OFFICIAL_LETTER_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 5 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/official-letters/{id}/pdf',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bLetterId }),
      code: 'OFFICIAL_LETTER_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/me/official-letters',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { limit: '0' },
      fields: [
        {
          field: 'limit',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 100 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/me/official-letters/{id}/pdf',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bLetterId }),
      code: 'OFFICIAL_LETTER_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/public/letters/lookup',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    noStore: true,
    invalid: {
      body: { code: 5, unitId: 'x' },
      fields: [
        { field: 'unitId', code: 'FIELD_NOT_ALLOWED' },
        { field: 'code', code: 'INVALID_TYPE' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/units/{unitId}/correspondence',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ unitId: w.bUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      query: { type: 'gossip' },
      fields: [
        {
          field: 'type',
          code: 'INVALID_VALUE',
          params: {
            allowed: [
              'management_request',
              'official_letter',
              'announcement',
              'neighbour_complaint',
              'formal_notice',
              'ticket',
            ],
          },
        },
      ],
    },
    noStore: true,
  },
];

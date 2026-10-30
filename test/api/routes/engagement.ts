import type { Row } from '../registry';

const NAME = { min: 1, max: 80 };
const OCCUPANCY = ['everyone', 'owners', 'tenants'];

/**
 * Community life (ADR 0040): settings, suggestion topics and the audience
 * picker. Every response of the phase is no-store.
 */
export const ENGAGEMENT_SETUP_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/community/settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/community/settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { eventMaxGuests: 21 },
      fields: [
        {
          field: 'eventMaxGuests',
          code: 'INVALID_NUMBER',
          params: { min: 0, max: 20 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/community/suggestion-topics',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/community/suggestion-topics',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { key: 'Parking!', nameAr: '', nameEn: 'Parking' },
      fields: [
        { field: 'key', code: 'INVALID_FORMAT' },
        { field: 'nameAr', code: 'INVALID_LENGTH', params: NAME },
      ],
    },
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/community/suggestion-topics/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'family',
    foreign: {
      params: (w) => ({ id: w.bSuggestionTopicId }),
      body: () => ({ active: false }),
      code: 'SUGGESTION_TOPIC_NOT_FOUND',
    },
    invalid: {
      body: { active: 'no' },
      fields: [{ field: 'active', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/suggestion-topics',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/community/buildings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/community/audience/preview',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { audience: { occupancy: 'renters', buildings: [] } },
      fields: [
        {
          field: 'audience.buildings',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 50 },
        },
        {
          field: 'audience.occupancy',
          code: 'INVALID_VALUE',
          params: { allowed: OCCUPANCY },
        },
      ],
    },
    noStore: true,
  },
];

const draft = () => ({
  kind: 'general',
  titleEn: 'World',
  bodyEn: 'An announcement of the world.',
});

/** Announcements, and works and closures among them. */
export const ANNOUNCEMENT_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/community/announcements',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'gone', kind: 'party' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: {
            allowed: [
              'draft',
              'scheduled',
              'published',
              'expired',
              'ended',
              'archived',
            ],
          },
        },
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: ['general', 'works', 'board'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/community/announcements',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { ...draft(), kind: 'party', priority: 'urgent' },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: ['general', 'works'] },
        },
        {
          field: 'priority',
          code: 'INVALID_VALUE',
          params: { allowed: ['normal', 'important'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/community/announcements/{id}',
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
    method: 'PATCH',
    path: '/community/announcements/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'family',
    foreign: {
      params: (w) => ({ id: w.bAnnouncementId }),
      body: () => ({ priority: 'important' }),
      code: 'ANNOUNCEMENT_NOT_FOUND',
    },
    invalid: {
      body: { priority: 'urgent', attachmentFileIds: 'none' },
      fields: [
        {
          field: 'priority',
          code: 'INVALID_VALUE',
          params: { allowed: ['normal', 'important'] },
        },
        { field: 'attachmentFileIds', code: 'INVALID_TYPE' },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/community/announcements/{id}/publish',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bAnnouncementId }),
      code: 'ANNOUNCEMENT_NOT_FOUND',
    },
    invalid: {
      body: { publishAt: '2099-02-30T08:00:00Z' },
      fields: [{ field: 'publishAt', code: 'INVALID_FORMAT' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/community/announcements/{id}/archive',
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
    path: '/community/announcements/{id}/versions',
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
    path: '/community/announcements/{id}/reads',
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
    path: '/announcements',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { pinned: 'yes' },
      fields: [
        {
          field: 'pinned',
          code: 'INVALID_VALUE',
          params: { allowed: ['true', 'false'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/announcements/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bAnnouncementId }),
      code: 'ANNOUNCEMENT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/announcements/{id}/read',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bAnnouncementId }),
      code: 'ANNOUNCEMENT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
];

/** Events and the answers to them. */
export const EVENT_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/community/events',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'soon' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['upcoming', 'ongoing', 'ended', 'cancelled'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/community/events',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: {
        titleEn: 'World',
        descriptionEn: 'An event of the world.',
        place: '',
        startsAt: '2099-04-31T10:00:00+03:00',
        endsAt: '2027-01-01T10:00:00.000Z',
        capacity: 0,
      },
      fields: [
        {
          field: 'place',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 200 },
        },
        { field: 'startsAt', code: 'INVALID_FORMAT' },
        {
          field: 'capacity',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 100000 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/community/events/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bEventId }),
      code: 'COMMUNITY_EVENT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/community/events/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'family',
    foreign: {
      params: (w) => ({ id: w.bEventId }),
      body: () => ({ capacity: 50 }),
      code: 'COMMUNITY_EVENT_NOT_FOUND',
    },
    invalid: {
      body: { capacity: 100001 },
      fields: [
        {
          field: 'capacity',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 100000 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/community/events/{id}/cancel',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bEventId }),
      body: () => ({ reasonCode: 'weather' }),
      code: 'COMMUNITY_EVENT_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 'boredom' },
      fields: [
        {
          field: 'reasonCode',
          code: 'INVALID_REASON_CODE',
          params: {
            allowed: [
              'weather',
              'low_attendance',
              'venue_unavailable',
              'organizer_unavailable',
              'other',
            ],
          },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/community/events/{id}/attendees',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bEventId }),
      code: 'COMMUNITY_EVENT_NOT_FOUND',
    },
    invalid: {
      query: { response: 'maybe' },
      fields: [
        {
          field: 'response',
          code: 'INVALID_VALUE',
          params: { allowed: ['going', 'not_going'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/events',
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
    path: '/events/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bEventId }),
      code: 'COMMUNITY_EVENT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PUT',
    path: '/events/{id}/rsvp',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bEventId }),
      body: () => ({ response: 'going' }),
      code: 'COMMUNITY_EVENT_NOT_FOUND',
    },
    invalid: {
      body: { response: 'maybe', guests: 21 },
      fields: [
        {
          field: 'response',
          code: 'INVALID_VALUE',
          params: { allowed: ['going', 'not_going'] },
        },
        {
          field: 'guests',
          code: 'INVALID_NUMBER',
          params: { min: 0, max: 20 },
        },
      ],
    },
    noStore: true,
  },
];

const POLL_STATUS = ['scheduled', 'open', 'closed', 'cancelled'];

/** Consultative polls. */
export const POLL_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/community/polls',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'counting' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: POLL_STATUS },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/community/polls',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: {
        questionEn: 'World?',
        options: [{ labelEn: 'Only one' }],
        closesAt: '2027-02-29T09:00:00Z',
      },
      fields: [
        {
          field: 'options',
          code: 'INVALID_LENGTH',
          params: { min: 2, max: 10 },
        },
        { field: 'closesAt', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/community/polls/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: { params: (w) => ({ id: w.bPollId }), code: 'POLL_NOT_FOUND' },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/community/polls/{id}/audience',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: { params: (w) => ({ id: w.bPollId }), code: 'POLL_NOT_FOUND' },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/community/polls/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'family',
    foreign: {
      params: (w) => ({ id: w.bPollId }),
      body: () => ({ closesAt: '2030-01-01T00:00:00.000Z' }),
      code: 'POLL_NOT_FOUND',
    },
    invalid: {
      body: { multiple: 'yes', options: [] },
      fields: [
        {
          field: 'options',
          code: 'INVALID_LENGTH',
          params: { min: 2, max: 10 },
        },
        { field: 'multiple', code: 'INVALID_TYPE' },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/community/polls/{id}/close',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: { params: (w) => ({ id: w.bPollId }), code: 'POLL_NOT_FOUND' },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/community/polls/{id}/cancel',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: { params: (w) => ({ id: w.bPollId }), code: 'POLL_NOT_FOUND' },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/polls',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { limit: '101' },
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
    path: '/polls/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: { params: (w) => ({ id: w.bPollId }), code: 'POLL_NOT_FOUND' },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/polls/{id}/votes',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPollId }),
      body: (w) => ({ optionIds: [w.bPollOptionId] }),
      code: 'POLL_NOT_FOUND',
    },
    invalid: {
      body: { optionIds: [] },
      fields: [
        {
          field: 'optionIds',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 10 },
        },
      ],
    },
    noStore: true,
  },
];

const SUGGESTION_STATUS = [
  'received',
  'under_review',
  'planned',
  'done',
  'declined',
];

/** Suggestions, the board and "you said, we did". */
export const SUGGESTION_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/suggestions',
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
    method: 'POST',
    path: '/suggestions',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: 'none',
    invalid: {
      body: { topicId: 'general', body: '' },
      fields: [
        { field: 'topicId', code: 'INVALID_UUID' },
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
    path: '/suggestions/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bSuggestionId }),
      code: 'SUGGESTION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/suggestion-board',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { topicId: 'general' },
      fields: [{ field: 'topicId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/suggestion-board/done',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PUT',
    path: '/suggestion-board/{id}/support',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bSuggestionId }),
      code: 'SUGGESTION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'DELETE',
    path: '/suggestion-board/{id}/support',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bSuggestionId }),
      code: 'SUGGESTION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/community/suggestions',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'lost', published: 'yes' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: SUGGESTION_STATUS },
        },
        {
          field: 'published',
          code: 'INVALID_VALUE',
          params: { allowed: ['true', 'false'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/community/suggestions/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bSuggestionId }),
      code: 'SUGGESTION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/community/suggestions/{id}/status',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bSuggestionId }),
      body: () => ({ status: 'under_review' }),
      code: 'SUGGESTION_NOT_FOUND',
    },
    invalid: {
      body: { status: 'lost' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: SUGGESTION_STATUS },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'PUT',
    path: '/community/suggestions/{id}/response',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bSuggestionId }),
      body: () => ({ response: 'Thank you.' }),
      code: 'SUGGESTION_NOT_FOUND',
    },
    invalid: {
      body: { response: '' },
      fields: [
        {
          field: 'response',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 2000 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/community/suggestions/{id}/publish',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bSuggestionId }),
      body: () => ({ titleEn: 'World', textEn: 'A summary.' }),
      code: 'SUGGESTION_NOT_FOUND',
    },
    invalid: {
      body: { titleEn: 'A title without its text' },
      fields: [{ field: 'textEn', code: 'FIELD_REQUIRED' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/community/suggestions/{id}/unpublish',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bSuggestionId }),
      code: 'SUGGESTION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PUT',
    path: '/community/suggestions/{id}/done-note',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bSuggestionId }),
      body: () => ({ noteEn: 'Done.' }),
      code: 'SUGGESTION_NOT_FOUND',
    },
    invalid: {
      body: { attachmentFileIds: ['not-a-file'] },
      fields: [{ field: 'attachmentFileIds', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
];

/** The daily brief. */
export const BRIEF_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/me/daily-brief',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
];

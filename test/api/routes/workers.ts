import { nationalIdFor } from '../../setup/fixtures';
import { uniquePhone } from '../../setup/http-app';
import type { Row } from '../registry';

export const workerBody = () => ({
  fullName: 'Api Worker',
  idDocumentType: 'national_id',
  idDocumentNumber: nationalIdFor(),
  phone: uniquePhone(),
  capacity: 'hourly',
  schedule: { days: [0, 1], windows: [{ from: '08:00', to: '12:00' }] },
});

const reason = (reasonCode: string) => () => ({ reasonCode, reason: 'Stated' });
const OPEN_CLOSED = { allowed: ['open', 'closed'] };
const engagement = (w: { bEngagementId: string }) => ({ id: w.bEngagementId });
const worker = (w: { bWorkerId: string }) => ({ id: w.bWorkerId });

/** Engagement actions open to residents (workers.manage) and managers (workers.review). */
const engagementAction = (
  verb: string,
  body: (() => object) | undefined,
  invalid: Row['invalid'],
  noStore = false,
): Row => ({
  method: 'POST',
  path: `/worker-engagements/{id}/${verb}`,
  auth: 'tenant',
  as: 'owner',
  // Every tenant role holds workers.manage or workers.review.
  denied: 'none',
  foreign: { params: engagement, body, code: 'ENGAGEMENT_NOT_FOUND' },
  invalid,
  noStore,
});

export const WORKERS_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/units/{unitId}/workers',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
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
  },
  {
    method: 'POST',
    path: '/units/{unitId}/workers',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      body: workerBody,
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { ...workerBody(), capacity: 'gardener', validUntil: 'later' },
      fields: [
        {
          field: 'capacity',
          code: 'INVALID_VALUE',
          params: {
            allowed: ['live_in', 'hourly', 'driver', 'nanny', 'temporary'],
          },
        },
        { field: 'validUntil', code: 'INVALID_FORMAT' },
      ],
    },
  },
  engagementAction('suspend', reason('leave'), {
    body: { reason: 5 },
    fields: [{ field: 'reason', code: 'INVALID_TYPE' }],
  }),
  engagementAction('resume', undefined, 'none', true),
  engagementAction('end', reason('work_finished'), {
    body: { reasonCode: 5 },
    fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
  }),
  engagementAction(
    'reissue-code',
    () => ({ reasonCode: 'lost' }),
    {
      body: { reasonCode: 5, reason: 'not accepted' },
      fields: [
        { field: 'reason', code: 'FIELD_NOT_ALLOWED' },
        { field: 'reasonCode', code: 'INVALID_TYPE' },
      ],
    },
    true,
  ),
  {
    method: 'POST',
    path: '/worker-engagements/{id}/card-incident',
    auth: 'tenant',
    as: 'manager',
    // Management only (ADR 0022): residents use reissue-code.
    denied: 'owner',
    foreign: {
      params: engagement,
      body: () => ({ type: 'lost' }),
      code: 'ENGAGEMENT_NOT_FOUND',
    },
    invalid: {
      body: { type: 'stolen' },
      fields: [
        {
          field: 'type',
          code: 'INVALID_VALUE',
          params: { allowed: ['lost', 'confiscated'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/worker-engagements',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'gone' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: {
            allowed: [
              'pending_review',
              'active',
              'suspended',
              'ended',
              'rejected',
            ],
          },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/worker-engagements/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: { params: engagement, code: 'ENGAGEMENT_NOT_FOUND' },
    invalid: 'none',
    // The photo's presigned URL (ADR 0029).
    noStore: true,
  },
  {
    method: 'POST',
    path: '/worker-engagements/{id}/review',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: engagement,
      body: () => ({ decision: 'approve' }),
      code: 'ENGAGEMENT_NOT_FOUND',
    },
    invalid: {
      body: { decision: 'maybe', birthDateConfirmed: 'yes' },
      fields: [
        {
          field: 'decision',
          code: 'INVALID_VALUE',
          params: { allowed: ['approve', 'reject'] },
        },
        { field: 'birthDateConfirmed', code: 'INVALID_TYPE' },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/workers/{id}/birth-date',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: worker,
      body: () => ({ birthDate: '1990-01-01' }),
      code: 'WORKER_NOT_FOUND',
    },
    invalid: {
      body: {},
      fields: [{ field: 'birthDate', code: 'FIELD_REQUIRED' }],
    },
  },
  {
    method: 'PUT',
    path: '/workers/{id}/photo',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: worker,
      body: () => ({ fileId: '01a0f000-0000-7000-8000-000000000001' }),
      code: 'WORKER_NOT_FOUND',
    },
    invalid: {
      body: { fileId: 'nope' },
      fields: [{ field: 'fileId', code: 'INVALID_UUID' }],
    },
  },
  {
    method: 'POST',
    path: '/workers/{id}/ban',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: worker,
      body: reason('security'),
      code: 'WORKER_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: [] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'POST',
    path: '/workers/{id}/unban',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: { params: worker, code: 'WORKER_NOT_FOUND' },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/workers/{id}/report-underage',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: worker,
      body: reason('report_received'),
      code: 'WORKER_NOT_FOUND',
    },
    invalid: {
      body: { reason: {} },
      fields: [{ field: 'reason', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'GET',
    path: '/compliance-cases',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'pending' },
      fields: [{ field: 'status', code: 'INVALID_VALUE', params: OPEN_CLOSED }],
    },
  },
  {
    method: 'POST',
    path: '/compliance-cases/{id}/close',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bCaseId }),
      body: reason('resolved'),
      code: 'COMPLIANCE_CASE_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 1 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'GET',
    path: '/card-incidents',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'lost' },
      fields: [{ field: 'status', code: 'INVALID_VALUE', params: OPEN_CLOSED }],
    },
  },
  {
    method: 'POST',
    path: '/card-incidents/{id}/close',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bIncidentId }),
      code: 'CARD_INCIDENT_NOT_FOUND',
    },
    invalid: 'none',
  },
];

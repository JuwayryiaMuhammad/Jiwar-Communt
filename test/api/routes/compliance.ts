import { COMPLIANCE_KINDS } from '../../../src/maintenance/compliance/compliance-rules';
import type { Row } from '../registry';

const keeper = (row: Omit<Row, 'auth' | 'as' | 'denied'>): Row => ({
  auth: 'tenant',
  as: 'manager',
  denied: 'technician',
  ...row,
});
const incidents = (row: Omit<Row, 'auth' | 'as' | 'denied'>): Row => ({
  auth: 'tenant',
  as: 'manager',
  denied: 'guard',
  noStore: true,
  ...row,
});
/** An owner's own corrective actions: any staff member, never a resident. */
const owner = (row: Omit<Row, 'auth' | 'as' | 'denied'>): Row => ({
  auth: 'tenant',
  as: 'technician',
  denied: 'owner',
  noStore: true,
  ...row,
});
const UUID = '0192f1c2-7a4b-7c3d-8e9f-0a1b2c3d4e5f';

/** The compliance calendar (ADR 0087). */
export const COMPLIANCE_ROUTES: Row[] = [
  keeper({
    method: 'GET',
    path: '/staff/compliance/items',
    foreign: 'none',
    invalid: {
      query: { kind: 'boiler', status: 'gone' },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: COMPLIANCE_KINDS },
        },
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['active', 'retired'] },
        },
      ],
    },
  }),
  keeper({
    method: 'POST',
    path: '/staff/compliance/items',
    foreign: 'none',
    invalid: {
      body: { kind: 'fire_system', title: '', firstDueOn: '2027-02-30' },
      fields: [
        {
          field: 'title',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 120 },
        },
        { field: 'firstDueOn', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  keeper({
    method: 'GET',
    path: '/staff/compliance/items/{id}',
    foreign: {
      params: (w) => ({ id: w.bComplianceItemId }),
      code: 'COMPLIANCE_ITEM_NOT_FOUND',
    },
    invalid: 'none',
  }),
  keeper({
    method: 'PATCH',
    path: '/staff/compliance/items/{id}',
    foreign: {
      params: (w) => ({ id: w.bComplianceItemId }),
      body: () => ({ title: 'Another title' }),
      code: 'COMPLIANCE_ITEM_NOT_FOUND',
    },
    invalid: {
      body: { recurrenceMonths: 0 },
      fields: [
        {
          field: 'recurrenceMonths',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 120 },
        },
      ],
    },
  }),
  keeper({
    method: 'POST',
    path: '/staff/compliance/items/{id}/retire',
    foreign: {
      params: (w) => ({ id: w.bComplianceItemId }),
      body: () => ({ reasonCode: 'other' }),
      code: 'COMPLIANCE_ITEM_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: ['x'] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  }),
  keeper({
    method: 'POST',
    path: '/staff/compliance/occurrences/{occurrenceId}/complete',
    foreign: {
      params: (w) => ({ occurrenceId: w.bComplianceOccurrenceId }),
      body: () => ({ doneOn: '2027-01-01' }),
      code: 'COMPLIANCE_OCCURRENCE_NOT_FOUND',
    },
    invalid: {
      body: { doneOn: '2027-02-30' },
      fields: [{ field: 'doneOn', code: 'INVALID_FORMAT' }],
    },
  }),
  keeper({
    method: 'POST',
    path: '/staff/compliance/occurrences/{occurrenceId}/evidence',
    foreign: {
      params: (w) => ({ occurrenceId: w.bComplianceOccurrenceId }),
      body: () => ({ fileId: UUID }),
      code: 'COMPLIANCE_OCCURRENCE_NOT_FOUND',
    },
    invalid: {
      body: { fileId: 'x' },
      fields: [{ field: 'fileId', code: 'INVALID_UUID' }],
    },
  }),
  keeper({
    method: 'DELETE',
    path: '/staff/compliance/evidence/{evidenceId}',
    foreign: {
      params: (w) => ({ evidenceId: w.bComplianceEvidenceId }),
      code: 'COMPLIANCE_EVIDENCE_NOT_FOUND',
    },
    invalid: 'none',
  }),
  keeper({
    method: 'GET',
    path: '/staff/compliance/calendar',
    foreign: 'none',
    invalid: {
      query: { from: '2027-02-30' },
      fields: [{ field: 'from', code: 'INVALID_FORMAT' }],
    },
  }),
  keeper({
    method: 'GET',
    path: '/staff/compliance/report',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  }),
  keeper({
    method: 'GET',
    path: '/staff/compliance/report/export',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  }),
  keeper({
    method: 'GET',
    path: '/staff/compliance/settings',
    foreign: 'none',
    invalid: 'none',
  }),
  keeper({
    method: 'PUT',
    path: '/staff/compliance/settings',
    foreign: 'none',
    invalid: {
      body: { leadDays: [] },
      fields: [
        { field: 'leadDays', code: 'INVALID_LENGTH', params: { min: 1 } },
      ],
    },
  }),
];

/** Corrective actions, the safety KPIs and the office's lockdown (ADR 0087). */
export const SAFETY_ROUTES: Row[] = [
  incidents({
    method: 'GET',
    path: '/staff/security/incidents/{id}/actions',
    foreign: {
      params: (w) => ({ id: w.bIncidentId }),
      code: 'INCIDENT_NOT_FOUND',
    },
    invalid: 'none',
  }),
  incidents({
    method: 'POST',
    path: '/staff/security/incidents/{id}/actions',
    foreign: {
      params: (w) => ({ id: w.bIncidentId }),
      body: (w) => ({
        description: 'Fix it',
        ownerId: w.a.ids.manager,
        dueOn: '2031-01-01',
      }),
      code: 'INCIDENT_NOT_FOUND',
    },
    invalid: {
      body: { description: '', dueOn: '2027-02-30' },
      fields: [
        {
          field: 'description',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 1000 },
        },
        { field: 'ownerId', code: 'FIELD_REQUIRED' },
        { field: 'dueOn', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  incidents({
    method: 'PATCH',
    path: '/staff/security/incident-actions/{actionId}',
    foreign: {
      params: (w) => ({ actionId: w.bIncidentActionId }),
      body: () => ({ description: 'Again' }),
      code: 'INCIDENT_ACTION_NOT_FOUND',
    },
    invalid: {
      body: { ownerId: 'x' },
      fields: [{ field: 'ownerId', code: 'INVALID_UUID' }],
    },
  }),
  incidents({
    method: 'POST',
    path: '/staff/security/incident-actions/{actionId}/done',
    foreign: {
      params: (w) => ({ actionId: w.bIncidentActionId }),
      body: () => ({}),
      code: 'INCIDENT_ACTION_NOT_FOUND',
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
  }),
  incidents({
    method: 'POST',
    path: '/staff/security/incident-actions/{actionId}/cancel',
    foreign: {
      params: (w) => ({ actionId: w.bIncidentActionId }),
      body: () => ({ reasonCode: 'duplicate' }),
      code: 'INCIDENT_ACTION_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: ['x'] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  }),
  owner({
    method: 'GET',
    path: '/staff/incident-actions',
    foreign: 'none',
    invalid: 'none',
  }),
  owner({
    method: 'POST',
    path: '/staff/incident-actions/{actionId}/done',
    foreign: {
      params: (w) => ({ actionId: w.bIncidentActionId }),
      body: () => ({}),
      code: 'INCIDENT_ACTION_NOT_FOUND',
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
  }),
  incidents({
    method: 'GET',
    path: '/staff/security/reports/safety',
    foreign: 'none',
    invalid: {
      query: { from: '2027-02-30' },
      fields: [{ field: 'from', code: 'INVALID_FORMAT' }],
    },
  }),
  incidents({
    method: 'POST',
    path: '/staff/security/lockdowns',
    foreign: 'none',
    invalid: {
      body: { scope: 'all', reasonCode: 'drill', confirmation: 'yes' },
      fields: [
        {
          field: 'confirmation',
          code: 'INVALID_VALUE',
          params: { allowed: ['LOCKDOWN'] },
        },
      ],
    },
  }),
];

import type { Row } from '../registry';

const file = (w: { bFileId: string }) => ({ id: w.bFileId });
const FOREIGN = { params: file, code: 'FILE_NOT_FOUND' };

/**
 * Files (ADR 0029): every tenant role may upload something (the guard its
 * parcel photos, ADR 0035), so no persona is refused the routes as a whole;
 * what a role may upload is per purpose (test/api/files.e2e-spec.ts).
 */
export const FILES_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/files/uploads',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: { purpose: 'selfie', contentType: 5, size: 0 },
      fields: [
        {
          field: 'purpose',
          code: 'INVALID_VALUE',
          params: {
            allowed: [
              'worker_photo',
              'document',
              'resident_photo',
              'ticket_photo',
              'parcel_photo',
              'data_export',
              'request_attachment',
              'community_attachment',
              'complaint_evidence',
              'neighbour_post_photo',
              'gate_request_photo',
              'vehicle_licence',
              'parking_photo',
              'vehicle_fine_photo',
              'gate_service_photo',
              'dispute_photo',
              'contractor_photo',
              'permit_photo',
              'guard_task_photo',
              'found_item_photo',
              'patrol_photo',
              'incident_photo',
              'blocklist_photo',
              'violation_photo',
              'violation_appeal_photo',
              'child_photo',
              'child_escort_photo',
              'approval_attachment',
              'board_appeal_attachment',
              'expense_invoice',
              'visitor_photo',
            ],
          },
        },
        { field: 'contentType', code: 'INVALID_TYPE' },
        { field: 'size', code: 'INVALID_NUMBER', params: { min: 1 } },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/files/{id}/finalize',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: FOREIGN,
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/files/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: FOREIGN,
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'DELETE',
    path: '/files/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: FOREIGN,
    invalid: 'none',
  },
];

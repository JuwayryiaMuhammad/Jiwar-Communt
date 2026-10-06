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

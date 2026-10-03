import type { Row } from '../registry';

const file = (w: { bFileId: string }) => ({ id: w.bFileId });
const FOREIGN = { params: file, code: 'FILE_NOT_FOUND' };

/** Files (ADR 0029): every tenant role but the guard may upload something. */
export const FILES_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/files/uploads',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { purpose: 'selfie', contentType: 5, size: 0 },
      fields: [
        {
          field: 'purpose',
          code: 'INVALID_VALUE',
          params: { allowed: ['worker_photo', 'document', 'resident_photo'] },
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
    denied: 'guard',
    foreign: FOREIGN,
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/files/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: FOREIGN,
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'DELETE',
    path: '/files/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: FOREIGN,
    invalid: 'none',
  },
];

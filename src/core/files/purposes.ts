import type { FilePurpose } from '@prisma/client';
import type { Permission } from '../access/permissions';

const MB = 1024 * 1024;

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const FILE_TYPES = [
  ...IMAGE_TYPES,
  'application/pdf',
  'application/zip',
] as const;
export type FileContentType = (typeof FILE_TYPES)[number];

export interface FilePurposeDefinition {
  types: readonly FileContentType[];
  maxBytes: number;
  /** Any one of these lets an account upload a file for this purpose. */
  uploaders: readonly Permission[];
}

/**
 * What each purpose takes and who may upload it (ADR 0029). The database
 * repeats the types and limits as CHECKs (files_content_type_for_purpose,
 * files_size_for_purpose); a unit test keeps the two in step.
 *
 * A worker's photo is uploaded by whoever may register a worker, and by the
 * manager, who may set or replace it later. A resident's own photo is
 * uploaded by the account itself (`profile.photo`, ADR 0031). A ticket's
 * photos come from whoever opens tickets or works them (ADR 0032). A
 * parcel's photos are the guard's (`parcels.handle`, ADR 0035). An
 * export's archive is the server's alone (ADR 0036).
 */
export const FILE_PURPOSES = {
  worker_photo: {
    types: IMAGE_TYPES,
    maxBytes: 5 * MB,
    uploaders: ['workers.manage', 'workers.review'],
  },
  document: {
    types: [...IMAGE_TYPES, 'application/pdf'],
    maxBytes: 10 * MB,
    uploaders: ['accounts.manage'],
  },
  resident_photo: {
    types: IMAGE_TYPES,
    maxBytes: 5 * MB,
    uploaders: ['profile.photo'],
  },
  ticket_photo: {
    types: IMAGE_TYPES,
    maxBytes: 5 * MB,
    uploaders: ['tickets.create', 'tickets.work'],
  },
  parcel_photo: {
    types: IMAGE_TYPES,
    maxBytes: 5 * MB,
    uploaders: ['parcels.handle'],
  },
  // A personal-data export (ADR 0036): built by the server and attached to
  // its export record; nobody uploads one.
  data_export: {
    types: ['application/zip'],
    maxBytes: 512 * MB,
    uploaders: [],
  },
} as const satisfies Record<FilePurpose, FilePurposeDefinition>;

/** Every permission that may upload some purpose (the controller's gate). */
export const ANY_UPLOADER = [
  ...new Set(Object.values(FILE_PURPOSES).flatMap((p) => p.uploaders)),
] as Permission[];

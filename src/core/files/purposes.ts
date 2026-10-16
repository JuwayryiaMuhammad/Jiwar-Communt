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
 * export's archive is the server's alone (ADR 0036). A management request
 * message's attachment comes from either side of the request (ADR 0039).
 * What is attached to an announcement, an event or a "we did" note is the
 * staff's (ADR 0040). A complaint's evidence comes from whoever writes on
 * the complaint, and a board post's photos from whoever posts (ADR 0042).
 * The photo of a visitor waiting at the gate is the guard's (ADR 0043).
 * A vehicle's licence is uploaded by whoever registers the unit's
 * vehicles; a parking photo by a reporter or an appellant; a fine's photo
 * by the staff who issue fines (ADR 0045).
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
  // A management request message's attachment (ADR 0039): a photo or a
  // document. Uploaded by whoever may write on a request.
  request_attachment: {
    types: [...IMAGE_TYPES, 'application/pdf'],
    maxBytes: 10 * MB,
    uploaders: ['requests.create', 'requests.handle'],
  },
  // An announcement's, an event's or a "we did" note's attachment (ADR
  // 0040): a photo or a document, uploaded by the staff who write them;
  // and the PDF of the board's decisions and minutes (ADR 0051), uploaded
  // by a sitting board member or the manager.
  community_attachment: {
    types: [...IMAGE_TYPES, 'application/pdf'],
    maxBytes: 10 * MB,
    uploaders: [
      'community.publish',
      'community.suggestions',
      'governance.board',
      'governance.manage',
    ],
  },
  // A complaint's evidence (ADR 0042): photos and documents, never a video.
  // Uploaded by whoever may write on a complaint or answer a notice.
  complaint_evidence: {
    types: [...IMAGE_TYPES, 'application/pdf'],
    maxBytes: 10 * MB,
    uploaders: ['neighbours.complain', 'neighbours.board', 'neighbours.handle'],
  },
  // A lost-and-found or lending post's photo (ADR 0042).
  neighbour_post_photo: {
    types: IMAGE_TYPES,
    maxBytes: 5 * MB,
    uploaders: ['neighbours.board', 'neighbours.handle'],
  },
  // A visitor waiting at the gate, for the household asked (ADR 0043).
  gate_request_photo: {
    types: IMAGE_TYPES,
    maxBytes: 5 * MB,
    uploaders: ['gate.operate'],
  },
  // A vehicle's licence (ADR 0045): a photo or a scan.
  vehicle_licence: {
    types: [...IMAGE_TYPES, 'application/pdf'],
    maxBytes: 10 * MB,
    uploaders: ['vehicles.register'],
  },
  // A parking report's photo, or a fine's appeal's (ADR 0045).
  parking_photo: {
    types: IMAGE_TYPES,
    maxBytes: 5 * MB,
    uploaders: ['parking.report', 'vehicles.register'],
  },
  // A vehicle fine's photo (ADR 0045), the staff's.
  vehicle_fine_photo: {
    types: IMAGE_TYPES,
    maxBytes: 5 * MB,
    uploaders: ['fines.issue'],
  },
  // A suspicious-activity report's photo (ADR 0047), the resident's.
  gate_service_photo: {
    types: IMAGE_TYPES,
    maxBytes: 5 * MB,
    uploaders: ['gate_services.request'],
  },
  // A resident's photo backing an invoice dispute (ADR 0048). Residents
  // have no money permission: any resident may upload one; only someone
  // who sees the unit's money can attach it to a dispute.
  dispute_photo: {
    types: IMAGE_TYPES,
    maxBytes: 5 * MB,
    uploaders: ['units.read'],
  },
  // A contractor worker's face (ADR 0049): uploaded by the resident who
  // registers the worker on a works permit, shown to the guard, purged 30
  // days after the permit ends.
  contractor_photo: {
    types: IMAGE_TYPES,
    maxBytes: 5 * MB,
    uploaders: ['permits.request'],
  },
  // A material exit's photo of the goods (ADR 0049), the resident's.
  permit_photo: {
    types: IMAGE_TYPES,
    maxBytes: 5 * MB,
    uploaders: ['permits.request'],
  },
  // A guard's photo of a task's work (ADR 0050): a closed unit inspected,
  // a custom task done. Staff only.
  guard_task_photo: {
    types: IMAGE_TYPES,
    maxBytes: 5 * MB,
    uploaders: ['gate.operate'],
  },
  // A found item's photo (ADR 0050), taken at the gate.
  found_item_photo: {
    types: IMAGE_TYPES,
    maxBytes: 5 * MB,
    uploaders: ['gate.operate', 'found_items.manage'],
  },
  // A patrol note's photo (ADR 0052): what a guard saw at a checkpoint.
  // Staff only; it stays when its guard is erased (it shows a place).
  patrol_photo: {
    types: IMAGE_TYPES,
    maxBytes: 5 * MB,
    uploaders: ['gate.operate'],
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

import type { FilePurpose } from '@prisma/client';
import type { Permission } from '../access/permissions';

const MB = 1024 * 1024;

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** Recordings (ADR 0056): the MP4 family only, its duration read at finalize. */
export const AUDIO_TYPES = ['audio/mp4'] as const;
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime'] as const;
export const FILE_TYPES = [
  ...IMAGE_TYPES,
  'application/pdf',
  'application/zip',
  ...AUDIO_TYPES,
  ...VIDEO_TYPES,
] as const;
export type FileContentType = (typeof FILE_TYPES)[number];

export interface FilePurposeDefinition {
  types: readonly FileContentType[];
  maxBytes: number;
  /** Any one of these lets an account upload a file for this purpose. */
  uploaders: readonly Permission[];
  /** A recording: its duration is read from its container at finalize. */
  media?: 'audio' | 'video';
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
  // An incident's photo (ADR 0053): what a guard or the management saw.
  // Staff only, never a resident's; it stays when its author is erased.
  incident_photo: {
    types: IMAGE_TYPES,
    maxBytes: 5 * MB,
    uploaders: ['gate.operate', 'incidents.manage'],
  },
  // A banned or watched person's face (ADR 0053), for the guards on shift;
  // deleted with the entry's other personal data 30 days after it ends.
  blocklist_photo: {
    types: IMAGE_TYPES,
    maxBytes: 5 * MB,
    uploaders: ['blocklist.manage'],
  },
  // A violation's photo (ADR 0053), the guard's or the office's; the unit
  // sees it.
  violation_photo: {
    types: IMAGE_TYPES,
    maxBytes: 5 * MB,
    uploaders: ['gate.operate', 'violations.issue'],
  },
  // A resident's photo backing a violation's appeal (ADR 0053). Any
  // resident may upload one; only a keeper or the primary attaches it.
  violation_appeal_photo: {
    types: IMAGE_TYPES,
    maxBytes: 5 * MB,
    uploaders: ['units.read'],
  },
  // A child's photo (ADR 0054), set by the primary or a household delegate
  // while the child's exit control is on: shown to the household and to a
  // guard checking the child at the gate, deleted when the control ends.
  child_photo: {
    types: IMAGE_TYPES,
    maxBytes: 5 * MB,
    uploaders: ['household.manage'],
  },
  // An outside escort's photo (ADR 0054): the person who may collect a
  // child, for the guard to compare. Deleted when the escort is revoked.
  child_escort_photo: {
    types: IMAGE_TYPES,
    maxBytes: 5 * MB,
    uploaders: ['household.manage'],
  },
  // An approval request's package (ADR 0055): documents and photos the
  // manager or the accountant puts before the board.
  approval_attachment: {
    types: [...IMAGE_TYPES, 'application/pdf'],
    maxBytes: 10 * MB,
    uploaders: ['governance.approvals', 'governance.manage'],
  },
  // An owner's documents and photos backing an appeal to the board (ADR
  // 0055). Any owner may upload one; only an owner or the primary of the
  // decision's unit attaches it.
  board_appeal_attachment: {
    types: [...IMAGE_TYPES, 'application/pdf'],
    maxBytes: 10 * MB,
    uploaders: ['governance.read'],
  },
  // An expense's invoice (ADR 0055): a photo or the PDF, uploaded by who
  // records expenses.
  expense_invoice: {
    types: [...IMAGE_TYPES, 'application/pdf'],
    maxBytes: 10 * MB,
    uploaders: ['finance.budget'],
  },
  // A visitor's photo at entry (ADR 0056), taken by the guard: seen by the
  // guards on shift and the management only, deleted 30 days after the
  // entry unless an incident keeps it.
  visitor_photo: {
    types: IMAGE_TYPES,
    maxBytes: 5 * MB,
    uploaders: ['gate.operate'],
  },
  // Recordings (ADR 0056): a patrol note's or an incident's sound or video,
  // the MP4 family only. The caps are the system's; the gate's settings
  // may lower them and limit the seconds, at attach. Kept as their parent.
  patrol_note_audio: {
    types: AUDIO_TYPES,
    maxBytes: 20 * MB,
    uploaders: ['gate.operate'],
    media: 'audio',
  },
  patrol_note_video: {
    types: VIDEO_TYPES,
    maxBytes: 100 * MB,
    uploaders: ['gate.operate'],
    media: 'video',
  },
  incident_audio: {
    types: AUDIO_TYPES,
    maxBytes: 20 * MB,
    uploaders: ['gate.operate', 'incidents.manage'],
    media: 'audio',
  },
  incident_video: {
    types: VIDEO_TYPES,
    maxBytes: 100 * MB,
    uploaders: ['gate.operate', 'incidents.manage'],
    media: 'video',
  },
  // A drawn signature on an incident report (ADR 0056): a PNG of it, by
  // the author or a reviewer. Its image goes at its signer's erasure.
  incident_signature: {
    types: ['image/png'],
    maxBytes: 256 * 1024,
    uploaders: ['gate.operate', 'incidents.manage'],
  },
  // A decision appeal's attachment (ADR 0059): a photo or a PDF, uploaded
  // by a resident who appeals a staff decision about their unit.
  decision_appeal_attachment: {
    types: [...IMAGE_TYPES, 'application/pdf'],
    maxBytes: 10 * MB,
    uploaders: ['units.read'],
  },
  // A registrant's proof of capacity (ADR 0062): a photo or a PDF. No
  // account uploads one: the registrant's status link starts the upload,
  // the file is attached to the request from the start.
  registration_document: {
    types: [...IMAGE_TYPES, 'application/pdf'],
    maxBytes: 10 * MB,
    uploaders: [],
  },
  // Proof of an invitee's relation (ADR 0062): a photo or a PDF, from
  // whoever may invite to the household.
  kinship_proof: {
    types: [...IMAGE_TYPES, 'application/pdf'],
    maxBytes: 10 * MB,
    uploaders: ['household.manage'],
  },
  // A document in a unit's vault (ADR 0062): a photo or a PDF, from a
  // resident of the unit or the management.
  unit_document: {
    types: [...IMAGE_TYPES, 'application/pdf'],
    maxBytes: 10 * MB,
    uploaders: ['units.read', 'unit_documents.manage'],
  },
  // A personal-data export (ADR 0036): built by the server and attached to
  // its export record; nobody uploads one.
  data_export: {
    types: ['application/zip'],
    maxBytes: 512 * MB,
    uploaders: [],
  },
} as const satisfies Record<FilePurpose, FilePurposeDefinition>;

/** Whether a purpose is a recording, and of what (ADR 0056). */
export const mediaOf = (purpose: FilePurpose): 'audio' | 'video' | null =>
  (FILE_PURPOSES[purpose] as FilePurposeDefinition).media ?? null;

/** Every permission that may upload some purpose (the controller's gate). */
export const ANY_UPLOADER = [
  ...new Set(Object.values(FILE_PURPOSES).flatMap((p) => p.uploaders)),
] as Permission[];

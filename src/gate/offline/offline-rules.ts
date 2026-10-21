import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import { stableJson } from '../../core/common/http/stable-json';
import { REASON_CODES } from '../../core/common/reasons';
import { instantOf } from '../../core/common/validation/instant';
import { normalizePlate } from '../../core/common/vehicle-plate';
import type { Refusal } from '../entries/subjects';
import { MATERIAL_DESCRIPTION } from '../permits/dto/permits.dto';
import {
  COMPANY_MAX,
  SERVICE_VEHICLE_KINDS,
} from '../service-vehicles/service-vehicle-rules';

// ============================================================================
// The gate offline's rules (ADR 0057), pure: what an upload says, when its
// actions happened, and what each conflict is flagged as.
// ============================================================================

const MINUTE = 60_000;

/** At most this many actions per batch. */
export const BATCH_MAX = 100;
/** How far a device's clock may wander before it is flagged (either way). */
export const SKEW_MS = 2 * MINUTE;

export const ACTION_TYPES = [
  'entry',
  'contractor',
  'service_vehicle_in',
  'service_vehicle_out',
  'material_entry',
  'patrol_scan',
  'child_exit',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** Who comes in or out on what the bundle carries. */
export const ENTRY_SUBJECTS = [
  'visitor_pass',
  'worker_engagement',
  'event_guest',
  'move_permit',
] as const;
export type OfflineEntrySubject = (typeof ENTRY_SUBJECTS)[number];

/**
 * How the device knew them: a typed code, a scanned QR, a plate, or a name
 * on an event's guest list.
 */
export const ENTRY_VIA = ['code', 'qr', 'plate', 'list'] as const;
export type EntryVia = (typeof ENTRY_VIA)[number];

/** Which `via` each subject comes in by. */
const VIA_OF: Record<OfflineEntrySubject, readonly EntryVia[]> = {
  visitor_pass: ['code', 'qr', 'plate'],
  worker_engagement: ['code', 'qr'],
  event_guest: ['plate', 'list'],
  move_permit: ['plate'],
};

export const PATROL_METHODS = ['qr', 'nfc', 'manual'] as const;

/** What every action carries. */
export interface ActionBase {
  /** The app's own UUIDv7 for the action: a retry answers the same. */
  clientId: string;
  /** The device's own count, from 1, for its whole life. */
  seq: number;
  /** When it happened, by the device's calibrated clock. */
  deviceTime: Date;
  /** The bundle it was decided with. */
  bundleId: string;
  type: ActionType;
  /** The SHA-256 of the action as sent: a retry must say the same. */
  contentSha256: string;
  /**
   * The action as sent, for a revoked device's quarantine: what the
   * management may accept later, less anything secret (`quarantineBody`).
   */
  raw: Record<string, unknown>;
}

/** Someone in or out on a pass, a worker card, a guest list or a truck. */
export interface EntryAction extends ActionBase {
  type: 'entry';
  subjectType: OfflineEntrySubject | 'permit_worker';
  subjectId: string;
  direction: 'in' | 'out';
  via: EntryVia;
}

/**
 * A contractor in or out on a works permit: the device knows the permit,
 * the server finds the worker by the last four of the ID shown.
 */
export interface ContractorAction extends ActionBase {
  type: 'contractor';
  permitId: string;
  direction: 'in' | 'out';
  /** Never stored: matched at sync, left out of a quarantine. */
  idLast4: string | null;
}

export interface ServiceVehicleInAction extends ActionBase {
  type: 'service_vehicle_in';
  plate: string;
  kind: (typeof SERVICE_VEHICLE_KINDS)[number];
  company: string;
  unitCode: string | null;
  facilityId: string | null;
}

/** Out by its plate: the device may not know the visit (another device's). */
export interface ServiceVehicleOutAction extends ActionBase {
  type: 'service_vehicle_out';
  plate: string;
}

export interface MaterialEntryAction extends ActionBase {
  type: 'material_entry';
  unitCode: string;
  permitId: string | null;
  description: string;
}

/** A checkpoint of a run started online, scanned offline (ADR 0052). */
export interface PatrolScanAction extends ActionBase {
  type: 'patrol_scan';
  runId: string;
  method: (typeof PATROL_METHODS)[number];
  payload: string | null;
  checkpointId: string | null;
  reasonCode: string | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
}

/**
 * A child under exit control leaving (ADR 0054): offline, alone with leave
 * or with a household adult whose ID the guard checked; anyone else the
 * device refuses (`released: false`).
 */
export interface ChildExitAction extends ActionBase {
  type: 'child_exit';
  controlId: string;
  escort: 'alone' | 'adult' | 'other';
  released: boolean;
  /** The adult's resident QR as scanned: checked at sync. */
  qr: string | null;
  /** The guard attests they checked the adult's ID (required to release). */
  idChecked: boolean;
}

export type OfflineAction =
  | ChildExitAction
  | EntryAction
  | ContractorAction
  | ServiceVehicleInAction
  | ServiceVehicleOutAction
  | MaterialEntryAction
  | PatrolScanAction;

export interface ParsedUpload {
  batchId: string;
  actions: OfflineAction[];
}

export interface PayloadProblem {
  field: string;
  code: 'FIELD_REQUIRED' | 'INVALID_VALUE' | 'INVALID_FORMAT';
}

const uuid = (v: unknown): v is string => typeof v === 'string' && isUUID(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);
const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s+/g, ' ');
  return t.length >= 1 && t.length <= max ? t : null;
};
const finite = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/**
 * An upload's payload (already signed and opened): its batch id and its
 * actions, ordered by `seq` (strictly increasing), or every problem by
 * field. Unknown fields are ignored: a newer app may send more.
 */
export function parseUpload(
  p: Record<string, unknown>,
  opts: { fromQuarantine?: boolean } = {},
): ParsedUpload | { problems: PayloadProblem[] } {
  const problems: PayloadProblem[] = [];
  const add = (field: string, code: PayloadProblem['code']) =>
    problems.push({ field, code });
  if (!uuid(p.batchId))
    add('batchId', p.batchId ? 'INVALID_FORMAT' : 'FIELD_REQUIRED');
  const raw = p.actions;
  if (!Array.isArray(raw) || !raw.length || raw.length > BATCH_MAX) {
    add('actions', Array.isArray(raw) ? 'INVALID_VALUE' : 'FIELD_REQUIRED');
    return { problems };
  }
  const actions: OfflineAction[] = [];
  let lastSeq = 0;
  const ids = new Set<string>();
  raw.forEach((a: unknown, i: number) => {
    const at = (f: string) => `actions.${i}.${f}`;
    if (a === null || typeof a !== 'object' || Array.isArray(a)) {
      add(`actions.${i}`, 'INVALID_VALUE');
      return;
    }
    const x = a as Record<string, unknown>;
    const before = problems.length;
    if (!uuid(x.clientId)) add(at('clientId'), 'INVALID_FORMAT');
    else if (ids.has(x.clientId)) add(at('clientId'), 'INVALID_VALUE');
    if (
      typeof x.seq !== 'number' ||
      !Number.isSafeInteger(x.seq) ||
      x.seq < 1 ||
      x.seq <= lastSeq
    )
      add(at('seq'), 'INVALID_VALUE');
    const deviceTime = instantOf(x.deviceTime);
    if (!deviceTime) add(at('deviceTime'), 'INVALID_FORMAT');
    if (!uuid(x.bundleId)) add(at('bundleId'), 'INVALID_FORMAT');
    if (!oneOf(ACTION_TYPES, x.type)) {
      add(at('type'), 'INVALID_VALUE');
      return;
    }
    const direction = (): 'in' | 'out' | null => {
      if (oneOf(['in', 'out'] as const, x.direction)) return x.direction;
      add(at('direction'), 'INVALID_VALUE');
      return null;
    };
    const base = (): ActionBase => ({
      clientId: x.clientId as string,
      seq: x.seq as number,
      deviceTime: deviceTime!,
      bundleId: x.bundleId as string,
      type: x.type as ActionType,
      contentSha256: actionHash(x),
      raw: x,
    });
    let action: OfflineAction | null = null;
    switch (x.type) {
      case 'entry': {
        const d = direction();
        if (!oneOf(ENTRY_SUBJECTS, x.subjectType))
          add(at('subjectType'), 'INVALID_VALUE');
        if (!uuid(x.subjectId)) add(at('subjectId'), 'INVALID_FORMAT');
        if (
          d === 'in' &&
          oneOf(ENTRY_SUBJECTS, x.subjectType) &&
          !(oneOf(ENTRY_VIA, x.via) && VIA_OF[x.subjectType].includes(x.via))
        )
          add(at('via'), 'INVALID_VALUE');
        if (problems.length === before)
          action = {
            ...base(),
            type: 'entry',
            subjectType: x.subjectType as OfflineEntrySubject,
            subjectId: x.subjectId as string,
            direction: d!,
            via: d === 'in' ? (x.via as EntryVia) : 'code',
          };
        break;
      }
      case 'contractor': {
        const d = direction();
        if (!uuid(x.permitId)) add(at('permitId'), 'INVALID_FORMAT');
        // A quarantine never kept it: its worker is not found, later.
        const kept = !(opts.fromQuarantine && x.idLast4 === undefined);
        const last4 =
          typeof x.idLast4 === 'string' ? x.idLast4.trim().toUpperCase() : '';
        if (kept && !/^[A-Z0-9]{4}$/.test(last4))
          add(at('idLast4'), 'INVALID_FORMAT');
        if (problems.length === before)
          action = {
            ...base(),
            type: 'contractor',
            permitId: x.permitId as string,
            direction: d!,
            idLast4: kept ? last4 : null,
          };
        break;
      }
      case 'service_vehicle_in': {
        const plate =
          typeof x.plate === 'string' ? normalizePlate(x.plate) : null;
        if (!plate) add(at('plate'), 'INVALID_FORMAT');
        if (!oneOf(SERVICE_VEHICLE_KINDS, x.kind))
          add(at('kind'), 'INVALID_VALUE');
        const company = text(x.company, COMPANY_MAX);
        if (!company) add(at('company'), 'INVALID_VALUE');
        const unitCode = x.unitCode === undefined ? null : text(x.unitCode, 32);
        if (x.unitCode !== undefined && !unitCode)
          add(at('unitCode'), 'INVALID_VALUE');
        if (x.facilityId !== undefined && !uuid(x.facilityId))
          add(at('facilityId'), 'INVALID_FORMAT');
        if (x.unitCode !== undefined && x.facilityId !== undefined)
          add(at('facilityId'), 'INVALID_VALUE');
        if (problems.length === before)
          action = {
            ...base(),
            type: 'service_vehicle_in',
            plate: plate!,
            kind: x.kind as ServiceVehicleInAction['kind'],
            company: company!,
            unitCode,
            facilityId: (x.facilityId as string | undefined) ?? null,
          };
        break;
      }
      case 'service_vehicle_out': {
        const plate =
          typeof x.plate === 'string' ? normalizePlate(x.plate) : null;
        if (!plate) add(at('plate'), 'INVALID_FORMAT');
        if (problems.length === before)
          action = { ...base(), type: 'service_vehicle_out', plate: plate! };
        break;
      }
      case 'material_entry': {
        const unitCode = text(x.unitCode, 32);
        if (!unitCode) add(at('unitCode'), 'INVALID_VALUE');
        if (x.permitId !== undefined && !uuid(x.permitId))
          add(at('permitId'), 'INVALID_FORMAT');
        const description = text(x.description, MATERIAL_DESCRIPTION.max);
        if (!description) add(at('description'), 'INVALID_VALUE');
        if (problems.length === before)
          action = {
            ...base(),
            type: 'material_entry',
            unitCode: unitCode!,
            permitId: (x.permitId as string | undefined) ?? null,
            description: description!,
          };
        break;
      }
      case 'child_exit': {
        if (!uuid(x.controlId)) add(at('controlId'), 'INVALID_FORMAT');
        if (!oneOf(['alone', 'adult', 'other'] as const, x.escort))
          add(at('escort'), 'INVALID_VALUE');
        if (typeof x.released !== 'boolean')
          add(at('released'), 'INVALID_VALUE');
        if (x.idChecked !== undefined && typeof x.idChecked !== 'boolean')
          add(at('idChecked'), 'INVALID_VALUE');
        const adult = x.escort === 'adult';
        if (adult && (typeof x.qr !== 'string' || !x.qr.startsWith('JWR2.')))
          add(at('qr'), 'INVALID_FORMAT');
        // Released with an adult only on the guard's word that they checked
        // the ID; anyone else is never released offline.
        if (x.released === true && adult && x.idChecked !== true)
          add(at('idChecked'), 'INVALID_VALUE');
        if (x.released === true && x.escort === 'other')
          add(at('released'), 'INVALID_VALUE');
        if (problems.length === before)
          action = {
            ...base(),
            type: 'child_exit',
            controlId: x.controlId as string,
            escort: x.escort as ChildExitAction['escort'],
            released: x.released as boolean,
            qr: adult ? (x.qr as string) : null,
            idChecked: x.idChecked === true,
          };
        break;
      }
      case 'patrol_scan': {
        if (!uuid(x.runId)) add(at('runId'), 'INVALID_FORMAT');
        if (!oneOf(PATROL_METHODS, x.method))
          add(at('method'), 'INVALID_VALUE');
        const manual = x.method === 'manual';
        if (manual && !uuid(x.checkpointId))
          add(at('checkpointId'), 'INVALID_FORMAT');
        if (manual && !oneOf(REASON_CODES.patrolManualScan, x.reasonCode))
          add(at('reasonCode'), 'INVALID_VALUE');
        if (!manual && (typeof x.payload !== 'string' || !x.payload.length))
          add(at('payload'), 'INVALID_FORMAT');
        const hasLat = x.lat !== undefined;
        const hasLng = x.lng !== undefined;
        if (hasLat !== hasLng || (hasLat && !(finite(x.lat) && finite(x.lng))))
          add(at('lat'), 'INVALID_VALUE');
        if (
          x.accuracyM !== undefined &&
          !(finite(x.accuracyM) && x.accuracyM >= 0)
        )
          add(at('accuracyM'), 'INVALID_VALUE');
        if (problems.length === before)
          action = {
            ...base(),
            type: 'patrol_scan',
            runId: x.runId as string,
            method: x.method as PatrolScanAction['method'],
            payload: manual ? null : (x.payload as string),
            checkpointId: manual ? (x.checkpointId as string) : null,
            reasonCode: manual ? (x.reasonCode as string) : null,
            lat: hasLat ? (x.lat as number) : null,
            lng: hasLng ? (x.lng as number) : null,
            accuracyM: (x.accuracyM as number | undefined) ?? null,
          };
        break;
      }
    }
    if (!action || problems.length > before) return;
    lastSeq = action.seq;
    ids.add(action.clientId);
    actions.push(action);
  });
  return problems.length
    ? { problems }
    : { batchId: p.batchId as string, actions };
}

/**
 * What a quarantined action keeps until the management decides (ADR
 * 0057): the action as sent, less what is secret or personal. A
 * contractor's ID last four is never kept: accepted later, the worker is
 * not found (`contractor_unresolved`).
 */
export function quarantineBody(a: ActionBase): Record<string, unknown> {
  const body = { ...a.raw };
  for (const field of QUARANTINE_OMIT) delete body[field];
  return body;
}
const QUARANTINE_OMIT: readonly string[] = ['idLast4'];

/** The SHA-256 of an action as sent, keys sorted. */
export const actionHash = (a: Record<string, unknown>): string =>
  createHash('sha256').update(stableJson(a)).digest('hex');

// ----------------------------------------------------------------------------
// When it happened
// ----------------------------------------------------------------------------

export interface WhenInput {
  deviceTime: Date;
  /** The device time of the action before it (its seq − 1), if received. */
  previousDeviceTime: Date | null;
  bundle: { issuedAt: Date; validUntil: Date };
  receivedAt: Date;
  /** The bundle's shift's end, by the server, if it ended. */
  shiftEndedAt: Date | null;
}

export interface When {
  /** What the entry is recorded at: the device's time, clamped. */
  occurredAt: Date;
  flags: ('clock_skew' | 'bundle_expired' | 'shift_ended')[];
  /** By how much the device's time was moved, when it was. */
  skewMs: number | null;
}

/**
 * The instant an action is recorded at (ADR 0057): the device's
 * calibrated time, clamped between its bundle's issue (less two minutes)
 * and the server's receipt. Clamped, or more than two minutes before the
 * action before it: `clock_skew`. Past its bundle's validity (two minutes
 * of grace): `bundle_expired` — the device must not decide with one. After
 * its shift's end by the server: `shift_ended`.
 */
export function whenOf(w: WhenInput): When {
  const flags: When['flags'] = [];
  const low = w.bundle.issuedAt.getTime() - SKEW_MS;
  const high = w.receivedAt.getTime();
  const t = w.deviceTime.getTime();
  const at = Math.min(Math.max(t, low), high);
  const backwards =
    w.previousDeviceTime !== null &&
    w.previousDeviceTime.getTime() - t > SKEW_MS;
  if (at !== t || backwards) flags.push('clock_skew');
  if (at > w.bundle.validUntil.getTime() + SKEW_MS)
    flags.push('bundle_expired');
  if (w.shiftEndedAt && at > w.shiftEndedAt.getTime() + SKEW_MS)
    flags.push('shift_ended');
  return {
    occurredAt: new Date(at),
    flags,
    skewMs: at !== t ? t - at : null,
  };
}

// ----------------------------------------------------------------------------
// What a conflict is flagged as
// ----------------------------------------------------------------------------

export const FLAG_KINDS = [
  // Security: the keepers are told, critically.
  'lockdown_entered',
  'blocklist_ban_entered',
  'credential_banned',
  'once_only_reused',
  'action_rejected',
  // A revoked device's batch, quarantined: once per batch.
  'device_revoked_upload',
  // A contractor in on a permit, no worker of it matching the last four.
  'contractor_unresolved',
  // A child released offline whose escort, or leave, the server could not
  // verify (the household and the keepers alerted too).
  'child_exit_unverified',
  // The management's: told, not critically.
  'credential_revoked',
  'invalid_at_time',
  'capacity_exceeded',
  'clock_skew',
  'bundle_expired',
  'shift_ended',
  // A patrol's scan the run refused at sync (its window, its order, a
  // checkpoint reissued since).
  'patrol_scan_refused',
  // Kept for the record, nobody told.
  'blocklist_watch_entered',
  'already_inside',
  'exit_without_entry',
  // A service vehicle's plate inside already: the older visit closed.
  'duplicate_inside',
] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];
export type FlagClass = 'security' | 'manager' | 'info';

export const FLAG_CLASS: Record<FlagKind, FlagClass> = {
  lockdown_entered: 'security',
  blocklist_ban_entered: 'security',
  credential_banned: 'security',
  once_only_reused: 'security',
  action_rejected: 'security',
  device_revoked_upload: 'security',
  contractor_unresolved: 'security',
  child_exit_unverified: 'security',
  credential_revoked: 'manager',
  invalid_at_time: 'manager',
  capacity_exceeded: 'manager',
  clock_skew: 'manager',
  bundle_expired: 'manager',
  shift_ended: 'manager',
  patrol_scan_refused: 'manager',
  blocklist_watch_entered: 'info',
  already_inside: 'info',
  exit_without_entry: 'info',
  duplicate_inside: 'info',
};

/**
 * The flag of a subject's refusal at the instant it came in, judged now.
 * `used` and capacity are the counter's, not this; lockdowns and bans have
 * their own flags.
 */
export function refusalFlag(refusal: Refusal | null): FlagKind | null {
  switch (refusal) {
    case null:
    case 'used':
    case 'lockdown_active':
    case 'entry_blocked':
      return null;
    case 'banned':
    case 'work_stopped':
      return 'credential_banned';
    case 'not_yet_valid':
    case 'expired':
    case 'outside_schedule':
    case 'outside_work_hours':
    case 'day_off':
      return 'invalid_at_time';
    default:
      // Cancelled, suspended, ended, the host no longer inviting, taken
      // off a permit, not approved, revoked, unknown.
      return 'credential_revoked';
  }
}

/** Why an action is not recorded: it cannot have happened as said. */
export const REJECTIONS = [
  'bundle_unknown',
  'subject_unknown',
  // A revoked device's action the management did not accept.
  'quarantine_rejected',
  // No worker of the permit, or more than one, has those last four.
  'contractor_unresolved',
  // The patrol's run refused the scan (its code in the flag).
  'patrol_refused',
] as const;
export type Rejection = (typeof REJECTIONS)[number];

/** The flag a rejection raises: what cannot have happened, or its own. */
export const REJECTION_FLAG: Record<Rejection, FlagKind | null> = {
  bundle_unknown: 'action_rejected',
  subject_unknown: 'action_rejected',
  quarantine_rejected: null,
  contractor_unresolved: 'contractor_unresolved',
  patrol_refused: 'patrol_scan_refused',
};

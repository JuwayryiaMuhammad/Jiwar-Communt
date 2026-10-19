import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import { stableJson } from '../../core/common/http/stable-json';
import type { Refusal } from '../entries/subjects';

// ============================================================================
// The gate offline's rules (ADR 0057), pure: what an upload says, when its
// actions happened, and what each conflict is flagged as.
// ============================================================================

const MINUTE = 60_000;

/** At most this many actions per batch. */
export const BATCH_MAX = 100;
/** How far a device's clock may wander before it is flagged (either way). */
export const SKEW_MS = 2 * MINUTE;

export const ACTION_TYPES = ['entry'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ENTRY_SUBJECTS = ['visitor_pass', 'worker_engagement'] as const;
export type OfflineEntrySubject = (typeof ENTRY_SUBJECTS)[number];

export const ENTRY_VIA = ['code', 'qr'] as const;

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
}

/** Someone in or out on a pass or a worker card. */
export interface EntryAction extends ActionBase {
  type: 'entry';
  subjectType: OfflineEntrySubject;
  subjectId: string;
  direction: 'in' | 'out';
  via: (typeof ENTRY_VIA)[number];
}

export type OfflineAction = EntryAction;

export interface ParsedUpload {
  batchId: string;
  actions: OfflineAction[];
}

export interface PayloadProblem {
  field: string;
  code: 'FIELD_REQUIRED' | 'INVALID_VALUE' | 'INVALID_FORMAT';
}

const uuid = (v: unknown): v is string => typeof v === 'string' && isUUID(v);
const instant = (v: unknown): Date | null => {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

/**
 * An upload's payload (already signed and opened): its batch id and its
 * actions, ordered by `seq` (strictly increasing), or every problem by
 * field. Unknown fields are ignored: a newer app may send more.
 */
export function parseUpload(
  p: Record<string, unknown>,
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
    const deviceTime = instant(x.deviceTime);
    if (!deviceTime) add(at('deviceTime'), 'INVALID_FORMAT');
    if (!uuid(x.bundleId)) add(at('bundleId'), 'INVALID_FORMAT');
    if (!oneOf(ACTION_TYPES, x.type)) add(at('type'), 'INVALID_VALUE');
    else if (x.type === 'entry') {
      if (!oneOf(ENTRY_SUBJECTS, x.subjectType))
        add(at('subjectType'), 'INVALID_VALUE');
      if (!uuid(x.subjectId)) add(at('subjectId'), 'INVALID_FORMAT');
      if (!oneOf(['in', 'out'] as const, x.direction))
        add(at('direction'), 'INVALID_VALUE');
      if (x.direction === 'in' && !oneOf(ENTRY_VIA, x.via))
        add(at('via'), 'INVALID_VALUE');
    }
    if (problems.length > before) return;
    lastSeq = x.seq as number;
    ids.add(x.clientId as string);
    actions.push({
      clientId: x.clientId as string,
      seq: x.seq as number,
      deviceTime: deviceTime!,
      bundleId: x.bundleId as string,
      type: 'entry',
      subjectType: x.subjectType as OfflineEntrySubject,
      subjectId: x.subjectId as string,
      direction: x.direction as 'in' | 'out',
      via: x.direction === 'in' ? (x.via as 'code' | 'qr') : 'code',
      contentSha256: actionHash(x),
    });
  });
  return problems.length
    ? { problems }
    : { batchId: p.batchId as string, actions };
}

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
  // The management's: told, not critically.
  'credential_revoked',
  'invalid_at_time',
  'capacity_exceeded',
  'clock_skew',
  'bundle_expired',
  'shift_ended',
  // Kept for the record, nobody told.
  'blocklist_watch_entered',
  'already_inside',
  'exit_without_entry',
] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];
export type FlagClass = 'security' | 'manager' | 'info';

export const FLAG_CLASS: Record<FlagKind, FlagClass> = {
  lockdown_entered: 'security',
  blocklist_ban_entered: 'security',
  credential_banned: 'security',
  once_only_reused: 'security',
  action_rejected: 'security',
  credential_revoked: 'manager',
  invalid_at_time: 'manager',
  capacity_exceeded: 'manager',
  clock_skew: 'manager',
  bundle_expired: 'manager',
  shift_ended: 'manager',
  blocklist_watch_entered: 'info',
  already_inside: 'info',
  exit_without_entry: 'info',
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
export const REJECTIONS = ['bundle_unknown', 'subject_unknown'] as const;
export type Rejection = (typeof REJECTIONS)[number];

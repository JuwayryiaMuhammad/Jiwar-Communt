import { FieldErrorCode, type FieldError } from '../../core/common/errors';
import { normalizeIdNumber } from '../../core/common/id-number';
import { normalizePlate, PLATE_MAX } from '../../core/common/vehicle-plate';
import type { Refusal } from '../entries/subjects';

/** What the gate refused that a guard may ask the management about (ADR 0056). */
export const EXCEPTION_KINDS = [
  'worker_outside_hours',
  'visitor_without_pass',
  'unregistered_vehicle',
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export const EXCEPTION_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'withdrawn',
] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

/** A worker an exception may be about: a household's, or a contractor's. */
export type ExceptionWorkerType = 'worker_engagement' | 'permit_worker';

/** The longest visitor name kept, as a gate request's. */
export const VISITOR_NAME_MAX = 200;

/** `GX-000042`. */
export function exceptionReference(n: number): string {
  return `GX-${String(n).padStart(6, '0')}`;
}

export interface ExceptionInput {
  kind: ExceptionKind;
  unitCode?: string;
  worker?: { type: ExceptionWorkerType; id: string };
  visitorName?: string;
  vehiclePlate?: string;
  idNumber?: string;
}

/**
 * What each kind needs, and nothing else: a worker names the worker (its
 * unit is theirs); a visitor and a vehicle name the unit they came for; a
 * vehicle its plate. The plate and the ID number must normalize.
 */
export function inputProblems(input: ExceptionInput): FieldError[] {
  const fields: FieldError[] = [];
  const required = (field: string) =>
    fields.push({ field, code: FieldErrorCode.FIELD_REQUIRED });
  const notAllowed = (field: string) =>
    fields.push({ field, code: FieldErrorCode.FIELD_NOT_ALLOWED });
  if (input.kind === 'worker_outside_hours') {
    if (!input.worker) required('worker');
    if (input.unitCode !== undefined) notAllowed('unitCode');
    if (input.visitorName !== undefined) notAllowed('visitorName');
    if (input.vehiclePlate !== undefined) notAllowed('vehiclePlate');
    if (input.idNumber !== undefined) notAllowed('idNumber');
    return fields;
  } else {
    if (input.worker) notAllowed('worker');
    if (!input.unitCode?.trim()) required('unitCode');
    if (input.kind === 'unregistered_vehicle' && !input.vehiclePlate?.trim())
      required('vehiclePlate');
  }
  if (input.vehiclePlate?.trim() && !normalizePlate(input.vehiclePlate))
    fields.push({
      field: 'vehiclePlate',
      code: FieldErrorCode.INVALID_FORMAT,
      params: { maxLength: PLATE_MAX },
    });
  if (input.idNumber !== undefined && !normalizeIdNumber(input.idNumber))
    fields.push({ field: 'idNumber', code: FieldErrorCode.INVALID_FORMAT });
  return fields;
}

/**
 * The only refusals an exception waives, per worker: a household worker's
 * schedule; a contractor's compound work hours and days off (never their
 * permit's own window, nor their ID).
 */
export const WAIVABLE: Record<ExceptionWorkerType, readonly Refusal[]> = {
  worker_engagement: ['outside_schedule'],
  permit_worker: ['outside_work_hours', 'day_off'],
};

/**
 * As the deciders and the guard read it: a pending exception past its
 * deadline is expired, whether or not the sweep has written it yet.
 */
export function effectiveStatus(
  e: { status: string; answerBy: Date },
  now: Date,
): ExceptionStatus {
  if (e.status === 'pending' && e.answerBy.getTime() <= now.getTime())
    return 'expired';
  return e.status as ExceptionStatus;
}

/**
 * Why an exception does not let an entry in at `at` at `gateId`, or null:
 * approved, at its own gate, within its window, never used.
 */
export function entryRefusal(
  e: {
    status: string;
    gateId: string;
    decidedAt: Date | null;
    entryUntil: Date | null;
    usedAt: Date | null;
  },
  at: Date,
  gateId: string,
): Refusal | null {
  if (e.status !== 'approved' || !e.decidedAt || !e.entryUntil)
    return 'not_approved';
  if (e.usedAt) return 'used';
  if (e.gateId !== gateId) return 'wrong_gate';
  if (at.getTime() < e.decidedAt.getTime()) return 'not_approved';
  if (at.getTime() > e.entryUntil.getTime()) return 'expired';
  return null;
}

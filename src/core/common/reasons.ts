import { appError, ErrorCode, FieldErrorCode, type FieldError } from './errors';

/**
 * A reason for a rejection, revocation, freeze or suspension (Phase 2.2).
 *
 * - `code` comes from a closed list per action. It goes into the audit
 *   metadata, where it can never name anyone (ADR 0014).
 * - `text` is what the person is told. It lives on the record and in the
 *   notice, both erasable — never in the immutable trail.
 */
export interface ReasonInput {
  code?: string;
  text?: string;
}

export interface Reason<C extends string = string> {
  code: C;
  text: string;
}

export const REASON_TEXT_MAX = 1000;

/**
 * Both parts are required (`REASON_REQUIRED`); a code outside `allowed` is a
 * field error `INVALID_REASON_CODE`.
 */
export function requireReasonCode<C extends string>(
  input: ReasonInput | undefined,
  allowed: readonly C[],
): Reason<C> {
  const code = (input?.code ?? '').trim();
  const text = (input?.text ?? '').trim();
  const missing: FieldError[] = [
    ...(code
      ? []
      : [{ field: 'reasonCode', code: FieldErrorCode.FIELD_REQUIRED }]),
    ...(text ? [] : [{ field: 'reason', code: FieldErrorCode.FIELD_REQUIRED }]),
  ];
  if (missing.length) {
    throw appError.badRequest(
      ErrorCode.REASON_REQUIRED,
      'A reason is required',
      {
        fields: missing,
      },
    );
  }
  if (!(allowed as readonly string[]).includes(code)) {
    throw appError.badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Unknown reason code',
      {
        fields: [
          {
            field: 'reasonCode',
            code: FieldErrorCode.INVALID_REASON_CODE,
            params: { allowed: [...allowed] },
          },
        ],
      },
    );
  }
  if (text.length > REASON_TEXT_MAX) {
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Reason too long', {
      fields: [
        {
          field: 'reason',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { max: REASON_TEXT_MAX },
        },
      ],
    });
  }
  return { code: code as C, text };
}

/**
 * A code alone, for actions whose reason never reaches anyone as text (a
 * pass cancelled, a ticket declined): `REASON_REQUIRED` when missing, a
 * field error `INVALID_REASON_CODE` with `allowed` outside the list.
 */
export function requireReasonCodeOnly<C extends string>(
  code: string | undefined,
  allowed: readonly C[],
): C {
  if (!code)
    throw appError.badRequest(
      ErrorCode.REASON_REQUIRED,
      'A reason is required',
      {
        fields: [{ field: 'reasonCode', code: FieldErrorCode.FIELD_REQUIRED }],
      },
    );
  if (!(allowed as readonly string[]).includes(code))
    throw appError.badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Unknown reason code',
      {
        fields: [
          {
            field: 'reasonCode',
            code: FieldErrorCode.INVALID_REASON_CODE,
            params: { allowed: [...allowed] },
          },
        ],
      },
    );
  return code as C;
}

/**
 * The closed lists, one per action. Adding a code is a reviewed change: the
 * audit trail keeps every code ever used, forever.
 */
export const REASON_CODES = {
  occupancyEnd: ['moved_out', 'contract_ended', 'data_correction', 'other'],
  memberRemoval: ['moved_out', 'relation_ended', 'misconduct', 'other'],
  memberRejection: ['not_verified', 'not_a_member', 'other'],
  workerSuspend: ['leave', 'absence', 'misconduct', 'other'],
  workerEnd: ['work_finished', 'moved', 'misconduct', 'other'],
  workerReject: ['documents_invalid', 'not_verified', 'other'],
  workerBan: ['security', 'misconduct', 'fraud', 'other'],
  reviewFlag: ['deceased', 'separation', 'other'],
  reviewClear: ['resolved', 'data_correction', 'other'],
  householdEnd: ['unit_changed_hands', 'household_left', 'other'],
  memberRemovalByManagement: ['separation', 'data_correction', 'other'],
  permissionRevoke: ['misuse', 'no_longer_needed', 'security', 'other'],
  deferredActionDecline: ['not_needed', 'too_expensive', 'other'],
  complianceReport: ['document_review', 'report_received', 'other'],
  complianceClose: ['resolved', 'unfounded', 'other'],
  accountFreeze: ['phone_reassigned'],
  registrationReject: [
    'not_a_resident',
    'unit_mismatch',
    'duplicate',
    'documents_missing',
    'other',
  ],
  legalHold: ['litigation', 'regulator_request', 'financial_audit', 'other'],
  legalHoldRelease: ['resolved', 'other'],
  cardReissue: ['lost', 'compromised', 'other'],
  // A code only, never text (ADR 0028).
  visitorPassCancel: ['not_needed', 'plans_changed', 'other'],
  // Maintenance (ADR 0032). Codes only, except a rejection and a reopen,
  // whose note becomes a message in the ticket's thread.
  ticketReassign: ['technician_unavailable', 'workload', 'specialty', 'other'],
  ticketDecline: [
    'not_my_specialty',
    'unavailable',
    'needs_parts_or_tools',
    'unsafe',
    'other',
  ],
  ticketPriority: ['reassessed', 'safety_risk', 'reporter_request', 'other'],
  ticketCancel: [
    'duplicate',
    'resolved_without_visit',
    'reporter_request',
    'invalid',
    'other',
  ],
  ticketReject: [
    'not_fixed',
    'poor_quality',
    'damage_caused',
    'incomplete',
    'other',
  ],
  ticketReopen: ['problem_returned', 'not_fixed', 'other'],
  // Written by the system only: back to the queue.
  ticketRelease: ['escalated', 'technician_unavailable'],
  // Dispatch (ADR 0033): a dispatcher setting a technician's availability.
  availabilityChange: ['sick', 'leave', 'training', 'other'],
  // Written by the system only: why a technician became unavailable.
  availabilitySystem: [
    'account_deactivated',
    'account_frozen',
    'account_erased',
    'permission_lost',
  ],
  // Visits and the SLA (ADR 0034). A dispatcher correcting a ticket's
  // category.
  ticketCategory: ['misclassified', 'reassessed', 'other'],
  // Either side cancelling or rescheduling a visit.
  visitChange: [
    'schedule_conflict',
    'resident_request',
    'technician_request',
    'parts_unavailable',
    'other',
  ],
  // Written by the system only: why a visit ended or its consent was voided.
  visitSystem: [
    'technician_changed',
    'ticket_cancelled',
    'ticket_closed',
    'ticket_completed',
    'granter_left',
  ],
  // Written by the system only: why an SLA clock paused, resumed, was
  // retargeted or stopped.
  slaEvent: [
    'awaiting_resident',
    'awaiting_parts',
    'awaiting_confirmation',
    'rejected',
    'left_hold',
    'priority_changed',
    'category_changed',
    'ticket_cancelled',
    'sla_disabled',
  ],
} as const;

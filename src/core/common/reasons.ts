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
  // A manager closing a wage obligation (ADR 0037). A code only, never text.
  wageObligationSettle: [
    'household_payment_confirmed',
    'worker_confirmed',
    'nothing_owed',
  ],
  // Closing the underage `pay_in_full` obligation (ADR 0022): the wages are
  // owed in full, so "nothing owed" is not among them.
  wageObligationPayInFull: [
    'household_payment_confirmed',
    'worker_confirmed',
    'referred_to_authorities',
  ],
  accountFreeze: ['phone_reassigned'],
  /** The freeze an account asks for itself on an unusual login (ADR 0036). */
  accountFreezeSelf: ['login_not_me'],
  registrationReject: [
    'not_a_resident',
    'unit_mismatch',
    'duplicate',
    'documents_missing',
    'other',
  ],
  legalHold: ['litigation', 'regulator_request', 'financial_audit', 'other'],
  legalHoldRelease: ['resolved', 'other'],
  // A manager acting for an account (ADR 0036): how the person asked.
  assist: ['in_person', 'phone_call', 'written_request'],
  // A manager closing a queued deletion without erasing (ADR 0036).
  deletionClose: ['blockers_unresolved', 'withdrawn', 'other'],
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
  // Written by the system only (ADR 0038): a visit proposed for the
  // residents, from the window their preventive request asked for.
  visitProposal: ['preventive_request'],
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
    'new_cycle',
  ],
  // Parcels (ADR 0035). A resident's "not mine", the system's end of a
  // delegate, and why a parcel went back to the carrier (derived).
  parcelReject: ['not_ours', 'not_expected', 'other'],
  parcelDelegateEnd: ['revoked', 'authorizer_left'],
  parcelReturn: ['rejected', 'unclaimed'],
  // Requests to the management (ADR 0039). How the resident reached the
  // management when staff open a request on their behalf.
  managementRequestOnBehalf: [
    'resident_phone_call',
    'resident_walk_in',
    'resident_written_letter',
  ],
  // Why staff close a request.
  managementRequestClose: [
    'resolved',
    'duplicate',
    'not_for_management',
    'other',
  ],
  // Written by the system only: the sweep's close and the author's own.
  managementRequestSystemClose: ['auto_closed', 'withdrawn_by_author'],
  // Why an appointment is cancelled, by each side; and by the system when
  // its request closes.
  managementAppointmentCancelByResident: [
    'no_longer_needed',
    'cannot_attend',
    'other',
  ],
  managementAppointmentCancelByStaff: [
    'staff_unavailable',
    'office_closed',
    'other',
  ],
  managementAppointmentSystemCancel: ['request_closed'],
  // Written by the system only: why a request went back to the queue.
  managementRequestRelease: [
    'account_deactivated',
    'account_frozen',
    'account_erased',
    'role_lost',
  ],
  // Community life (ADR 0040). Why the staff cancel an event.
  communityEventCancel: [
    'weather',
    'low_attendance',
    'venue_unavailable',
    'organizer_unavailable',
    'other',
  ],
  // Neighbours (ADR 0042). Why the staff dismiss a complaint against a
  // unit, and how they resolve one.
  neighbourComplaintDismiss: [
    'unfounded',
    'duplicate',
    'insufficient_evidence',
    'out_of_scope',
  ],
  neighbourComplaintResolve: ['complied', 'mediated', 'no_further_action'],
  // Written by the system only: the author's own withdrawal.
  neighbourComplaintSystemClose: ['withdrawn'],
  // Why an author closes their own post on a board, and why the staff take
  // one down.
  neighbourPostClose: ['resolved', 'no_longer_needed'],
  neighbourPostRemove: ['inappropriate', 'duplicate', 'not_allowed'],
  // Written by the system only: the item was handed over, or its author
  // left the compound or was erased.
  neighbourPostSystemClose: ['handed_over', 'author_left', 'author_erased'],
  // Why the staff decline a claim on a found item.
  neighbourClaimDecline: ['not_the_owner', 'insufficient_proof'],
  // Written by the system only: the item went to someone else, or its post
  // closed.
  neighbourClaimSystemDecline: ['handed_to_another', 'post_closed'],
  // Why a participant reports a masked conversation, and what the staff
  // did about it (`post_removed` takes the post down with the case).
  neighbourConversationReport: [
    'harassment',
    'spam',
    'scam',
    'inappropriate',
    'other',
  ],
  neighbourReportOutcome: ['no_action', 'warned', 'post_removed'],
  // Written by the system only: why a conversation closed. Never shown to
  // a participant.
  neighbourConversationSystemClose: [
    'blocked',
    'reported',
    'participant_left',
    'participant_erased',
  ],
  // Facilities and bookings (ADR 0044). Why a resident cancels their
  // unit's booking, why the staff cancel one, and why they reject one
  // waiting for approval.
  bookingResidentCancel: ['no_longer_needed', 'cannot_attend', 'other'],
  bookingStaffCancel: [
    'facility_unavailable',
    'rules_violation',
    'resident_request',
    'other',
  ],
  bookingReject: [
    'slot_unavailable',
    'not_eligible',
    'rules_violation',
    'other',
  ],
  // Written by the system only: the facility closed over the slot, the
  // approval did not come before the start, the booker left (moved out,
  // was deactivated, or erased: an erasure deactivates first).
  bookingSystemCancel: ['facility_closed', 'approval_expired', 'booker_left'],
  // Why a facility closes for a time, and why a closure is lifted early.
  facilityClosure: [
    'maintenance',
    'cleaning',
    'private_event',
    'weather',
    'other',
  ],
  facilityClosureLift: ['reopened_early', 'created_in_error', 'other'],
  // Why the staff lift a unit's suspension from booking.
  bookingSuspensionLift: ['staff_error', 'exception_granted', 'other'],
  // Why the accountant reverses a club payment recorded by mistake.
  clubPaymentReverse: ['entered_in_error', 'duplicate', 'refunded', 'other'],
  // Vehicles and parking (ADR 0045). Why the staff reject a vehicle, why a
  // resident removes one and why the staff do.
  vehicleReject: [
    'licence_missing',
    'licence_unreadable',
    'plate_mismatch',
    'not_resident_vehicle',
    'other',
  ],
  vehicleRemove: ['sold', 'no_longer_used', 'registered_in_error', 'other'],
  vehicleStaffRemove: [
    'permit_revoked',
    'vehicle_left_compound',
    'duplicate',
    'other',
  ],
  // Written by the system only: the registrant no longer holds `vehicles`
  // on the unit (left, deactivated or erased).
  vehicleSystemRemove: ['registrant_left'],
  // Why a visitor parking booking is cancelled, by each side. A resident
  // gives no reason; the system's: its pass was cancelled, its booker left.
  visitorParkingResidentCancel: ['no_longer_needed'],
  visitorParkingStaffCancel: ['area_closed', 'misuse', 'other'],
  visitorParkingSystemCancel: ['pass_cancelled', 'booker_left'],
} as const;

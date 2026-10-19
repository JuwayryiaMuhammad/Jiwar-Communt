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
  // Why the staff fine a unit; why they cancel a fine (`appeal_accepted`
  // when they accept its appeal); why the accountant reverses a payment.
  vehicleFineReason: [
    'parked_in_visitor_slot',
    'parked_in_others_slot',
    'blocking',
    'no_permit',
    'fire_lane',
    'other',
  ],
  vehicleFineCancel: [
    'appeal_accepted',
    'issued_in_error',
    'duplicate',
    'other',
  ],
  // The system's: the board overturned the decision (ADR 0055).
  vehicleFineSystemCancel: ['board_overturned'],
  vehicleFinePaymentReverse: ['entered_in_error', 'refunded', 'other'],
  // Why security closes a parking report without a fine.
  parkingReportClose: [
    'resolved',
    'vehicle_not_found',
    'duplicate',
    'not_a_violation',
  ],
  // The places every compound starts with (ADR 0047): keys, not reasons,
  // kept here so the dashboards share the list.
  placeKey: [
    'main_gate',
    'north_gate',
    'phase_a',
    'phase_b',
    'clubhouse',
    'parking',
    'other',
  ],
  // Why the reporter or the unit's primary cancels an emergency (ADR 0047):
  // optional.
  emergencyCancel: ['false_alarm', 'resolved_ourselves', 'other'],
  // How a responder or the management closes an emergency (ADR 0047).
  emergencyResolve: [
    'handled',
    'false_alarm',
    'transferred_ambulance',
    'transferred_civil_defense',
    'other',
  ],
  // Gate service requests (ADR 0047): what help, when, which lane, and why
  // security closes one.
  assistanceKind: ['wheelchair', 'walk_with', 'golf_cart', 'bags'],
  gateServiceWhen: ['now', 'in_15', 'in_30'],
  laneReason: ['ambulance', 'fire_truck', 'moving_truck', 'large_delivery'],
  gateServiceClose: [
    'done',
    'not_found',
    'no_show',
    'duplicate',
    'not_possible',
  ],
  // Why the staff credit part or all of an invoice (ADR 0046).
  creditNote: ['billing_error', 'waiver', 'duplicate', 'goodwill', 'other'],
  // A credit note the system writes, never picked by staff (ADR 0048): an
  // instalment plan closing an invoice or cancelling its instalments.
  creditNoteSystem: ['instalment_plan', 'dispute'],
  // Why a resident disputes an invoice (ADR 0048).
  invoiceDispute: [
    'already_paid',
    'wrong_amount',
    'not_my_unit',
    'service_not_provided',
    'duplicate_invoice',
    'other',
  ],
  // Why the manager reverses a refund (ADR 0048): the money is the unit's
  // credit again.
  refundReverse: ['entered_in_error', 'refund_failed', 'other'],
  // Why the staff reject a dispute (ADR 0048). `no_longer_owed`: a payment
  // started before the dispute paid the invoice meanwhile.
  invoiceDisputeReject: [
    'charge_is_correct',
    'payment_not_found',
    'outside_policy',
    'no_longer_owed',
    'other',
  ],
  // Why the office reverses a payment it recorded (ADR 0046).
  paymentReverse: ['entered_in_error', 'duplicate', 'bounced_cheque', 'other'],
  // A works permit's kind of work (ADR 0049).
  permitWorkType: ['renovation', 'finishing'],
  // Why the requester cancels a permit (ADR 0049); a reason is optional.
  unitPermitCancel: [
    'plans_changed',
    'dates_changed',
    'contractor_changed',
    'other',
  ],
  // A permit the system cancels, never picked by anyone (ADR 0049): its
  // requester left the unit, or nobody decided it in time.
  unitPermitSystemCancel: ['requester_left', 'not_decided'],
  // Why the management rejects a permit (ADR 0049).
  unitPermitReject: [
    'missing_details',
    'outside_rules',
    'too_many_guests',
    'safety_concern',
    'other',
  ],
  // Why the management revokes an approved permit (ADR 0049).
  unitPermitRevoke: ['rules_broken', 'safety_concern', 'complaint', 'other'],
  // Why the management removes a contractor worker (ADR 0049).
  permitWorkerRemove: ['misconduct', 'safety_concern', 'not_needed', 'other'],
  // Why the management cancels a guard's slot (ADR 0050).
  guardSlotCancel: [
    'schedule_change',
    'guard_unavailable',
    'post_closed',
    'other',
  ],
  // A slot the system cancels, never picked by staff (ADR 0050): its
  // template ended, or its guard left the compound's service.
  guardSlotCancelSystem: ['template_ended', 'guard_left'],
  // Who ended a roster template (ADR 0050): the management, or the system
  // when the guard left.
  guardTemplateEnd: ['manager', 'guard_left'],
  // How a guard's task ended (ADR 0050): an inspection all clear or with an
  // issue found; a custom task done.
  guardTaskOutcome: ['all_clear', 'issue_found', 'done'],
  // Why the management cancels a task (ADR 0050).
  guardTaskCancel: ['no_longer_needed', 'duplicate', 'unit_reopened', 'other'],
  // A task the system cancels: the guard it was for left.
  guardTaskCancelSystem: ['assignee_left'],
  // Why the roster's keepers reject a swap the colleague accepted (ADR 0050).
  guardSwapReject: ['staffing', 'too_late', 'other'],
  // What the system cancels a live swap for (ADR 0050): a slot cancelled,
  // a slot given to someone else or filled meanwhile, a guard gone.
  guardSwapCancel: ['slot_cancelled', 'slot_changed', 'guard_left'],
  // Why the manager ends a board member's seat (ADR 0051).
  boardMemberEnd: ['resigned', 'removed', 'misconduct', 'other'],
  // A seat the system ends, never picked by anyone (ADR 0051): the member
  // owns no unit any more, or their account was closed.
  boardMemberSystemEnd: ['no_longer_owner', 'account_closed'],
  // Why a poll is cancelled, by the board or the manager (ADR 0051).
  governancePollCancel: [
    'created_in_error',
    'superseded',
    'board_decision',
    'other',
  ],
  // Why an election is cancelled, by the board or the manager (ADR 0051).
  governanceElectionCancel: [
    'created_in_error',
    'postponed',
    'board_decision',
    'other',
  ],
  // An election the system cancels: nobody stood when voting opened.
  governanceElectionSystemCancel: ['no_candidates'],
  // Why the manager takes a candidate off the list before voting opens.
  governanceCandidateDisqualify: [
    'not_eligible',
    'statement_breaks_rules',
    'other',
  ],
  // A candidacy the system withdraws: the candidate owns no unit any more,
  // or their account was closed.
  governanceCandidateSystemWithdraw: ['no_longer_owner', 'account_closed'],
  // How the board resolved a tie across the last seat.
  governanceTieBreak: ['board_decision', 'lot_drawn'],
  // Board matters (ADR 0055).
  approvalWithdraw: [
    'no_longer_needed',
    'raised_in_error',
    'superseded',
    'other',
  ],
  expenseVoid: ['entered_in_error', 'duplicate', 'vendor_refund', 'other'],
  // Why the management cancels a scheduled patrol run (ADR 0052).
  patrolRunCancel: ['not_needed', 'post_closed', 'other'],
  // A scheduled run the system cancels, never picked by staff: its route
  // changed or was retired, or its post was out of service all its window.
  patrolRunCancelSystem: [
    'route_changed',
    'route_retired',
    'post_out_of_service',
  ],
  // Why a run under way ended before every checkpoint was scanned: the
  // guard ended it, or their shift ended.
  patrolRunEnd: ['guard', 'shift_ended'],
  // Why a guard scans a checkpoint by hand (ADR 0052).
  patrolManualScan: ['qr_damaged', 'qr_missing', 'nfc_unreadable', 'other'],
  // What a guard found at a checkpoint (ADR 0052).
  patrolNoteOutcome: ['all_clear', 'issue_found'],
  // Lockdown (ADR 0053): why a guard starts one, why the manager ends it,
  // and the emergency vehicle a guard lets through a locked gate.
  gateLockdownStart: [
    'security_threat',
    'intruder',
    'violence',
    'fire',
    'police_request',
    'drill',
    'other',
  ],
  gateLockdownEnd: ['threat_cleared', 'false_alarm', 'drill_over', 'other'],
  gateLockdownOverride: ['ambulance', 'fire_truck', 'police', 'civil_defense'],
  // The blocklist (ADR 0053): why a plate or a person is banned or watched,
  // and why the entry was lifted (the system lifts it once expired).
  blocklistReason: [
    'trespassing',
    'theft',
    'violence',
    'harassment',
    'fraud',
    'vandalism',
    'police_request',
    'management_decision',
    'other',
  ],
  blocklistLift: ['resolved', 'entered_in_error', 'other'],
  blocklistLiftSystem: ['expired'],
  // Why a guard or the permits' staff stopped a works permit's work (ADR
  // 0053).
  permitWorkStop: [
    'safety_hazard',
    'outside_hours',
    'noise_complaint',
    'unauthorized_work',
    'damage',
    'other',
  ],
  // Incidents (ADR 0053): what happened, how bad, and how it was closed.
  incidentType: [
    'injury',
    'near_miss',
    'hazard',
    'security_breach',
    'property_damage',
    'fire',
    'other',
  ],
  incidentSeverity: ['low', 'medium', 'high', 'critical'],
  incidentOutcome: [
    'resolved',
    'referred_to_police',
    'referred_to_management',
    'no_action_needed',
    'unfounded',
    'other',
  ],
  // Violations (ADR 0053): what the unit did, why one was cancelled, and why
  // a payment of one was reversed.
  violationKind: ['noise', 'waste', 'pets', 'contractor_hours', 'other'],
  violationCancel: ['appeal_accepted', 'issued_in_error', 'duplicate', 'other'],
  // The system's: the board overturned the decision (ADR 0055).
  violationSystemCancel: ['board_overturned'],
  violationPaymentReverse: ['entered_in_error', 'refunded', 'other'],
} as const;

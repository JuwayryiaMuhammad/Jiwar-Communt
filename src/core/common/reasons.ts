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
  /**
   * What the management asks a registrant to correct (ADR 0062): codes
   * only, never words (the registrant has no account to answer in), as
   * the request's CHECK repeats.
   */
  registrationCorrection: [
    'document_unreadable',
    'document_missing',
    'document_mismatch',
    'details_mismatch',
  ],
  /** Why a manager refuses a name or phone change (ADR 0062): a code only. */
  identityChangeReject: ['not_verified', 'does_not_match_documents', 'other'],
  /** Why a contract is voided, a renewal declined (ADR 0062): codes only. */
  contractVoid: ['data_error', 'wrong_file', 'other'],
  contractRenewalDecline: [
    'owner_declined',
    'dues_outstanding',
    'terms_not_agreed',
    'other',
  ],
  /** What a deposit is deducted or forfeited for (ADR 0062): codes only. */
  depositDeduction: [
    'unpaid_dues',
    'damage',
    'cleaning',
    'works_unfinished',
    'other',
  ],
  /** Why a move is cancelled (ADR 0063); `occupancy_ended` is the system's. */
  moveCancel: ['plans_changed', 'data_error', 'other'],
  /** Why a unit is handed over with no clearance (ADR 0063). */
  handoverWithoutClearance: ['dues_settle_later', 'dues_disputed', 'other'],
  /** Why an open inspection request is cancelled (ADR 0063). */
  inspectionRequestCancel: ['not_needed', 'unit_reopened', 'other'],
  /** What a failed works completion inspection found (ADR 0063). */
  worksFinding: [
    'works_unfinished',
    'common_areas_damaged',
    'debris_left',
    'safety_issue',
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
  // A quote declined by the residents (ADR 0058).
  ticketQuoteDecline: [
    'too_expensive',
    'not_needed',
    'own_arrangement',
    'other',
  ],
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
  // The system's: the board overturned the suspension (ADR 0055).
  bookingSuspensionSystemLift: ['board_overturned'],
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
  creditNote: [
    'billing_error',
    'waiver',
    'duplicate',
    'goodwill',
    'compensation',
    'other',
  ],
  // Why a compensation (ADR 0058): required exactly with `compensation`.
  creditNoteCompensation: [
    'service_outage',
    'maintenance_delay',
    'facility_closure',
    'other',
  ],
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
  // Field exceptions (ADR 0056): why the guard asks to let someone in, and
  // why the management said no.
  gateExceptionRaise: [
    'resident_unreachable',
    'expected_by_resident',
    'regular_visitor',
    'urgent_service',
    'delivery_waiting',
    'emergency',
    'other',
  ],
  gateExceptionReject: [
    'not_expected',
    'identity_unclear',
    'outside_policy',
    'other',
  ],
  // Offline flags (ADR 0057): what the management made of one.
  offlineFlagReview: ['confirmed', 'followed_up', 'false_alarm', 'other'],
  // Guard devices (ADR 0057): why the management revoked one.
  gateDeviceRevoke: [
    'lost',
    'stolen',
    'replaced',
    'retired',
    'compromised',
    'other',
  ],
  // Partners (ADR 0060): why the management suspends a partner. Residents
  // are told it is suspended, never why.
  partnerSuspend: [
    'quality_complaints',
    'licence_issue',
    'contract_ended',
    'partner_request',
    'safety',
    'other',
  ],
  // A request to a partner (ADR 0060): why the resident cancels it, why the
  // partner (on its desk, or the management relaying) declines or cancels
  // it, and the system's own reasons. A resident who declines a proposed
  // window closes it with `proposal_declined`, never picked from a list.
  partnerRequestResidentCancel: [
    'no_longer_needed',
    'found_another',
    'wrong_details',
    'other',
  ],
  partnerRequestDecline: ['unavailable', 'out_of_area', 'not_offered', 'other'],
  partnerRequestPartnerCancel: ['unavailable', 'emergency', 'other'],
  partnerRequestSystemCancel: ['partner_suspended', 'requester_left'],
  // A complaint against a partner (ADR 0060): what went wrong, what the
  // requester asks for, and what the management decided to arrange (a
  // credit note is issued in finance, by its own route: no money moves
  // here).
  partnerComplaint: [
    'no_show',
    'late',
    'poor_quality',
    'overcharged',
    'damage',
    'conduct',
    'other',
  ],
  partnerCompensationAsk: ['none', 'refund', 'redo', 'damages'],
  partnerCompensationDecision: [
    'none',
    'redo',
    'partner_refund',
    'credit_note',
  ],
  // Why a sitting member declines an owner's agenda proposal (ADR 0059).
  agendaDecline: ['out_of_scope', 'duplicate', 'not_now', 'other'],
  // The asset register (ADR 0064): why an asset is out of service, and why
  // it was retired. Codes only; the migration's CHECK repeats both.
  assetOutOfService: [
    'breakdown',
    'awaiting_parts',
    'safety',
    'scheduled_works',
    'other',
  ],
  assetRetire: [
    'replaced',
    'disposed',
    'sold',
    'transferred',
    'created_in_error',
    'other',
  ],
  // Maintenance plans (ADR 0064): why a due date moves, why one is skipped;
  // and the system's own reasons an occurrence ends (the migration's CHECK
  // repeats the last two).
  planDefer: [
    'access_unavailable',
    'parts_unavailable',
    'weather',
    'season',
    'vendor_delay',
    'other',
  ],
  planSkip: [
    'not_needed',
    'asset_out_of_service',
    'covered_by_other_work',
    'other',
  ],
  planOccurrenceSystem: ['ticket_cancelled', 'plan_ended'],
  planDeactivate: [
    'asset_replaced',
    'no_longer_needed',
    'contract_ended',
    'other',
  ],
  // Inspections (ADR 0064): why one is called off; the migration's CHECK
  // repeats the list.
  inspectionCancel: ['not_needed', 'duplicate', 'target_unavailable', 'other'],
  // A technician's recommendation to replace an asset, and why who keeps
  // the register declines one (ADR 0064); the migration's CHECKs repeat
  // both.
  replacementReason: [
    'end_of_life',
    'repeated_failures',
    'repair_uneconomic',
    'safety',
    'obsolete',
    'other',
  ],
  replacementDecline: ['repair_first', 'budget', 'not_needed', 'other'],
  // The maintenance store (ADR 0065): why a level is set by hand, why a
  // part request is declined or called off; the migration's CHECKs repeat
  // them.
  stockAdjust: [
    'count_correction',
    'damaged',
    'expired',
    'lost',
    'found',
    'other',
  ],
  partRequestDecline: ['out_of_stock', 'wrong_part', 'not_needed', 'other'],
  partRequestCancel: ['not_needed', 'found_elsewhere', 'other'],
  // A ticket's costs and its completion (ADR 0065): why an entry is voided,
  // what the technician did, why dispatch does not send a technician's
  // quote.
  ticketCostVoid: ['entered_in_error', 'duplicate', 'other'],
  ticketCompletionAction: [
    'repaired',
    'part_replaced',
    'adjusted',
    'cleaned',
    'no_fault_found',
    'referred_to_vendor',
    'other',
  ],
  quoteSuggestionDismiss: [
    'not_needed',
    'amount_wrong',
    'covered_by_contract',
    'other',
  ],
  // A maintenance contract ended before its date (ADR 0065).
  contractTerminate: [
    'vendor_performance',
    'replaced',
    'not_needed',
    'budget',
    'other',
  ],
  // Energy and utilities (ADR 0066): why a meter is retired, why a reading
  // is corrected, what an outage cuts and why one is called off; the
  // migrations' CHECKs repeat them.
  meterRetire: ['replaced', 'removed', 'faulty', 'other'],
  readingCorrect: ['misread', 'wrong_meter', 'wrong_day', 'other'],
  outageKind: ['water', 'electricity', 'gas', 'other'],
  outageCancel: ['not_needed', 'rescheduled', 'entered_in_error', 'other'],
} as const;

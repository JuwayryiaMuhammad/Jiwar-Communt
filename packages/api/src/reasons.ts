/**
 * Closed reason-code lists, mirrored from the backend's REASON_CODES
 * (src/core/common/reasons.ts). They are not in the OpenAPI contract; a code
 * outside the list comes back as INVALID_REASON_CODE with `allowed`.
 */
export const REASON_CODES = {
  occupancyEnd: ['moved_out', 'contract_ended', 'data_correction', 'other'],
  memberRejection: ['not_verified', 'not_a_member', 'other'],
  memberRemovalByManagement: ['separation', 'data_correction', 'other'],
  workerSuspend: ['leave', 'absence', 'misconduct', 'other'],
  workerEnd: ['work_finished', 'moved', 'misconduct', 'other'],
  workerReject: ['documents_invalid', 'not_verified', 'other'],
  workerBan: ['security', 'misconduct', 'fraud', 'other'],
  complianceClose: ['resolved', 'unfounded', 'other'],
  accountFreeze: ['phone_reassigned'],
  registrationReject: [
    'not_a_resident',
    'unit_mismatch',
    'duplicate',
    'documents_missing',
    'other',
  ],
  // Unit states and households (ADR 0021).
  reviewFlag: ['deceased', 'separation', 'other'],
  reviewClear: ['resolved', 'data_correction', 'other'],
  householdEnd: ['unit_changed_hands', 'household_left', 'other'],
  permissionRevoke: ['misuse', 'no_longer_needed', 'security', 'other'],
  // Workers (ADR 0017, 0022).
  complianceReport: ['document_review', 'report_received', 'other'],
  cardReissue: ['lost', 'compromised', 'other'],
  // A manager closing a wage obligation (ADR 0037): a code only.
  wageObligationSettle: ['household_payment_confirmed', 'worker_confirmed', 'nothing_owed'],
  // The underage `pay_in_full` obligation: owed in full, so never "nothing owed".
  wageObligationPayInFull: ['household_payment_confirmed', 'worker_confirmed', 'referred_to_authorities'],
  // Accounts (ADR 0023, 0036).
  legalHold: ['litigation', 'regulator_request', 'financial_audit', 'other'],
  legalHoldRelease: ['resolved', 'other'],
  // How the person asked the manager to act for them: a code only.
  assist: ['in_person', 'phone_call', 'written_request'],
  // A queued deletion closed without erasing: a code only.
  deletionClose: ['blockers_unresolved', 'withdrawn', 'other'],
  // A visitor pass cancelled by its host or the primary (ADR 0028): a code only.
  visitorPassCancel: ['not_needed', 'plans_changed', 'other'],
  // Maintenance (ADR 0032-0034): codes only, never text.
  ticketReassign: ['technician_unavailable', 'workload', 'specialty', 'other'],
  ticketPriority: ['reassessed', 'safety_risk', 'reporter_request', 'other'],
  ticketCancel: ['duplicate', 'resolved_without_visit', 'reporter_request', 'invalid', 'other'],
  ticketCategory: ['misclassified', 'reassessed', 'other'],
  availabilityChange: ['sick', 'leave', 'training', 'other'],
  visitChange: ['schedule_conflict', 'resident_request', 'technician_request', 'parts_unavailable', 'other'],
  // Requests to the management (ADR 0039): codes only, never text.
  managementRequestOnBehalf: ['resident_phone_call', 'resident_walk_in', 'resident_written_letter'],
  managementRequestClose: ['resolved', 'duplicate', 'not_for_management', 'other'],
  managementAppointmentCancelByStaff: ['staff_unavailable', 'office_closed', 'other'],
  // Community life (ADR 0040): codes only, never text.
  communityEventCancel: ['weather', 'low_attendance', 'venue_unavailable', 'organizer_unavailable', 'other'],
  // Neighbours (ADR 0042): codes only, never text.
  neighbourComplaintDismiss: ['unfounded', 'duplicate', 'insufficient_evidence', 'out_of_scope'],
  neighbourComplaintResolve: ['complied', 'mediated', 'no_further_action'],
  neighbourPostRemove: ['inappropriate', 'duplicate', 'not_allowed'],
  neighbourClaimDecline: ['not_the_owner', 'insufficient_proof'],
  neighbourReportOutcome: ['no_action', 'warned', 'post_removed'],
  // Facilities and bookings (ADR 0044): codes only, never text.
  bookingStaffCancel: ['facility_unavailable', 'rules_violation', 'resident_request', 'other'],
  bookingReject: ['slot_unavailable', 'not_eligible', 'rules_violation', 'other'],
  facilityClosure: ['maintenance', 'cleaning', 'private_event', 'weather', 'other'],
  facilityClosureLift: ['reopened_early', 'created_in_error', 'other'],
  bookingSuspensionLift: ['staff_error', 'exception_granted', 'other'],
  clubPaymentReverse: ['entered_in_error', 'duplicate', 'refunded', 'other'],
  vehicleReject: ['licence_missing', 'licence_unreadable', 'plate_mismatch', 'not_resident_vehicle', 'other'],
  vehicleRemove: ['sold', 'no_longer_used', 'registered_in_error', 'other'],
  vehicleStaffRemove: ['permit_revoked', 'vehicle_left_compound', 'duplicate', 'other'],
  vehicleSystemRemove: ['registrant_left'],
  visitorParkingResidentCancel: ['no_longer_needed'],
  visitorParkingStaffCancel: ['area_closed', 'misuse', 'other'],
  visitorParkingSystemCancel: ['pass_cancelled', 'booker_left'],
  vehicleFineReason: ['parked_in_visitor_slot', 'parked_in_others_slot', 'blocking', 'no_permit', 'fire_lane', 'other'],
  vehicleFineCancel: ['appeal_accepted', 'issued_in_error', 'duplicate', 'other'],
  vehicleFinePaymentReverse: ['entered_in_error', 'refunded', 'other'],
  parkingReportClose: ['resolved', 'vehicle_not_found', 'duplicate', 'not_a_violation'],
  // Emergencies and gate services (ADR 0047).
  placeKey: ['main_gate', 'north_gate', 'phase_a', 'phase_b', 'clubhouse', 'parking', 'other'],
  emergencyCancel: ['false_alarm', 'resolved_ourselves', 'other'],
  emergencyResolve: ['handled', 'false_alarm', 'transferred_ambulance', 'transferred_civil_defense', 'other'],
  assistanceKind: ['wheelchair', 'walk_with', 'golf_cart', 'bags'],
  gateServiceWhen: ['now', 'in_15', 'in_30'],
  laneReason: ['ambulance', 'fire_truck', 'moving_truck', 'large_delivery'],
  gateServiceClose: ['done', 'not_found', 'no_show', 'duplicate', 'not_possible'],
  creditNote: ['billing_error', 'waiver', 'duplicate', 'goodwill', 'other'],
  creditNoteSystem: ['instalment_plan', 'dispute'],
  invoiceDispute: ['already_paid', 'wrong_amount', 'not_my_unit', 'service_not_provided', 'duplicate_invoice', 'other'],
  refundReverse: ['entered_in_error', 'refund_failed', 'other'],
  invoiceDisputeReject: ['charge_is_correct', 'payment_not_found', 'outside_policy', 'no_longer_owed', 'other'],
  paymentReverse: ['entered_in_error', 'duplicate', 'bounced_cheque', 'other'],
  // Permits (ADR 0049).
  permitWorkType: ['renovation', 'finishing'],
  unitPermitCancel: ['plans_changed', 'dates_changed', 'contractor_changed', 'other'],
  unitPermitSystemCancel: ['requester_left', 'not_decided'],
  unitPermitReject: ['missing_details', 'outside_rules', 'too_many_guests', 'safety_concern', 'other'],
  unitPermitRevoke: ['rules_broken', 'safety_concern', 'complaint', 'other'],
  permitWorkerRemove: ['misconduct', 'safety_concern', 'not_needed', 'other'],
  guardSlotCancel: ['schedule_change', 'guard_unavailable', 'post_closed', 'other'],
  guardSlotCancelSystem: ['template_ended', 'guard_left'],
  guardTemplateEnd: ['manager', 'guard_left'],
  guardTaskOutcome: ['all_clear', 'issue_found', 'done'],
  guardTaskCancel: ['no_longer_needed', 'duplicate', 'unit_reopened', 'other'],
  guardTaskCancelSystem: ['assignee_left'],
  guardSwapReject: ['staffing', 'too_late', 'other'],
  guardSwapCancel: ['slot_cancelled', 'slot_changed', 'guard_left'],
  // Governance (ADR 0051).
  boardMemberEnd: ['resigned', 'removed', 'misconduct', 'other'],
  boardMemberSystemEnd: ['no_longer_owner', 'account_closed'],
  governancePollCancel: ['created_in_error', 'superseded', 'board_decision', 'other'],
  governanceElectionCancel: ['created_in_error', 'postponed', 'board_decision', 'other'],
  governanceElectionSystemCancel: ['no_candidates'],
  governanceCandidateDisqualify: ['not_eligible', 'statement_breaks_rules', 'other'],
  governanceCandidateSystemWithdraw: ['no_longer_owner', 'account_closed'],
  governanceTieBreak: ['board_decision', 'lot_drawn'],
} as const;

export type ReasonAction = keyof typeof REASON_CODES;

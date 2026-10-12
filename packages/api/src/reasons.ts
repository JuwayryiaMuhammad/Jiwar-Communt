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
} as const;

export type ReasonAction = keyof typeof REASON_CODES;

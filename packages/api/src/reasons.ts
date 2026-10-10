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
  // Maintenance (ADR 0032-0034): codes only, never text.
  ticketReassign: ['technician_unavailable', 'workload', 'specialty', 'other'],
  ticketPriority: ['reassessed', 'safety_risk', 'reporter_request', 'other'],
  ticketCancel: ['duplicate', 'resolved_without_visit', 'reporter_request', 'invalid', 'other'],
  ticketCategory: ['misclassified', 'reassessed', 'other'],
  availabilityChange: ['sick', 'leave', 'training', 'other'],
  visitChange: ['schedule_conflict', 'resident_request', 'technician_request', 'parts_unavailable', 'other'],
} as const;

export type ReasonAction = keyof typeof REASON_CODES;

/**
 * The audit catalog is covered by two suites, one scenario per entry:
 * - test/community/audit-coverage.e2e-spec.ts covers the entries listed here
 *   (Phase 2 entries: primary resident, household, delegation, workers,
 *   settings, self-service);
 * - test/community/audit-coverage-2-2.e2e-spec.ts covers PHASE_2_2_COVERAGE
 *   (the Phase 2.2 community completion);
 * - test/audit/audit-coverage.e2e-spec.ts covers every other entry.
 * Each suite fails when one of its entries has no scenario, and this list may
 * only name real catalog entries, so nothing can fall between the two.
 */
export const COMMUNITY_COVERAGE: readonly string[] = [
  'occupancy.primary_changed',
  'unit.household_review_flagged',
  'tenant.settings_changed',
  'household.invite_created',
  'household.invite_revoked',
  'household.invite_accepted',
  'household.member_added',
  'household.member_approved',
  'household.member_rejected',
  'household.member_removed',
  'invite.token_invalid',
  'household.delegation_created',
  'household.delegation_revoked',
  'household.delegation_ended',
  'account.locale_changed',
  'worker.registered',
  'worker.engagement_reviewed',
  'worker.code_reissued',
  'worker.engagement_suspended',
  'worker.engagement_resumed',
  'worker.engagement_ended',
  'worker.banned',
  'worker.unbanned',
  'worker.birth_date_attested',
  'worker.birth_date_corrected',
];

/** Phase 2.2 entries, covered by test/community/audit-coverage-2-2.e2e-spec.ts. */
export const PHASE_2_2_COVERAGE: readonly string[] = [
  'occupancy.converted',
  'occupancy.residence_changed',
  'occupancy.handed_over',
  'unit.closed_mode_changed',
  'unit.household_review_cleared',
  'unit.household_ended',
  'unit.ownership_transferred',
  'household.permissions_reviewed',
  'worker.wage_obligation_recorded',
  'household.member_majority_reached',
  'household.member_came_of_age',
  'worker.compliance_case_opened',
  'worker.compliance_case_closed',
  'worker.card_incident_reported',
  'worker.card_incident_closed',
  'account.frozen',
  'account.reactivated',
  'account.phone_reassigned',
  'unit.details_submitted',
  'registration_link.created',
  'registration_link.revoked',
  'resident.self_registered',
  'resident.registration_approved',
  'resident.registration_rejected',
  'resident.registration_expired',
  'registration.link_invalid',
  'account.deletion_requested',
  'account.deletion_cancelled',
  'account.legal_hold_placed',
  'account.legal_hold_released',
  'account.erased',
  'household.permission_granted',
  'household.permission_revoked',
  'household.deferred_action_submitted',
  'household.deferred_action_decided',
];

/** Phase 4 (the gate), covered by test/gate/audit-coverage.e2e-spec.ts. */
export const PHASE_4_COVERAGE: readonly string[] = [
  'gate.created',
  'gate.updated',
  'gate.shift_started',
  'gate.shift_ended',
  'gate.instructions_changed',
  'standing_instruction.created',
  'standing_instruction.deleted',
  'visitor_pass.created',
  'visitor_pass.cancelled',
  'visitor_pass.code_reissued',
  'entry_credential.issued',
  'entry_credential.revoked',
  'gate.approval_requested',
  'gate.approval_decided',
  'gate.approval_reversed',
  'gate.approval_withdrawn',
];

/** Files and worker photos (ADR 0029), covered by test/files/audit-coverage.e2e-spec.ts. */
export const FILES_COVERAGE: readonly string[] = [
  'file.created',
  'file.deleted',
  'worker.photo_changed',
  'account.photo_changed',
];

/**
 * The resident's screens (ADR 0037), covered by
 * test/community/audit-coverage-resident.e2e-spec.ts.
 */
export const RESIDENT_SCREENS_COVERAGE: readonly string[] = [
  'worker.wage_changed',
  'worker.wage_obligation_settled',
];

/** Maintenance (ADR 0032), covered by test/maintenance/audit-coverage.e2e-spec.ts. */
export const MAINTENANCE_COVERAGE: readonly string[] = [
  'ticket_category.created',
  'ticket_category.updated',
  'maintenance.settings_changed',
  'ticket.created_on_behalf',
  'ticket.priority_changed',
  'ticket.cancelled',
  // Dispatch (ADR 0033).
  'specialty.created',
  'specialty.updated',
  'ticket_category.specialties_changed',
  'technician.specialties_changed',
  'maintenance.dispatch_settings_changed',
  // Visits and the SLA (ADR 0034).
  'maintenance.sla_settings_changed',
  'ticket_category.sla_targets_changed',
  'ticket.category_changed',
  // The residents' escalation and the preventive services (ADR 0038).
  'ticket.escalated_by_resident',
  'preventive_service.created',
  'preventive_service.updated',
];

/** Parcels (ADR 0035), covered by test/parcels/audit-coverage.e2e-spec.ts. */
export const PARCELS_COVERAGE: readonly string[] = [
  'parcel.received',
  'parcel.settings_changed',
  'parcel.handed_over',
  'parcel.returned',
  'parcel.rejected',
  'parcel.delegate_authorized',
  'parcel.delegate_revoked',
];

/**
 * Preferences, consents, data export and account deletion (ADR 0036),
 * covered by test/privacy/audit-coverage.e2e-spec.ts.
 */
export const R1_COVERAGE: readonly string[] = [
  'notification_preferences.changed',
  'consent.granted',
  'consent.revoked',
  'step_up.requested',
  'step_up.verified',
  'step_up.failed',
  'login.new_device',
  'account.not_me',
  'account.deletion_queued',
  'account.deletion_closed',
  'data_export.requested',
  'data_export.ready',
  'data_export.downloaded',
  'data_export.expired',
  'data_export.failed',
];

/**
 * Requests to the management (ADR 0039), covered by
 * test/management/audit-coverage.e2e-spec.ts.
 */
export const MANAGEMENT_COVERAGE: readonly string[] = [
  'management_request_topic.created',
  'management_request_topic.updated',
  'management.settings_changed',
  'management.office_hours_changed',
  'management_request.created',
  'management_request.created_on_behalf',
  'management_request.assigned',
  'management_request.unassigned',
  'management_request.started',
  'management_request.answered',
  'management_request.resumed',
  'management_request.closed',
  'management_request.withdrawn',
  'management_request.auto_closed',
  'management_request.reopened',
  'management_request.escalated',
  'management_request.rated',
  'management_appointment.requested',
  'management_appointment.proposed',
  'management_appointment.confirmed',
  'management_appointment.cancelled',
];

/**
 * Community life (ADR 0040), covered by
 * test/engagement/audit-coverage.e2e-spec.ts.
 */
export const ENGAGEMENT_COVERAGE: readonly string[] = [
  'engagement.settings_changed',
  'suggestion_topic.created',
  'suggestion_topic.updated',
  'announcement.created',
  'announcement.changed',
  'announcement.edited',
  'announcement.published',
  'announcement.archived',
  'announcement.announced',
  'community_event.created',
  'community_event.changed',
  'community_event.cancelled',
  'community_event.rsvp_changed',
  'poll.created',
  'poll.changed',
  'poll.closed',
  'poll.cancelled',
  'poll.vote_cast',
  'suggestion.created',
  'suggestion.status_changed',
  'suggestion.responded',
  'suggestion.published',
  'suggestion.unpublished',
  'suggestion.done_noted',
  'suggestion.supported',
  'suggestion.unsupported',
];

/**
 * Neighbours (ADR 0042), covered by
 * test/neighbours/audit-coverage.e2e-spec.ts.
 */
export const NEIGHBOURS_COVERAGE: readonly string[] = [
  'neighbours.settings_changed',
  'neighbours.welcome_template_changed',
  'neighbour_complaint_category.created',
  'neighbour_complaint_category.updated',
  'neighbour_complaint.created',
  'neighbour_complaint.review_started',
  'neighbour_complaint.notice_sent',
  'neighbour_complaint.mediation_started',
  'neighbour_complaint.resolved',
  'neighbour_complaint.dismissed',
  'neighbour_complaint.withdrawn',
  'neighbour_post.created',
  'neighbour_post.closed',
  'neighbour_post.removed',
  'neighbour_item.handed_over',
  'neighbour_claim.created',
  'neighbour_claim.withdrawn',
  'neighbour_claim.declined',
  'neighbour_conversation.started',
  'neighbour_conversation.names_revealed',
  'neighbour_conversation.blocked',
  'neighbour_conversation.unblocked',
  'neighbour_conversation.reported',
  'neighbour_report.conversation_read',
  'neighbour_report.closed',
  'neighbour_welcome.sent',
];

/**
 * Facilities and bookings, the club (ADR 0044), covered by
 * test/facilities/audit-coverage.e2e-spec.ts.
 */
export const FACILITIES_COVERAGE: readonly string[] = [
  'facility.created',
  'facility.updated',
  'facility.hours_changed',
  'facility.peaks_changed',
  'booking.created',
  'booking.cancelled',
  'booking.approved',
  'booking.rejected',
  'booking.expired',
  'facility_closure.created',
  'facility_closure.lifted',
  'facility.settings_changed',
  'booking.no_show',
  'booking_suspension.started',
  'booking_suspension.lifted',
  'club_plan.created',
  'club_plan.updated',
  'club_membership.created',
  'club_membership.people_changed',
  'club_payment.recorded',
  'club_payment.reversed',
];

/** Vehicles and parking (ADR 0045): test/vehicles/audit-coverage. */
export const VEHICLES_COVERAGE: readonly string[] = [
  'vehicle.registered',
  'vehicle.updated',
  'vehicle.plate_changed',
  'vehicle.approved',
  'vehicle.rejected',
  'vehicle.renewed',
  'vehicle.removed',
  'vehicle.settings_changed',
  'parking_slot.created',
  'parking_slot.updated',
  'parking_slot.deleted',
  'visitor_parking_area.created',
  'visitor_parking_area.updated',
  'visitor_parking_booking.created',
  'visitor_parking_booking.cancelled',
  'gate.plate_lookup',
  'vehicle_fine.issued',
  'vehicle_fine.appealed',
  'vehicle_fine.appeal_decided',
  'vehicle_fine.cancelled',
  'vehicle_fine.payment_recorded',
  'vehicle_fine.payment_reversed',
  'parking_report.created',
  'parking_report.closed',
  'parking_report.converted',
];

/**
 * R6a and R6b entries (ADR 0046, 0048), covered by
 * test/finance/audit-coverage.e2e-spec.ts: the gateway, the platform's
 * step-up, invoices, billing plans, payments, sessions, instalment plans.
 */
export const FINANCE_COVERAGE: readonly string[] = [
  'platform.step_up_requested',
  'platform.step_up_verified',
  'platform.step_up_failed',
  'finance_gateway.set',
  'finance_gateway.toggled',
  'tenant.payment_gateway_set',
  'tenant.payment_gateway_toggled',
  'invoice_batch.issued',
  'credit_note.created',
  'billing_plan.created',
  'billing_plan.updated',
  'billing_plan.override_set',
  'billing_plan.override_removed',
  'payment.recorded',
  'payment.reversed',
  'payment_session.opened',
  'payment.webhook_rejected',
  'payment.order_mismatch',
  'payment.amount_mismatch',
  'payment.verification_contradicted',
  'payment.duplicate_charge',
  // R6b (ADR 0048).
  'instalment_plan.created',
  'instalment_plan.cancelled',
  'invoice_dispute.opened',
  'invoice_dispute.decided',
  'refund.recorded',
  'refund.reversed',
];

/**
 * G6a entries (ADR 0047), covered by test/safety/audit-coverage.e2e-spec.ts:
 * places, emergencies and gate service requests.
 */
export const SAFETY_COVERAGE: readonly string[] = [
  'place.created',
  'place.updated',
  'emergency.reported',
  'emergency.escalated',
  'emergency.cancelled',
  'emergency.family_on_my_way',
  'emergency.accepted',
  'emergency.arrived',
  'emergency.resolved',
  'gate_service.requested',
  'gate_service.cancelled',
  'gate_service.accepted',
  'gate_service.started',
  'gate_service.closed',
  'gate_service.text_cleared',
];

/**
 * G3 entries (ADR 0049), covered by test/permits/audit-coverage.e2e-spec.ts:
 * the compound's permit rules, a unit's permits, their contractors and
 * guests, the gate's side of them and the material entries log.
 */
export const PERMITS_COVERAGE: readonly string[] = [
  'permit_settings.changed',
  'unit_permit.requested',
  'unit_permit.cancelled',
  'unit_permit.worker_added',
  'unit_permit.worker_removed',
  'unit_permit.guests_changed',
  'unit_permit.approved',
  'unit_permit.rejected',
  'unit_permit.revoked',
  'unit_permit.lockout_cleared',
  'gate.permit_lookup',
  'unit_permit.used',
  'material_entry.logged',
  'unit_permit.text_cleared',
  'unit_permit.data_purged',
];

/** Guard shifts and tasks (ADR 0050): test/security/audit-coverage. */
export const GUARD_DUTY_COVERAGE: readonly string[] = [
  'guard_roster.template_created',
  'guard_roster.template_ended',
  'guard_roster.slot_created',
  'guard_roster.slot_cancelled',
  'guard_shift.late',
  'guard_shift.absent',
  'guard_handover_item.created',
  'guard_handover_item.updated',
  'guard_handover.recorded',
  'guard_handover.acknowledged',
  'guard_task.created',
  'guard_task.taken',
  'guard_task.completed',
  'guard_task.cancelled',
  'guard_task.carried',
  'guard_swap.requested',
  'guard_swap.accepted',
  'guard_swap.declined',
  'guard_swap.withdrawn',
  'guard_swap.approved',
  'guard_swap.rejected',
  'guard_swap.expired',
  'guard_swap.cancelled',
  'guard_instruction.issued',
  'guard_instruction.archived',
  'guard_instruction.acknowledged',
  'found_item.registered',
  'found_item.received',
  'found_item.claimed',
  'found_item.claimant_name_cleared',
  'guard_handover.notes_cleared',
  'guard_task.result_cleared',
  'guard_swap.reason_cleared',
];

/**
 * R7a entries (ADR 0051), covered by test/governance/audit-coverage.e2e-spec.ts:
 * the owners' board, its polls and elections, and the votes.
 */
export const GOVERNANCE_COVERAGE: readonly string[] = [
  'board_term.appointed',
  'board_term.ended',
  'board_member.added',
  'board_member.role_changed',
  'board_member.ended',
  'governance_poll.created',
  'governance_poll.changed',
  'governance_poll.opened',
  'governance_poll.cancelled',
  'governance_poll.closed',
  'governance.vote_cast',
  'governance_election.created',
  'governance_election.changed',
  'governance_election.opened',
  'governance_election.cancelled',
  'governance_election.closed',
  'governance_candidate.nominated',
  'governance_candidate.withdrawn',
  'governance_candidate.disqualified',
];

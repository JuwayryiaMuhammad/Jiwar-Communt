// ============================================================================
// Audit catalog (ADR 0014)
// ============================================================================
//
// Every state-changing action that is audited, and every security event.
// The target type comes from here, never from callers. `sensitive` lists
// fields of this action recorded only as `{ changed: true }`, on top of the
// global sensitive fields (see personal-data.ts).
//
// Adding an action? Emit it from src/ and cover it in
// test/audit/audit-coverage.e2e-spec.ts — tests fail otherwise.

export interface AuditActionDefinition {
  log: 'tenant' | 'platform';
  target: string;
  sensitive?: readonly string[];
}

export const AUDIT_ACTIONS = {
  'account.created': { log: 'tenant', target: 'account' },
  'account.status_changed': { log: 'tenant', target: 'account' },
  'account.locale_changed': { log: 'tenant', target: 'account' },
  // The account's own photo (ADR 0031): never a file id.
  'account.photo_changed': {
    log: 'tenant',
    target: 'account',
    sensitive: ['photo'],
  },
  'account.contact_changed': {
    log: 'tenant',
    target: 'account',
    sensitive: ['phone', 'email'],
  },
  'account.frozen': { log: 'tenant', target: 'account', sensitive: ['phone'] },
  // An account's own contact and identity changes (ADR 0062). metadata:
  // field, requestId, reasonCode (rejected); the name as changed only.
  'account.contact_change_requested': { log: 'tenant', target: 'account' },
  // A unit's vault (ADR 0062). metadata: unitId, kind, visibility, side
  // (added), reasonCode (deleted); never the title.
  'unit_document.added': { log: 'tenant', target: 'unit_document' },
  'unit_document.deleted': { log: 'tenant', target: 'unit_document' },
  // A unit's contracts (ADR 0062). metadata: unitId, kind, parties,
  // renewsId (recorded); reasonCode (voided, declined); contractId.
  // Clearances and deposits (ADR 0062). metadata: unitId, number, side
  // (issued); kind, amount (recorded); parts with codes (settled).
  'clearance.issued': { log: 'tenant', target: 'clearance' },
  'deposit.recorded': { log: 'tenant', target: 'deposit' },
  'deposit.refund_requested': { log: 'tenant', target: 'deposit' },
  'deposit.refund_withdrawn': { log: 'tenant', target: 'deposit' },
  'deposit.settled': { log: 'tenant', target: 'deposit' },
  // metadata: unitId, occupancyId, direction, side (system | resident | management).
  'unit_move.planned': { log: 'tenant', target: 'unit_move' },
  // metadata: unitId, step, side.
  'unit_move.step_done': { log: 'tenant', target: 'unit_move' },
  // metadata: unitId, direction, reasonCode (a handover with no clearance).
  'unit_move.done': { log: 'tenant', target: 'unit_move' },
  // metadata: unitId, direction, reasonCode, side.
  'unit_move.cancelled': { log: 'tenant', target: 'unit_move' },
  // metadata: unitId, scopes, expiresAt; never the invitee's details.
  'unit_proxy.invited': { log: 'tenant', target: 'unit_proxy' },
  // metadata: unitId, accountId. Actor: the system (the code proved the email).
  'unit_proxy.accepted': { log: 'tenant', target: 'unit_proxy' },
  // metadata: unitId, wasActive.
  'unit_proxy.revoked': { log: 'tenant', target: 'unit_proxy' },
  // metadata: unitId, wasActive, reasonCode (expired, invite_expired, household_ended, ...).
  'unit_proxy.ended': { log: 'tenant', target: 'unit_proxy' },
  // metadata: unitId, side (owner | proxy).
  'unit_inspection.requested': {
    log: 'tenant',
    target: 'unit_inspection_request',
  },
  // metadata: unitId, reasonCode (task_cancelled when its task was).
  'unit_inspection.cancelled': {
    log: 'tenant',
    target: 'unit_inspection_request',
  },
  // metadata: permitId, unitId, cycle.
  'permit_inspection.requested': {
    log: 'tenant',
    target: 'permit_inspection',
  },
  // metadata: permitId, cycle, photos, certificateNumber.
  'permit_inspection.passed': { log: 'tenant', target: 'permit_inspection' },
  // metadata: permitId, cycle, photos, findings (codes).
  'permit_inspection.failed': { log: 'tenant', target: 'permit_inspection' },
  'contract.recorded': { log: 'tenant', target: 'contract' },
  'contract.voided': { log: 'tenant', target: 'contract' },
  'contract_renewal.requested': { log: 'tenant', target: 'contract_renewal' },
  'contract_renewal.withdrawn': { log: 'tenant', target: 'contract_renewal' },
  'contract_renewal.declined': { log: 'tenant', target: 'contract_renewal' },
  'contract_renewal.renewed': { log: 'tenant', target: 'contract_renewal' },
  // metadata: kind, versionNo, hasFile, boardPublicationId (bylaws), told.
  'compound_document.published': {
    log: 'tenant',
    target: 'compound_document',
  },
  'account.identity_change_requested': { log: 'tenant', target: 'account' },
  'account.identity_change_cancelled': { log: 'tenant', target: 'account' },
  'account.identity_change_approved': { log: 'tenant', target: 'account' },
  'account.identity_change_rejected': { log: 'tenant', target: 'account' },
  'account.name_changed': {
    log: 'tenant',
    target: 'account',
    sensitive: ['fullName'],
  },
  'account.reactivated': { log: 'tenant', target: 'account' },
  // deletion (ADR 0023)
  'account.deletion_requested': { log: 'tenant', target: 'account' },
  'account.deletion_cancelled': { log: 'tenant', target: 'account' },
  'account.legal_hold_placed': { log: 'tenant', target: 'account' },
  'account.legal_hold_released': { log: 'tenant', target: 'account' },
  'account.erased': { log: 'tenant', target: 'account' },
  // Delivery preferences (ADR 0036): switches, quiet hours and a pause, as
  // codes and times; `metadata.assisted` when a manager acted for them.
  'notification_preferences.changed': { log: 'tenant', target: 'account' },
  // Consents (ADR 0036): the code and version, `assisted` and its reason;
  // a revocation by an erasure has reason `erasure`.
  'consent.granted': { log: 'tenant', target: 'account' },
  'consent.revoked': { log: 'tenant', target: 'account' },
  // Personal-data export (ADR 0036): ids, codes and counts, never content.
  'data_export.requested': { log: 'tenant', target: 'data_export' },
  'data_export.ready': { log: 'tenant', target: 'data_export' },
  'data_export.downloaded': { log: 'tenant', target: 'data_export' },
  'data_export.expired': { log: 'tenant', target: 'data_export' },
  'data_export.failed': { log: 'tenant', target: 'data_export' },
  // ADR 0036: blocked at execution, to the managers' queue (system), and
  // closed there by a manager with a reason code.
  'account.deletion_queued': { log: 'tenant', target: 'account' },
  'account.deletion_closed': { log: 'tenant', target: 'account' },
  'role.permissions_replaced': { log: 'tenant', target: 'role' },
  'role.permissions_synced': { log: 'tenant', target: 'role' },
  'occupancy.created': { log: 'tenant', target: 'occupancy' },
  'occupancy.ended': { log: 'tenant', target: 'occupancy' },
  'occupancy.primary_changed': { log: 'tenant', target: 'occupancy' },
  // capacities (ADR 0020)
  'occupancy.converted': { log: 'tenant', target: 'occupancy' },
  'occupancy.residence_changed': { log: 'tenant', target: 'occupancy' },
  'occupancy.handed_over': { log: 'tenant', target: 'occupancy' },
  'unit.closed_mode_changed': { log: 'tenant', target: 'unit' },
  // self-registration (ADR 0024)
  'unit.details_submitted': { log: 'tenant', target: 'unit' },
  'registration_link.created': { log: 'tenant', target: 'tenant' },
  'registration_link.revoked': { log: 'tenant', target: 'tenant' },
  'resident.self_registered': {
    log: 'tenant',
    target: 'resident_registration',
  },
  'resident.registration_approved': {
    log: 'tenant',
    target: 'resident_registration',
  },
  'resident.registration_rejected': {
    log: 'tenant',
    target: 'resident_registration',
  },
  'resident.registration_expired': {
    log: 'tenant',
    target: 'resident_registration',
  },
  // Registration documents and corrections (ADR 0062). metadata: codes
  // (asked), documentId and kind (added, removed), counts (resubmitted).
  'resident.registration_correction_requested': {
    log: 'tenant',
    target: 'resident_registration',
  },
  'resident.registration_resubmitted': {
    log: 'tenant',
    target: 'resident_registration',
  },
  'resident.registration_document_added': {
    log: 'tenant',
    target: 'resident_registration',
  },
  'resident.registration_document_removed': {
    log: 'tenant',
    target: 'resident_registration',
  },
  'unit.created': { log: 'tenant', target: 'unit' },
  'unit.household_review_flagged': { log: 'tenant', target: 'unit' },
  'unit.household_review_cleared': { log: 'tenant', target: 'unit' },
  'unit.household_ended': { log: 'tenant', target: 'unit' },
  'unit.ownership_transferred': { log: 'tenant', target: 'unit' },
  'household.permissions_reviewed': { log: 'tenant', target: 'unit' },
  'household.member_majority_reached': {
    log: 'tenant',
    target: 'household_member',
  },
  'household.member_came_of_age': { log: 'tenant', target: 'household_member' },
  'household.permission_granted': { log: 'tenant', target: 'household_member' },
  'household.permission_revoked': { log: 'tenant', target: 'household_member' },
  'household.deferred_action_submitted': {
    log: 'tenant',
    target: 'household_deferred_action',
  },
  'household.deferred_action_decided': {
    log: 'tenant',
    target: 'household_deferred_action',
  },
  'worker.wage_obligation_recorded': {
    log: 'tenant',
    target: 'worker_engagement',
  },
  // A manager closed it, with a reason code (ADR 0037).
  'worker.wage_obligation_settled': {
    log: 'tenant',
    target: 'worker_engagement',
  },
  // ADR 0037: set or cleared, never the amount.
  'worker.wage_changed': {
    log: 'tenant',
    target: 'worker_engagement',
  },
  // What the compound tells visitors (ADR 0030): changed, never the text.
  'tenant.settings_changed': {
    log: 'tenant',
    target: 'tenant',
    sensitive: [
      'visitorDirections',
      'emergencyPhone',
      'officePhone',
      'dutyPhone',
    ],
  },
  // household (ADR 0016)
  'household.invite_created': { log: 'tenant', target: 'household_invite' },
  'household.invite_revoked': { log: 'tenant', target: 'household_invite' },
  'household.invite_accepted': { log: 'tenant', target: 'household_invite' },
  'household.member_added': { log: 'tenant', target: 'household_member' },
  'household.member_approved': { log: 'tenant', target: 'household_member' },
  'household.member_rejected': { log: 'tenant', target: 'household_member' },
  'household.member_removed': { log: 'tenant', target: 'household_member' },
  'household.delegation_created': {
    log: 'tenant',
    target: 'household_delegation',
  },
  'household.delegation_revoked': {
    log: 'tenant',
    target: 'household_delegation',
  },
  'household.delegation_ended': {
    log: 'tenant',
    target: 'household_delegation',
  },
  // domestic workers (ADR 0017)
  // The photo is recorded as { changed: true } only (ADR 0029).
  'worker.registered': {
    log: 'tenant',
    target: 'worker_engagement',
    sensitive: ['photo'],
  },
  'worker.photo_changed': {
    log: 'tenant',
    target: 'domestic_worker',
    sensitive: ['photo'],
  },
  'worker.engagement_reviewed': {
    log: 'tenant',
    target: 'worker_engagement',
  },
  'worker.code_reissued': { log: 'tenant', target: 'worker_engagement' },
  'worker.engagement_suspended': {
    log: 'tenant',
    target: 'worker_engagement',
  },
  'worker.engagement_resumed': {
    log: 'tenant',
    target: 'worker_engagement',
  },
  'worker.engagement_ended': { log: 'tenant', target: 'worker_engagement' },
  'worker.banned': { log: 'tenant', target: 'domestic_worker' },
  'worker.unbanned': { log: 'tenant', target: 'domestic_worker' },
  'worker.birth_date_attested': { log: 'tenant', target: 'domestic_worker' },
  // the gate (ADR 0028)
  'gate.created': { log: 'tenant', target: 'gate' },
  'gate.updated': { log: 'tenant', target: 'gate' },
  'gate.shift_started': { log: 'tenant', target: 'guard_shift' },
  'gate.shift_ended': { log: 'tenant', target: 'guard_shift' },
  'gate.instructions_changed': { log: 'tenant', target: 'unit' },
  // No visitor name, phone or code ever goes into these.
  'visitor_pass.created': { log: 'tenant', target: 'visitor_pass' },
  'visitor_pass.cancelled': { log: 'tenant', target: 'visitor_pass' },
  'visitor_pass.code_reissued': { log: 'tenant', target: 'visitor_pass' },
  // The resident's entry QR (ADR 0031). Ids and a reason code only: never the
  // secret, never the device name. A resident's scan is not audited at all.
  'entry_credential.issued': { log: 'tenant', target: 'entry_credential' },
  'entry_credential.revoked': { log: 'tenant', target: 'entry_credential' },
  // A household's standing instructions (ADR 0043): the unit and the action,
  // never the description; a deletion says why (deleted, author_erased).
  'standing_instruction.created': {
    log: 'tenant',
    target: 'standing_instruction',
  },
  'standing_instruction.deleted': {
    log: 'tenant',
    target: 'standing_instruction',
  },
  'gate.approval_requested': { log: 'tenant', target: 'gate_approval_request' },
  // metadata.decisionSource: household, standing_instruction or timeout; a
  // standing instruction the guard applied adds metadata.instructionId.
  'gate.approval_decided': { log: 'tenant', target: 'gate_approval_request' },
  'gate.approval_reversed': { log: 'tenant', target: 'gate_approval_request' },
  'gate.approval_withdrawn': { log: 'tenant', target: 'gate_approval_request' },
  'worker.birth_date_corrected': { log: 'tenant', target: 'domestic_worker' },
  'worker.compliance_case_opened': { log: 'tenant', target: 'domestic_worker' },
  'worker.compliance_case_closed': { log: 'tenant', target: 'domestic_worker' },
  'worker.card_incident_reported': {
    log: 'tenant',
    target: 'worker_engagement',
  },
  'worker.card_incident_closed': { log: 'tenant', target: 'worker_engagement' },
  'tenant.created': { log: 'platform', target: 'tenant' },
  'tenant.status_changed': { log: 'platform', target: 'tenant' },
  'tenant.manager_added': { log: 'platform', target: 'account' },
  'platform_admin.created': { log: 'platform', target: 'platform_admin' },
  'platform_admin.password_changed': {
    log: 'platform',
    target: 'platform_admin',
  },
  // files (ADR 0029): purpose, type and size only, never a file name.
  'file.created': { log: 'tenant', target: 'file' },
  'file.deleted': { log: 'tenant', target: 'file' },
  // maintenance (ADR 0032). Admin actions only: a ticket's own status
  // changes and assignments are its append-only history. Never a
  // description, a common-area label, a comment, a note or a message.
  'ticket_category.created': { log: 'tenant', target: 'ticket_category' },
  'ticket_category.updated': { log: 'tenant', target: 'ticket_category' },
  'maintenance.settings_changed': { log: 'tenant', target: 'tenant' },
  // metadata: categoryKey, priority, location (unit | common_area).
  'ticket.created_on_behalf': { log: 'tenant', target: 'ticket' },
  // changes: priority; metadata: reasonCode.
  'ticket.priority_changed': { log: 'tenant', target: 'ticket' },
  // ADR 0034. changes: categoryKey; metadata: reasonCode.
  'ticket.category_changed': { log: 'tenant', target: 'ticket' },
  // metadata: reasonCode, by (reporter | dispatcher), fromStatus.
  'ticket.cancelled': { log: 'tenant', target: 'ticket' },
  // ADR 0038. changes: key, categoryKey, position, active by value; the
  // names as `{ changed: true }` only (codes and ids, never free text).
  'preventive_service.created': {
    log: 'tenant',
    target: 'preventive_service',
    sensitive: ['nameAr', 'nameEn'],
  },
  'preventive_service.updated': {
    log: 'tenant',
    target: 'preventive_service',
    sensitive: ['nameAr', 'nameEn'],
  },
  // ADR 0038. metadata: slaCycle, clocks (the overdue ones).
  'ticket.escalated_by_resident': { log: 'tenant', target: 'ticket' },
  // Quotes (ADR 0058). metadata: ticketId, amount; reasonCode on a decline.
  // The note as `{ changed: true }` only.
  'ticket_quote.proposed': {
    log: 'tenant',
    target: 'ticket_quote',
    sensitive: ['note'],
  },
  'ticket_quote.approved': { log: 'tenant', target: 'ticket_quote' },
  'ticket_quote.declined': { log: 'tenant', target: 'ticket_quote' },
  'ticket_quote.withdrawn': { log: 'tenant', target: 'ticket_quote' },
  // dispatch (ADR 0033). Codes and keys only, never a name.
  'specialty.created': { log: 'tenant', target: 'specialty' },
  'specialty.updated': { log: 'tenant', target: 'specialty' },
  // changes: specialties (the keys of the set, before and after).
  'ticket_category.specialties_changed': {
    log: 'tenant',
    target: 'ticket_category',
  },
  // target: the technician's account; changes: specialties (keys).
  'technician.specialties_changed': { log: 'tenant', target: 'account' },
  // changes: autoDispatchEnabled, the weights and the multipliers.
  'maintenance.dispatch_settings_changed': { log: 'tenant', target: 'tenant' },
  // visits and the SLA (ADR 0034). Visits are never audited: their window,
  // consent and receiver tell when a home is empty. Minutes and flags only.
  // changes: slaEnabled.
  'maintenance.sla_settings_changed': { log: 'tenant', target: 'tenant' },
  // changes: `<priority>.responseMinutes` / `<priority>.resolutionMinutes`.
  'ticket_category.sla_targets_changed': {
    log: 'tenant',
    target: 'ticket_category',
  },
  // parcels (ADR 0035). Ids, carrier, pieces, a reason code or a method:
  // never a name (the label's, a delegate's), a code, a token or a file id.
  'parcel.received': { log: 'tenant', target: 'parcel' },
  // metadata: reasonCode (not_ours, not_expected, other).
  // metadata: method (code, resident_qr, delegate); never who received it.
  'parcel.handed_over': { log: 'tenant', target: 'parcel' },
  'parcel.rejected': { log: 'tenant', target: 'parcel' },
  'parcel.delegate_authorized': { log: 'tenant', target: 'parcel' },
  // metadata: reasonCode (revoked, authorizer_left).
  'parcel.delegate_revoked': { log: 'tenant', target: 'parcel' },
  // changes: parcelReminderDays, parcelManagerDays.
  'parcel.settings_changed': { log: 'tenant', target: 'tenant' },
  // metadata: reasonCode (rejected, unclaimed).
  'parcel.returned': { log: 'tenant', target: 'parcel' },
  // requests to the management (ADR 0039). Ids, numbers, keys and reason
  // codes only: never a message, a note or a rating's comment.
  // changes: key, targetResponseHours, active by value; the names as
  // `{ changed: true }` only.
  'management_request_topic.created': {
    log: 'tenant',
    target: 'management_request_topic',
    sensitive: ['nameAr', 'nameEn'],
  },
  'management_request_topic.updated': {
    log: 'tenant',
    target: 'management_request_topic',
    sensitive: ['nameAr', 'nameEn'],
  },
  // metadata: requestNumber, type, topicKey, withUnit.
  'management_request.created': { log: 'tenant', target: 'management_request' },
  // The same, with reasonCode and authorId: the actor is the staff member.
  'management_request.created_on_behalf': {
    log: 'tenant',
    target: 'management_request',
  },
  // changes: assigneeId (from, to); metadata: requestNumber. When the
  // system took a request back from a handler who can no longer handle
  // it: reasonCode (account_deactivated, account_frozen, account_erased,
  // role_lost).
  'management_request.assigned': {
    log: 'tenant',
    target: 'management_request',
  },
  'management_request.unassigned': {
    log: 'tenant',
    target: 'management_request',
  },
  // A request's moves. metadata: requestNumber, cycle, and what moved it:
  // `by` (reply | start | appointment) or `fromStatus`. A message itself is
  // never audited: its row is its record, and it never changes.
  'management_request.started': { log: 'tenant', target: 'management_request' },
  'management_request.answered': {
    log: 'tenant',
    target: 'management_request',
  },
  'management_request.resumed': { log: 'tenant', target: 'management_request' },
  // The sweep's (actor: system), once per cycle. metadata: requestNumber,
  // cycle.
  'management_request.escalated': {
    log: 'tenant',
    target: 'management_request',
  },
  // The ends. metadata: requestNumber, cycle, fromStatus; a staff close
  // adds reasonCode. `auto_closed` is the sweep's (actor: system).
  'management_request.closed': { log: 'tenant', target: 'management_request' },
  'management_request.withdrawn': {
    log: 'tenant',
    target: 'management_request',
  },
  'management_request.auto_closed': {
    log: 'tenant',
    target: 'management_request',
  },
  // metadata: requestNumber, cycle (the new one), closeReason (what it was).
  'management_request.reopened': {
    log: 'tenant',
    target: 'management_request',
  },
  // metadata: requestNumber, cycle. Never the rating or its comment.
  'management_request.rated': { log: 'tenant', target: 'management_request' },
  // Appointments. target: the appointment. metadata: requestNumber, mode,
  // startsAt, and `replaces` (it took the place of another) or `by`
  // (resident | staff); a cancellation: reasonCode, by, fromStatus.
  'management_appointment.requested': {
    log: 'tenant',
    target: 'management_appointment',
  },
  'management_appointment.proposed': {
    log: 'tenant',
    target: 'management_appointment',
  },
  'management_appointment.confirmed': {
    log: 'tenant',
    target: 'management_appointment',
  },
  'management_appointment.cancelled': {
    log: 'tenant',
    target: 'management_appointment',
  },
  // changes: autoCloseDays, appointmentSlotMinutes, appointmentSlotCapacity.
  'management.settings_changed': { log: 'tenant', target: 'tenant' },
  // changes: windows, each as `<weekday>:<startMinute>-<endMinute>`.
  'management.office_hours_changed': { log: 'tenant', target: 'tenant' },
  // community life (ADR 0040). Ids, keys, dates and reason codes only:
  // never a title, a text, a place or a choice.
  // changes: eventMaxGuests.
  'engagement.settings_changed': { log: 'tenant', target: 'tenant' },
  // changes: key, active by value; the names as `{ changed: true }` only.
  // Announcements, works and closures among them. Never a title or a
  // text. changes: kind, priority, pinnedUntil, expiresAt,
  // audienceOccupancy, audienceBuildings, worksStartsAt, worksEndsAt,
  // worksAreaKind, worksGateId by value; worksPlace as `{ changed: true }`.
  'announcement.created': {
    log: 'tenant',
    target: 'announcement',
    sensitive: ['worksPlace'],
  },
  'announcement.changed': {
    log: 'tenant',
    target: 'announcement',
    sensitive: ['worksPlace'],
  },
  // New words or files: metadata: version, afterPublication.
  'announcement.edited': { log: 'tenant', target: 'announcement' },
  // metadata: publishAt, scheduled, fromStatus.
  'announcement.published': { log: 'tenant', target: 'announcement' },
  // metadata: fromStatus.
  'announcement.archived': { log: 'tenant', target: 'announcement' },
  // Its audience was told (important ones; the publisher's action, or the
  // sweep's as actor system). metadata: recipients, a count.
  'announcement.announced': { log: 'tenant', target: 'announcement' },
  // Events. changes: startsAt, endsAt, capacity, audienceOccupancy,
  // audienceBuildings, attachments (a count) by value; the words and the
  // place as `{ changed: true }`.
  'community_event.created': {
    log: 'tenant',
    target: 'community_event',
    sensitive: [
      'titleEn',
      'descriptionEn',
      'titleAr',
      'descriptionAr',
      'place',
    ],
  },
  'community_event.changed': {
    log: 'tenant',
    target: 'community_event',
    sensitive: [
      'titleEn',
      'descriptionEn',
      'titleAr',
      'descriptionAr',
      'place',
    ],
  },
  // metadata: reasonCode, fromStatus, told (how many were going and told).
  'community_event.cancelled': { log: 'tenant', target: 'community_event' },
  // The actor's own answer. metadata: response, guests, unitId, from.
  'community_event.rsvp_changed': { log: 'tenant', target: 'community_event' },
  // Polls. Never a choice: no action here, and no field of one, says what
  // a unit chose. changes: multiple, opensAt, closesAt, audienceOccupancy,
  // audienceBuildings, options (a count) by value; the question as
  // `{ changed: true }`; metadata of a change: optionsReplaced.
  'poll.created': {
    log: 'tenant',
    target: 'poll',
    sensitive: ['questionEn', 'questionAr'],
  },
  'poll.changed': {
    log: 'tenant',
    target: 'poll',
    sensitive: ['questionEn', 'questionAr'],
  },
  // The staff's, or the sweep's at the closing time (actor: system).
  // metadata: turnout, early.
  'poll.closed': { log: 'tenant', target: 'poll' },
  // metadata: fromStatus.
  'poll.cancelled': { log: 'tenant', target: 'poll' },
  // That a unit voted, and who cast it. metadata: unitId, changed.
  'poll.vote_cast': { log: 'tenant', target: 'poll' },
  // Suggestions. Never the resident's words, an answer, a summary or a
  // note. metadata of each: topicKey, withUnit (created); from, to,
  // withResponse (status_changed); status (responded); rewritten
  // (published); photos, a count (done_noted). A support is its account's
  // own act: the actor is the supporter.
  'suggestion.created': { log: 'tenant', target: 'suggestion' },
  'suggestion.status_changed': { log: 'tenant', target: 'suggestion' },
  'suggestion.responded': { log: 'tenant', target: 'suggestion' },
  'suggestion.published': { log: 'tenant', target: 'suggestion' },
  'suggestion.unpublished': { log: 'tenant', target: 'suggestion' },
  'suggestion.done_noted': { log: 'tenant', target: 'suggestion' },
  'suggestion.supported': { log: 'tenant', target: 'suggestion' },
  'suggestion.unsupported': { log: 'tenant', target: 'suggestion' },
  'suggestion_topic.created': {
    log: 'tenant',
    target: 'suggestion_topic',
    sensitive: ['nameAr', 'nameEn'],
  },
  'suggestion_topic.updated': {
    log: 'tenant',
    target: 'suggestion_topic',
    sensitive: ['nameAr', 'nameEn'],
  },
  // neighbours (ADR 0042). Ids, keys, statuses and reason codes only: never
  // a complaint's or a post's words, never who complained about whom.
  // changes: maxOpenComplaints, lostFoundExpiryDays, lendingExpiryDays,
  // maxOpenPosts, maxNewConversationsPerDay.
  'neighbours.settings_changed': { log: 'tenant', target: 'tenant' },
  // changes: key, active by value; the names as `{ changed: true }` only.
  'neighbour_complaint_category.created': {
    log: 'tenant',
    target: 'neighbour_complaint_category',
    sensitive: ['nameAr', 'nameEn'],
  },
  'neighbour_complaint_category.updated': {
    log: 'tenant',
    target: 'neighbour_complaint_category',
    sensitive: ['nameAr', 'nameEn'],
  },
  // metadata: complaintNumber, categoryKey, targetUnitId, withUnit. The
  // actor is the complainant: staff read it; the unit never reads the trail.
  'neighbour_complaint.created': {
    log: 'tenant',
    target: 'neighbour_complaint',
  },
  // metadata of every move: complaintNumber, from, to; reasonCode on an end.
  'neighbour_complaint.review_started': {
    log: 'tenant',
    target: 'neighbour_complaint',
  },
  // also: noticeId, recipientKind, recipients (a count). Never its text.
  'neighbour_complaint.notice_sent': {
    log: 'tenant',
    target: 'neighbour_complaint',
  },
  'neighbour_complaint.mediation_started': {
    log: 'tenant',
    target: 'neighbour_complaint',
  },
  'neighbour_complaint.resolved': {
    log: 'tenant',
    target: 'neighbour_complaint',
  },
  'neighbour_complaint.dismissed': {
    log: 'tenant',
    target: 'neighbour_complaint',
  },
  'neighbour_complaint.withdrawn': {
    log: 'tenant',
    target: 'neighbour_complaint',
  },
  // The boards. metadata: kind, side, photos (a count); reasonCode on an
  // end. Never a post's words or its place.
  'neighbour_post.created': { log: 'tenant', target: 'neighbour_post' },
  'neighbour_post.closed': { log: 'tenant', target: 'neighbour_post' },
  'neighbour_post.removed': { log: 'tenant', target: 'neighbour_post' },
  // also: claimId (or null for a walk-in), recipientAccountId.
  'neighbour_item.handed_over': { log: 'tenant', target: 'neighbour_post' },
  // metadata: postId; reasonCode when declined. Never the claimant's note.
  'neighbour_claim.created': { log: 'tenant', target: 'neighbour_claim' },
  'neighbour_claim.withdrawn': { log: 'tenant', target: 'neighbour_claim' },
  'neighbour_claim.declined': { log: 'tenant', target: 'neighbour_claim' },
  // Masked contact. A conversation's rows name the conversation and its
  // post, never its other side: the trail does not say who talks to whom.
  // metadata: postId, postKind.
  'neighbour_conversation.started': {
    log: 'tenant',
    target: 'neighbour_conversation',
  },
  'neighbour_conversation.names_revealed': {
    log: 'tenant',
    target: 'neighbour_conversation',
  },
  // metadata: conversationsClosed (a count).
  'neighbour_conversation.blocked': {
    log: 'tenant',
    target: 'neighbour_conversation',
  },
  'neighbour_conversation.unblocked': {
    log: 'tenant',
    target: 'neighbour_conversation',
  },
  // metadata: reportId, reasonCode. Never the reporter's note.
  'neighbour_conversation.reported': {
    log: 'tenant',
    target: 'neighbour_conversation',
  },
  // A staff member read the reported conversation of an open case.
  // metadata: conversationId.
  'neighbour_report.conversation_read': {
    log: 'tenant',
    target: 'neighbour_report',
  },
  // metadata: conversationId, outcome, postRemoved (0 or 1).
  'neighbour_report.closed': { log: 'tenant', target: 'neighbour_report' },
  // changes: enabled by value; each text as `{ changed: true }` only.
  'neighbours.welcome_template_changed': {
    log: 'tenant',
    target: 'tenant',
    sensitive: [
      'rulesEn',
      'officeHoursEn',
      'emergencyEn',
      'rulesAr',
      'officeHoursAr',
      'emergencyAr',
    ],
  },
  // metadata: unitId, occupancyId, accountId.
  'neighbour_welcome.sent': { log: 'tenant', target: 'neighbour_welcome' },
  // Facilities and bookings, the club (ADR 0044).
  // changes: mode, state, position and rules by value; names and
  // descriptions as `{ changed: true }` only.
  'facility.created': {
    log: 'tenant',
    target: 'facility',
    sensitive: ['nameEn', 'nameAr', 'descriptionEn', 'descriptionAr'],
  },
  'facility.updated': {
    log: 'tenant',
    target: 'facility',
    sensitive: ['nameEn', 'nameAr', 'descriptionEn', 'descriptionAr'],
  },
  // changes: windows as `weekday:start-end` codes.
  'facility.hours_changed': { log: 'tenant', target: 'facility' },
  'facility.peaks_changed': { log: 'tenant', target: 'facility' },
  // metadata: facilityId, unitId, status, peak, guests (a count), startsAt.
  // Never the booker's name.
  'booking.created': { log: 'tenant', target: 'booking' },
  // metadata: facilityId, unitId, from (the status), side, reasonCode, and
  // closureId when a closure cancelled it.
  'booking.cancelled': { log: 'tenant', target: 'booking' },
  // metadata: facilityId, unitId.
  'booking.approved': { log: 'tenant', target: 'booking' },
  // metadata: facilityId, unitId, reasonCode.
  'booking.rejected': { log: 'tenant', target: 'booking' },
  // By the system: nobody approved it before its start. metadata:
  // facilityId, unitId, reasonCode.
  'booking.expired': { log: 'tenant', target: 'booking' },
  // metadata: facilityId, reasonCode, startsAt, endsAt, cancelledCount.
  'facility_closure.created': { log: 'tenant', target: 'facility_closure' },
  // metadata: facilityId, reasonCode (the lift's).
  'facility_closure.lifted': { log: 'tenant', target: 'facility_closure' },
  // metadata: facilityId, unitId.
  'booking.no_show': { log: 'tenant', target: 'booking' },
  // metadata: unitId, triggerBookingId, noShowCount, endsAt.
  'booking_suspension.started': {
    log: 'tenant',
    target: 'booking_suspension',
  },
  // metadata: unitId, reasonCode.
  'booking_suspension.lifted': {
    log: 'tenant',
    target: 'booking_suspension',
  },
  // ADR 0067. metadata: accountId, facilityId, reasonCode, endsOn,
  // cancelledBookingIds (ids only), endedBanId when one had ended.
  'facility_ban.started': { log: 'tenant', target: 'facility_ban' },
  // metadata: accountId, facilityId, reasonCode (the lift's).
  'facility_ban.lifted': { log: 'tenant', target: 'facility_ban' },
  // changes: the no-show rules by value.
  'facility.settings_changed': { log: 'tenant', target: 'tenant' },
  // changes: duration, price and state by value; names as changed only.
  'club_plan.created': {
    log: 'tenant',
    target: 'club_plan',
    sensitive: ['nameEn', 'nameAr'],
  },
  'club_plan.updated': {
    log: 'tenant',
    target: 'club_plan',
    sensitive: ['nameEn', 'nameAr'],
  },
  // metadata: unitId, people (a count).
  'club_membership.created': { log: 'tenant', target: 'club_membership' },
  // metadata: unitId, added and removed (counts). Never who.
  'club_membership.people_changed': {
    log: 'tenant',
    target: 'club_membership',
  },
  // metadata: membershipId, unitId, planId, amount, currency, receiptNumber,
  // paidOn, periodStartsOn, periodEndsOn.
  'club_payment.recorded': { log: 'tenant', target: 'club_payment' },
  // metadata: membershipId, unitId, reversesId, reasonCode.
  'club_payment.reversed': { log: 'tenant', target: 'club_payment' },
  // Vehicles and parking (ADR 0045). Ids, codes, statuses and days by
  // value; a plate only as { changed: true } (`plate` is always
  // sensitive), never a name.
  // metadata: unitId, number, type, licencePhoto (boolean).
  'vehicle.registered': { log: 'tenant', target: 'vehicle' },
  // changes: makeAndModel, color, type, licencePhoto (a file id), plate
  // (changed only, when the same plate is typed differently); metadata: unitId.
  'vehicle.updated': { log: 'tenant', target: 'vehicle' },
  // changes: plate (changed only); metadata: unitId, previousStatus, version.
  'vehicle.plate_changed': { log: 'tenant', target: 'vehicle' },
  // metadata: unitId, stickerNumber, permitValidUntil, version.
  'vehicle.approved': { log: 'tenant', target: 'vehicle' },
  // metadata: unitId, reasonCode, version.
  'vehicle.rejected': { log: 'tenant', target: 'vehicle' },
  // metadata: unitId, from, to (local days).
  'vehicle.renewed': { log: 'tenant', target: 'vehicle' },
  // metadata: unitId, side, reasonCode, previousStatus.
  'vehicle.removed': { log: 'tenant', target: 'vehicle' },
  // changes: the three settings.
  'vehicle.settings_changed': { log: 'tenant', target: 'tenant' },
  // metadata: unitId, code, place.
  'parking_slot.created': { log: 'tenant', target: 'parking_slot' },
  // changes: code, place.
  'parking_slot.updated': { log: 'tenant', target: 'parking_slot' },
  // metadata: unitId, code.
  'parking_slot.deleted': { log: 'tenant', target: 'parking_slot' },
  // changes: name (changed only), capacity, active.
  'visitor_parking_area.created': {
    log: 'tenant',
    target: 'visitor_parking_area',
    sensitive: ['name'],
  },
  'visitor_parking_area.updated': {
    log: 'tenant',
    target: 'visitor_parking_area',
    sensitive: ['name'],
  },
  // metadata: unitId, areaId, visitorPassId, number, startsAt, endsAt.
  // Never the visitor's name.
  'visitor_parking_booking.created': {
    log: 'tenant',
    target: 'visitor_parking_booking',
  },
  // The guard's plate lookup, on their shift. metadata: vehicleIds,
  // passIds, permitIds (moves) and guestIds (ADR 0049), matches. Never the
  // plate, nor a hash of it.
  'gate.plate_lookup': { log: 'tenant', target: 'guard_shift' },
  // The guard's ID lookup against the blocklist (ADR 0053), on their shift.
  // metadata: entryIds, matches. Never the number, nor a hash of it.
  'gate.id_lookup': { log: 'tenant', target: 'guard_shift' },
  // metadata: unitId, areaId, side, reasonCode.
  'visitor_parking_booking.cancelled': {
    log: 'tenant',
    target: 'visitor_parking_booking',
  },
  // metadata: unitId, vehicleId, number, reason, amount, currency,
  // occurredOn, photo (boolean). Never the plate or the note.
  'vehicle_fine.issued': { log: 'tenant', target: 'vehicle_fine' },
  // metadata: unitId, photo (boolean). Never the appeal's words.
  'vehicle_fine.appealed': { log: 'tenant', target: 'vehicle_fine' },
  // metadata: unitId, decision, reasonCode.
  'vehicle_fine.appeal_decided': { log: 'tenant', target: 'vehicle_fine' },
  // metadata: unitId, reasonCode.
  'vehicle_fine.cancelled': { log: 'tenant', target: 'vehicle_fine' },
  // metadata: fineId, unitId, amount, currency, receiptNumber, paidOn.
  'vehicle_fine.payment_recorded': {
    log: 'tenant',
    target: 'vehicle_fine_payment',
  },
  // metadata: fineId, unitId, reversesId, reasonCode.
  'vehicle_fine.payment_reversed': {
    log: 'tenant',
    target: 'vehicle_fine_payment',
  },
  // metadata: number, note and photo (booleans). Never the plate, the
  // place or the note: the reporter is the actor, which only the
  // audit's readers see.
  'parking_report.created': { log: 'tenant', target: 'parking_report' },
  // metadata: reasonCode.
  'parking_report.closed': { log: 'tenant', target: 'parking_report' },
  // metadata: fineId. The fine's own rows never name the report.
  'parking_report.converted': { log: 'tenant', target: 'parking_report' },

  // Emergencies and gate services (ADR 0047).
  // changes: key, position and active by value; the names as changed.
  'place.created': {
    log: 'tenant',
    target: 'place',
    sensitive: ['nameEn', 'nameAr'],
  },
  'place.updated': {
    log: 'tenant',
    target: 'place',
    sensitive: ['nameEn', 'nameAr'],
  },
  // metadata: number, type, unitId, respondersNotified, familyNotified. The
  // reporter is the actor. A report that found one open is not recorded
  // again (nothing was written).
  'emergency.reported': { log: 'tenant', target: 'emergency' },
  // metadata: reason (timeout | no_responders), recipients. The actor is
  // the reporter for no_responders, the system for a timeout.
  'emergency.escalated': { log: 'tenant', target: 'emergency' },
  // metadata: from (the status), reasonCode (or null).
  'emergency.cancelled': { log: 'tenant', target: 'emergency' },
  // metadata: etaMinutes, gateId (null for a responder not at a gate).
  'emergency.accepted': { log: 'tenant', target: 'emergency' },
  // No metadata: the responder is the actor.
  'emergency.arrived': { log: 'tenant', target: 'emergency' },
  // metadata: from, reasonCode, side (responder | staff), note (a boolean:
  // never the words).
  'emergency.resolved': { log: 'tenant', target: 'emergency' },
  // metadata: number, kind, unitId, and per kind its codes and ids
  // (assistanceKind, memberId, whenCode, laneReason, gateId, place ids);
  // description, notes and photo as booleans. Never the words.
  'gate_service.requested': { log: 'tenant', target: 'gate_service_request' },
  // metadata: from (the status), side (requester | system), reasonCode.
  'gate_service.cancelled': { log: 'tenant', target: 'gate_service_request' },
  // The requester's erasure (metadata: description, notes, photo as
  // booleans: what went).
  'gate_service.text_cleared': {
    log: 'tenant',
    target: 'gate_service_request',
  },
  // metadata: etaMinutes (or null), gateId (the handler's shift, or null).
  'gate_service.accepted': { log: 'tenant', target: 'gate_service_request' },
  // No metadata: the handler is the actor.
  'gate_service.started': { log: 'tenant', target: 'gate_service_request' },
  // metadata: from, reasonCode, note (a boolean: never the words).
  'gate_service.closed': { log: 'tenant', target: 'gate_service_request' },
  // No metadata: the member is the actor.
  'emergency.family_on_my_way': { log: 'tenant', target: 'emergency' },

  // Finance (ADR 0046). The gateway's credentials are never recorded, not
  // even their last four characters: metadata names the fields that
  // changed (`fieldsChanged`) and the mode.
  'finance_gateway.set': { log: 'tenant', target: 'tenant' },
  // metadata: onlineEnabled.
  'finance_gateway.toggled': { log: 'tenant', target: 'tenant' },
  // The platform's side of the same (metadata as above; platformDisabled).
  'tenant.payment_gateway_set': { log: 'platform', target: 'tenant' },
  'tenant.payment_gateway_toggled': { log: 'platform', target: 'tenant' },
  // metadata: target, unitCount, kind, total (each invoice's), issuedOn,
  // dueOn, firstNumber, lastNumber; the unit for one unit. Never the
  // building's name or a line's words.
  'invoice_batch.issued': { log: 'tenant', target: 'invoice_batch' },
  // metadata: invoiceId, unitId, number, amount, released (paid money
  // given back to credit, ADR 0048), reasonCode.
  'credit_note.created': { log: 'tenant', target: 'credit_note' },
  // changes: kind, frequency, amount, days and state by value; names as
  // changed only.
  'billing_plan.created': {
    log: 'tenant',
    target: 'billing_plan',
    sensitive: ['nameEn', 'nameAr', 'descriptionEn', 'descriptionAr'],
  },
  // metadata on a new amount (ADR 0069): effectiveOn, decisionPublicationId.
  'billing_plan.updated': {
    log: 'tenant',
    target: 'billing_plan',
    sensitive: ['nameEn', 'nameAr', 'descriptionEn', 'descriptionAr'],
  },
  // metadata: unitId, amount or excluded (and the previous terms).
  'billing_plan.override_set': { log: 'tenant', target: 'billing_plan' },
  // metadata: unitId.
  'billing_plan.override_removed': { log: 'tenant', target: 'billing_plan' },
  // A spending report published (ADR 0069). metadata: budgetId, fiscalYear,
  // asOf, items (a count); never its words.
  'spending_report.published': { log: 'tenant', target: 'spending_report' },
  // A resident's payment plan request (ADR 0069). metadata: unitId,
  // invoiceId, months (asked) | planId (accepted) | reasonCode (declined).
  'plan_request.submitted': { log: 'tenant', target: 'plan_request' },
  'plan_request.withdrawn': { log: 'tenant', target: 'plan_request' },
  'plan_request.accepted': { log: 'tenant', target: 'plan_request' },
  'plan_request.declined': { log: 'tenant', target: 'plan_request' },
  // The plan terms for residents: the most months, the offer's floor.
  'finance.plan_settings_changed': { log: 'tenant', target: 'tenant' },
  // metadata: unitId, channel, method, amount, paidOn, receiptNumber, the
  // invoices named; never the transfer's or cheque's reference.
  'payment.recorded': { log: 'tenant', target: 'payment' },
  // metadata: paymentId, unitId, amount, reasonCode.
  'payment.reversed': { log: 'tenant', target: 'payment' },
  // metadata: unitId, amount, invoiceIds.
  'payment_session.opened': { log: 'tenant', target: 'payment_session' },

  // Finance part 2 (ADR 0048): codes, ids and amounts only.
  // metadata: unitId, invoiceId, number, count, total, creditNoteId, the
  // first and last instalment's due day.
  'instalment_plan.created': { log: 'tenant', target: 'instalment_plan' },
  // metadata: unitId, remainder, remainderInvoiceId, creditNoteIds.
  'instalment_plan.cancelled': { log: 'tenant', target: 'instalment_plan' },
  // metadata: unitId, invoiceId, reasonCode, photo (boolean). Never the
  // opener's words.
  'invoice_dispute.opened': { log: 'tenant', target: 'invoice_dispute' },
  // metadata: unitId, invoiceId, decision; amount, released and
  // creditNoteId on an acceptance, reasonCode on a rejection.
  'invoice_dispute.decided': { log: 'tenant', target: 'invoice_dispute' },
  // metadata: unitId, number, amount, channel, refundedOn, sourceCount;
  // never the reference.
  'refund.recorded': { log: 'tenant', target: 'refund' },
  // metadata: refundId, unitId, amount, reasonCode.
  'refund.reversed': { log: 'tenant', target: 'refund' },

  // Permits (ADR 0049). Ids, kinds, statuses, codes, dates and counts only:
  // never a name, a plate, a last 4 or what a resident or a guard wrote.
  // changes: workDays, workHours, daysOff by value.
  'permit_settings.changed': { log: 'tenant', target: 'tenant' },
  // metadata: number, kind, unitId, startsAt, endsAt, approvedAtOnce; works:
  // workType, dailyFrom, dailyTo, and contractorCompany and description as
  // booleans; move: window, truckPlate and itemsDescription as booleans;
  // material exit: itemCount, photo; event: title, guests (counts).
  'unit_permit.requested': { log: 'tenant', target: 'unit_permit' },
  // metadata: kind, unitId, from (the status), side (requester | system),
  // reasonCode.
  'unit_permit.cancelled': { log: 'tenant', target: 'unit_permit' },
  // metadata: kind, unitId, note (a boolean: never the words).
  'unit_permit.approved': { log: 'tenant', target: 'unit_permit' },
  // metadata: kind, unitId, reasonCode, note (a boolean).
  'unit_permit.rejected': { log: 'tenant', target: 'unit_permit' },
  // metadata: kind, unitId, reasonCode, note (a boolean).
  'unit_permit.revoked': { log: 'tenant', target: 'unit_permit' },
  // metadata: workerId, idType, workers (how many now). Never the name,
  // never the last four, not even hashed.
  'unit_permit.worker_added': { log: 'tenant', target: 'unit_permit' },
  // metadata: workerId, side (requester | management), reasonCode.
  'unit_permit.worker_removed': { log: 'tenant', target: 'unit_permit' },
  // metadata: added, removed, guests (how many now). Never a name or plate.
  'unit_permit.guests_changed': { log: 'tenant', target: 'unit_permit' },
  // A material exit's goods let out at a gate. metadata: kind, unitId,
  // gateId.
  'unit_permit.used': { log: 'tenant', target: 'unit_permit' },
  // A guard logs materials brought in. metadata: unitId, permitId, gateId;
  // never the guard's words.
  'material_entry.logged': { log: 'tenant', target: 'material_entry' },
  // The requester's erasure (metadata: kind, and contractorCompany,
  // description, itemsDescription, items, title, photo as booleans: what
  // went).
  'unit_permit.text_cleared': { log: 'tenant', target: 'unit_permit' },
  // The purge, 30 days after the end (system). metadata: kind, workers and
  // guests (how many), truckPlate and photo (booleans).
  'unit_permit.data_purged': { log: 'tenant', target: 'unit_permit' },
  // The management lifts a contractor ID lockout. metadata: workerId or
  // guardId.
  'unit_permit.lockout_cleared': { log: 'tenant', target: 'unit_permit' },
  // The guard's permit lookup, on their shift. metadata: by (unit,
  // reference or id), unitId, permitIds, matches. Never a name or a plate.
  'gate.permit_lookup': { log: 'tenant', target: 'guard_shift' },
  // Guard shifts and tasks (ADR 0050): ids, codes and counts only.
  // metadata: guardId, gateId or placeId, effectiveFrom, effectiveUntil,
  // slots (how many were made).
  'guard_roster.template_created': {
    log: 'tenant',
    target: 'guard_roster_template',
  },
  // metadata: reason (guardTemplateEnd), cancelled (its slots to come).
  'guard_roster.template_ended': {
    log: 'tenant',
    target: 'guard_roster_template',
  },
  // A single slot. metadata: guardId, gateId or placeId.
  'guard_roster.slot_created': { log: 'tenant', target: 'guard_roster_slot' },
  // metadata: reason (guardSlotCancel or guardSlotCancelSystem).
  'guard_roster.slot_cancelled': {
    log: 'tenant',
    target: 'guard_roster_slot',
  },
  // The shift opened more than ten minutes after its slot's start.
  // metadata: slotId, minutes.
  'guard_shift.late': { log: 'tenant', target: 'guard_shift' },
  // The slot was not opened an hour after its start (the sweep). metadata:
  // unmanned (nobody else on shift at the post), recipients.
  'guard_shift.absent': { log: 'tenant', target: 'guard_roster_slot' },
  // changes: position and active by value; the label as changed.
  'guard_handover_item.created': {
    log: 'tenant',
    target: 'guard_handover_item',
    sensitive: ['label'],
  },
  'guard_handover_item.updated': {
    log: 'tenant',
    target: 'guard_handover_item',
    sensitive: ['label'],
  },
  // metadata: shiftId, kind (guard, system), items (how many ticked), notes
  // (whether any; never the words).
  'guard_handover.recorded': { log: 'tenant', target: 'guard_handover' },
  // metadata: shiftId (the acknowledging guard's).
  'guard_handover.acknowledged': { log: 'tenant', target: 'guard_handover' },
  // metadata: kind, unitId (an inspection), guardId, gateId or placeId,
  // told (how many guards). Never the title or details.
  'guard_task.created': { log: 'tenant', target: 'guard_task' },
  // metadata: shiftId (the guard's open shift).
  'guard_task.taken': { log: 'tenant', target: 'guard_task' },
  // metadata: outcome, photos (how many), note (whether any).
  'guard_task.completed': { log: 'tenant', target: 'guard_task' },
  // metadata: reasonCode.
  'guard_task.cancelled': { log: 'tenant', target: 'guard_task' },
  // A shift's end moved it to the shift's post. metadata: shiftId, gateId
  // or placeId.
  'guard_task.carried': { log: 'tenant', target: 'guard_task' },
  // Swaps: ids and codes only, never the reason's words. metadata:
  // requesterSlotId, colleagueId, colleagueSlotId (or null), reason
  // (whether any).
  'guard_swap.requested': { log: 'tenant', target: 'guard_shift_swap' },
  'guard_swap.accepted': { log: 'tenant', target: 'guard_shift_swap' },
  'guard_swap.declined': { log: 'tenant', target: 'guard_shift_swap' },
  'guard_swap.withdrawn': { log: 'tenant', target: 'guard_shift_swap' },
  // metadata: requesterSlotId, colleagueSlotId (the slots given).
  'guard_swap.approved': { log: 'tenant', target: 'guard_shift_swap' },
  // metadata: reasonCode.
  'guard_swap.rejected': { log: 'tenant', target: 'guard_shift_swap' },
  // The system's. metadata: reason (guardSwapCancel) for a cancel.
  'guard_swap.expired': { log: 'tenant', target: 'guard_shift_swap' },
  'guard_swap.cancelled': { log: 'tenant', target: 'guard_shift_swap' },
  // metadata: audience, gateId or placeId, urgent, recipients (how many at
  // the send). Never the title or words.
  'guard_instruction.issued': { log: 'tenant', target: 'guard_instruction' },
  // metadata: recipients, acknowledged (counts at the archive).
  'guard_instruction.archived': {
    log: 'tenant',
    target: 'guard_instruction',
  },
  // The guard is the actor.
  'guard_instruction.acknowledged': {
    log: 'tenant',
    target: 'guard_instruction',
  },
  // The gate's lost and found. metadata: shiftId (or null at the office),
  // placeId, photos. Never the description.
  'found_item.registered': { log: 'tenant', target: 'found_item' },
  'found_item.received': { log: 'tenant', target: 'found_item' },
  // metadata: unitId (or null), name and note (whether any); never the
  // claimant's name.
  'found_item.claimed': { log: 'tenant', target: 'found_item' },
  // The retention sweep cleared the claimant's name (30 days).
  'found_item.claimant_name_cleared': { log: 'tenant', target: 'found_item' },
  // A guard's erasure: what they wrote goes, once each (ADR 0050).
  'guard_handover.notes_cleared': { log: 'tenant', target: 'guard_handover' },
  'guard_task.result_cleared': { log: 'tenant', target: 'guard_task' },
  'guard_swap.reason_cleared': { log: 'tenant', target: 'guard_shift_swap' },
  // Governance (ADR 0051). Ids, roles, codes, dates and counts only: never a
  // name, never a candidate's statement, and never what anyone chose, not
  // even on an open poll.
  // The manager seats a board. metadata: seats, startsAt, endsAt, members
  // ([{accountId, role}]), lapsedTermId (the term it replaced, if any).
  'board_term.appointed': { log: 'tenant', target: 'board_term' },
  // A term ended. metadata: reason (succeeded | replaced), byTermId.
  'board_term.ended': { log: 'tenant', target: 'board_term' },
  // A seat filled in a sitting term. metadata: termId, accountId, role,
  // source (appointed | elected).
  'board_member.added': { log: 'tenant', target: 'board_member' },
  // metadata: termId, accountId, from, to (roles).
  'board_member.role_changed': { log: 'tenant', target: 'board_member' },
  // metadata: termId, accountId, reasonCode, side (manager | system).
  'board_member.ended': { log: 'tenant', target: 'board_member' },
  // A poll put to the owners. changes: number, kind, ballot (secret | open), quorumPct,
  // thresholdPct, opensAt, closesAt, options (how many), the title and body
  // as "changed"; metadata: side (manager | board).
  'governance_poll.created': {
    log: 'tenant',
    target: 'governance_poll',
    sensitive: ['titleEn', 'titleAr', 'bodyEn', 'bodyAr'],
  },
  // Before it opened. changes: the same fields, the texts as "changed".
  'governance_poll.changed': {
    log: 'tenant',
    target: 'governance_poll',
    sensitive: ['titleEn', 'titleAr', 'bodyEn', 'bodyAr'],
  },
  // Voting opened (system or the creator). metadata: electorate, ballot.
  'governance_poll.opened': { log: 'tenant', target: 'governance_poll' },
  // metadata: fromStatus, reasonCode, side.
  'governance_poll.cancelled': { log: 'tenant', target: 'governance_poll' },
  // Counted at its closing time (system). metadata: result, turnout,
  // electorate. Never a count per option: the poll shows those.
  'governance_poll.closed': { log: 'tenant', target: 'governance_poll' },
  // A unit's vote on a poll or an election. metadata: kind, unitId. Never
  // a choice, on a secret contest or an open one.
  'governance.vote_cast': { log: 'tenant', target: 'governance_contest' },
  // An election put to the owners. changes: number, seats, termMonths, the
  // four dates, the title and body as "changed"; metadata: side.
  'governance_election.created': {
    log: 'tenant',
    target: 'governance_election',
    sensitive: ['titleEn', 'titleAr', 'bodyEn', 'bodyAr'],
  },
  // Before nominations opened. changes: the same fields.
  'governance_election.changed': {
    log: 'tenant',
    target: 'governance_election',
    sensitive: ['titleEn', 'titleAr', 'bodyEn', 'bodyAr'],
  },
  // Voting opened (system). metadata: electorate, candidates (how many).
  'governance_election.opened': {
    log: 'tenant',
    target: 'governance_election',
  },
  // metadata: fromPhase, reasonCode, side (manager | board | system).
  'governance_election.cancelled': {
    log: 'tenant',
    target: 'governance_election',
  },
  // Counted at its closing time (system). metadata: turnout, electorate,
  // elected and tied (how many), remaining (seats a tie leaves to fill).
  'governance_election.closed': {
    log: 'tenant',
    target: 'governance_election',
  },
  // An owner stands. metadata: electionId, statement (a boolean: never the
  // words).
  'governance_candidate.nominated': {
    log: 'tenant',
    target: 'governance_candidate',
  },
  // metadata: electionId, side (candidate | system), reasonCode.
  'governance_candidate.withdrawn': {
    log: 'tenant',
    target: 'governance_candidate',
  },
  // The manager takes a candidate off the list. metadata: electionId,
  // reasonCode.
  'governance_candidate.disqualified': {
    log: 'tenant',
    target: 'governance_candidate',
  },
  // The candidate's erasure: their statement went. metadata: electionId.
  'governance_candidate.statement_cleared': {
    log: 'tenant',
    target: 'governance_candidate',
  },
  // The manager certifies the count: the board it seats. metadata: termId,
  // elected ([candidate ids] seated), ineligible ([ids]: winners who own no
  // unit now, their seats left vacant), tied (how many), tieBreak ([ids]
  // the board chose), tieReasonCode.
  'governance_election.certified': {
    log: 'tenant',
    target: 'governance_election',
  },
  // A decision or the minutes of the board, published to the owners as an
  // announcement. metadata: kind, termId, announcementId, decidedOn,
  // attachment (a boolean), side. Never the words.
  'board_publication.published': {
    log: 'tenant',
    target: 'board_publication',
  },
  // metadata: kind, announcementId, side.
  'board_publication.archived': {
    log: 'tenant',
    target: 'board_publication',
  },
  // Board matters (ADR 0055): ids, codes, amounts, counts and outcomes.
  // A package's words, a motion's reasons and an appeal's grounds go in
  // as changed; a vote's choice never.
  // A decision package put to the board. changes: number, type, subjectId,
  // cost, deadlineAt, alternatives and attachments (how many), the context
  // and the impact as "changed".
  'governance_approval.raised': {
    log: 'tenant',
    target: 'governance_approval',
    sensitive: ['context', 'impact'],
  },
  // metadata: reasonCode, side (raiser | manager), motionId (the open
  // motion it closed, or null).
  'governance_approval.withdrawn': {
    log: 'tenant',
    target: 'governance_approval',
  },
  // A carried motion decided it. metadata: decision (approved | rejected),
  // motionId, implemented (a boolean: by the decision itself),
  // announcementId (an approved annual budget's, or null).
  'governance_approval.decided': {
    log: 'tenant',
    target: 'governance_approval',
  },
  // The manager marks an approved request implemented. metadata: note (a
  // boolean: never the words).
  'governance_approval.implemented': {
    log: 'tenant',
    target: 'governance_approval',
  },
  // The deadlines and thresholds. changes: `<type>.deadlineDays` and
  // `<type>.threshold`, as they changed.
  'governance_settings.changed': { log: 'tenant', target: 'tenant' },
  // A member proposes a motion. changes: matter (approval | appeal),
  // matterId, outcome, termId, memberId, the rationale and the
  // alternatives note as "changed".
  'board_motion.proposed': {
    log: 'tenant',
    target: 'board_motion',
    sensitive: ['rationale', 'alternativesNote'],
  },
  // A motion closed. metadata: result (carried | failed | withdrawn |
  // lapsed), votesFor, votesAgainst, sitting, quorum and chair (the seat
  // that breaks a tie, or null) for a count, by (vote | close | proposer |
  // matter | system).
  'board_motion.closed': { log: 'tenant', target: 'board_motion' },
  // A member's vote. metadata: memberId, voteId. Never the choice.
  'board_vote.cast': { log: 'tenant', target: 'board_motion' },
  // An appeal to the board. changes: number, kind, subjectId, unitId,
  // decisionAt, deadlineAt, attachments (how many), the grounds as changed.
  'governance_board_appeal.lodged': {
    log: 'tenant',
    target: 'governance_board_appeal',
    sensitive: ['grounds'],
  },
  // The appellant withdrew it. metadata: motionId (the open motion it
  // closed, or null).
  'governance_board_appeal.withdrawn': {
    log: 'tenant',
    target: 'governance_board_appeal',
  },
  // A carried motion decided it. metadata: outcome (upheld | overturned),
  // motionId, effect (applied | follow_up | none).
  'governance_board_appeal.decided': {
    log: 'tenant',
    target: 'governance_board_appeal',
  },
  // The manager followed an overturn up. No metadata.
  'governance_board_appeal.followed_up': {
    log: 'tenant',
    target: 'governance_board_appeal',
  },
  // The appellant's erasure: its grounds and attachments went. metadata:
  // attachments (how many files were marked deleted).
  'governance_board_appeal.grounds_cleared': {
    log: 'tenant',
    target: 'governance_board_appeal',
  },
  // The budget and expenses (ADR 0055): ids, codes, amounts and days; a
  // line's note, a vendor and a reference as changed.
  // metadata: fiscalYear, startsOn, endsOn, copiedFrom (a budget id or null).
  'budget.drafted': { log: 'tenant', target: 'budget' },
  // A draft's lines, replaced. changes: lines (how many), total; the notes
  // as changed.
  'budget.lines_replaced': {
    log: 'tenant',
    target: 'budget',
    sensitive: ['notes'],
  },
  // Put to the board. metadata: requestId, total.
  'budget.submitted': { log: 'tenant', target: 'budget' },
  // The board decided it (system, in the deciding vote's transaction).
  // metadata: requestId, status (active | rejected).
  'budget.decided': { log: 'tenant', target: 'budget' },
  // Its request was withdrawn. metadata: requestId.
  'budget.withdrawn': { log: 'tenant', target: 'budget' },
  // changes: fiscalYearStartMonth.
  'budget.settings_changed': { log: 'tenant', target: 'tenant' },
  // The cure period before a late-payment notice (ADR 0058). changes:
  // lateNoticeCureDays.
  'finance.notice_settings_changed': { log: 'tenant', target: 'tenant' },
  // An approved increase. metadata: budgetId, requestId, amount.
  'budget_line.increased': { log: 'tenant', target: 'budget_line' },
  // An approved major contract. metadata: requestId, amount.
  'expense_authorization.granted': {
    log: 'tenant',
    target: 'expense_authorization',
  },
  // changes: number, lineId, authorizationId, amount, spentOn, the vendor
  // and the reference as changed.
  'expense.recorded': {
    log: 'tenant',
    target: 'expense',
    sensitive: ['vendor', 'reference'],
  },
  // metadata: reasonCode.
  'expense.voided': { log: 'tenant', target: 'expense' },
  // Patrols (ADR 0052): ids, codes and counts. A checkpoint's names and
  // position go in as changed; its token and hash never.
  'patrol_checkpoint.created': {
    log: 'tenant',
    target: 'patrol_checkpoint',
    sensitive: ['nameEn', 'nameAr', 'lat', 'lng'],
  },
  'patrol_checkpoint.updated': {
    log: 'tenant',
    target: 'patrol_checkpoint',
    sensitive: ['nameEn', 'nameAr', 'lat', 'lng'],
  },
  'patrol_checkpoint.token_reissued': {
    log: 'tenant',
    target: 'patrol_checkpoint',
  },
  'patrol_checkpoint.retired': { log: 'tenant', target: 'patrol_checkpoint' },
  // A route's post by value, its names as changed; metadata: version,
  // checkpoints (how many), ordered, expectedMinutes, scheduled (whether),
  // runs (the scheduled runs made).
  'patrol_route.created': {
    log: 'tenant',
    target: 'patrol_route',
    sensitive: ['nameEn', 'nameAr'],
  },
  'patrol_route.renamed': {
    log: 'tenant',
    target: 'patrol_route',
    sensitive: ['nameEn', 'nameAr'],
  },
  // metadata: as created, and cancelledRuns (the scheduled runs nobody
  // started, made again from the new version).
  'patrol_route.versioned': { log: 'tenant', target: 'patrol_route' },
  // metadata: cancelledRuns.
  'patrol_route.retired': { log: 'tenant', target: 'patrol_route' },
  // metadata: kind, shiftId, late (whether).
  'patrol_run.started': { log: 'tenant', target: 'patrol_run' },
  // metadata: status, scanned, total, reason (for an incomplete one),
  // recipients (the keepers told).
  'patrol_run.ended': { log: 'tenant', target: 'patrol_run' },
  // metadata: reason (a patrolRunCancel code, or post_out_of_service).
  'patrol_run.cancelled': { log: 'tenant', target: 'patrol_run' },
  // The watch sweep. metadata: recipients.
  'patrol_run.late': { log: 'tenant', target: 'patrol_run' },
  'patrol_run.missed': { log: 'tenant', target: 'patrol_run' },
  // metadata: status, scanned, total, recipients.
  'patrol_run.timed_out': { log: 'tenant', target: 'patrol_run' },
  // The 30-day purge of the guards' track points, per compound (system):
  // no target. metadata: points (how many).
  'patrol_track.purged': { log: 'tenant', target: 'patrol_run' },
  // A guard's erasure (ADR 0052): their notes' words go, once each; where
  // they walked is deleted. metadata: points (how many).
  'patrol_note.text_cleared': { log: 'tenant', target: 'patrol_note' },
  'patrol_track.erased': { log: 'tenant', target: 'account' },
  // Security (ADR 0053).
  // A guard locked one gate or all down. metadata: scope (gate | all),
  // gateId (or null), reasonCode, shiftId, recipients (staff told),
  // residents (how many residents were told; 0 when one was live already).
  'gate_lockdown.started': { log: 'tenant', target: 'gate_lockdown' },
  // The management ended it. metadata: scope, gateId, reasonCode, note (a
  // boolean), recipients, residents.
  'gate_lockdown.ended': { log: 'tenant', target: 'gate_lockdown' },
  // An emergency vehicle let through a locked gate. metadata: overrideId,
  // gateId, shiftId, kind, emergencyId, gateServiceRequestId (or nulls).
  'gate_lockdown.override': { log: 'tenant', target: 'gate_lockdown' },
  // The blocklist (ADR 0053). Never a plate, a name, an ID number or its
  // hash, nor the note's words. metadata: kind, subject, reasonCode,
  // expiresAt, photo and note (booleans).
  'blocklist_entry.created': { log: 'tenant', target: 'blocklist_entry' },
  // metadata: changed (the field names), kind, reasonCode, expiresAt.
  'blocklist_entry.updated': { log: 'tenant', target: 'blocklist_entry' },
  // metadata: reasonCode.
  'blocklist_entry.lifted': { log: 'tenant', target: 'blocklist_entry' },
  // The system lifts an entry once its expiry passed. No metadata.
  'blocklist_entry.expired': { log: 'tenant', target: 'blocklist_entry' },
  // 30 days after a person's entry was lifted, its name, ID hash, photo and
  // note go (system). metadata: photo (whether there was one).
  'blocklist_entry.purged': { log: 'tenant', target: 'blocklist_entry' },
  // Stop work (ADR 0053). metadata: reasonCode, side (guard | staff),
  // shiftId (the guard's, or null), recipients.
  'permit_work.stopped': { log: 'tenant', target: 'unit_permit' },
  // metadata: stopId, recipients.
  'permit_work.resumed': { log: 'tenant', target: 'unit_permit' },
  // Incidents (ADR 0053). Never the description, a note's or the closing
  // note's words. metadata: number, type, severity, placeId, unitId,
  // shiftId, photos (how many), emergencyId, gateServiceRequestId,
  // patrolNoteId.
  'incident.reported': { log: 'tenant', target: 'incident' },
  // metadata: investigatorId, from (the previous one, or null).
  'incident.assigned': { log: 'tenant', target: 'incident' },
  // metadata: noteId.
  'incident.note_added': { log: 'tenant', target: 'incident' },
  // metadata: role (author | reviewer).
  'incident.acknowledged': { log: 'tenant', target: 'incident' },
  // metadata: outcome, from (the status).
  'incident.closed': { log: 'tenant', target: 'incident' },
  // An erasure (ADR 0053): what the account wrote goes, once. metadata:
  // description, closingNote (booleans: which went).
  'incident.text_cleared': { log: 'tenant', target: 'incident' },
  // An erasure: an internal note's words. metadata: incidentId.
  'incident_note.text_cleared': { log: 'tenant', target: 'incident_note' },
  // Violations (ADR 0053), as the fines. metadata: unitId, permitId,
  // placeId, number, kind, amount (or null: a warning), currency,
  // occurredOn, shiftId, photo and note (booleans).
  'violation.issued': { log: 'tenant', target: 'unit_violation' },
  // metadata: unitId, photo (a boolean). Never the appeal's words.
  'violation.appealed': { log: 'tenant', target: 'unit_violation' },
  // metadata: unitId, decision, reasonCode (or null).
  'violation.appeal_decided': { log: 'tenant', target: 'unit_violation' },
  // metadata: unitId, reasonCode.
  'violation.cancelled': { log: 'tenant', target: 'unit_violation' },
  // metadata: violationId, unitId, amount, currency, receiptNumber (pattern
  // bound, as a fine's), paidOn.
  'violation.payment_recorded': {
    log: 'tenant',
    target: 'unit_violation_payment',
  },
  // metadata: violationId, unitId, reversesId, reasonCode.
  'violation.payment_reversed': {
    log: 'tenant',
    target: 'unit_violation_payment',
  },
  // An erasure (ADR 0053): the appellant's words and photo go, once.
  // metadata: unitId, photo (a boolean).
  'violation.appeal_cleared': { log: 'tenant', target: 'unit_violation' },
  // Children (ADR 0054). Ids, codes and switches; never a child's name or
  // photo. turned_on: metadata unitId, memberId, the two switches.
  'child_control.turned_on': { log: 'tenant', target: 'child_control' },
  // The switches by value.
  'child_control.updated': { log: 'tenant', target: 'child_control' },
  'child_control.card_reissued': { log: 'tenant', target: 'child_control' },
  // The photo as changed, never a file id.
  'child_control.photo_changed': {
    log: 'tenant',
    target: 'child_control',
    sensitive: ['photo'],
  },
  // metadata: reasonCode (household, left_household, came_of_age), and how
  // many escorts it revoked.
  'child_control.ended': { log: 'tenant', target: 'child_control' },
  // An escort: kind, account or engagement id and validity by value; an
  // outside person's name, phone and photo as changed.
  'child_escort.added': {
    log: 'tenant',
    target: 'child_escort',
    sensitive: ['fullName', 'phone', 'photo'],
  },
  'child_escort.updated': { log: 'tenant', target: 'child_escort' },
  // metadata: reasonCode (household, left_household, control_off).
  'child_escort.revoked': { log: 'tenant', target: 'child_escort' },
  'child_escort.code_reissued': { log: 'tenant', target: 'child_escort' },
  // The 30-day purge of a revoked outside escort's name and phone.
  'child_escort.pii_cleared': { log: 'tenant', target: 'child_escort' },
  // An exit at the gate: the record's id and its outcome, method and
  // reason codes only, never the child, the control, the unit or the
  // escort, so the trail keeps no child's movements once the record goes.
  'child_pickup.recorded': { log: 'tenant', target: 'child_pickup' },
  // The 30-day purge: metadata records (how many), no target.
  'child_pickup.purged': { log: 'tenant', target: 'child_pickup' },
  // An event for children (ADR 0054): metadata unitId, memberId.
  'community_event.child_registered': {
    log: 'tenant',
    target: 'community_event',
  },
  'community_event.child_unregistered': {
    log: 'tenant',
    target: 'community_event',
  },
  // The gate's completion (ADR 0056). Ids, codes and counts only: never a
  // visitor's name nor a plate.
  'gate_settings.changed': { log: 'tenant', target: 'tenant' },
  // metadata: number, kind, reasonCode, unitId, gateId, shiftId, and
  // engagementId or permitWorkerId; visitorName and plate as booleans.
  'gate_exception.raised': { log: 'tenant', target: 'gate_field_exception' },
  // metadata: decision (approved | rejected), rejectReasonCode.
  'gate_exception.decided': { log: 'tenant', target: 'gate_field_exception' },
  // By the system: nobody answered by its deadline.
  'gate_exception.expired': { log: 'tenant', target: 'gate_field_exception' },
  'gate_exception.withdrawn': { log: 'tenant', target: 'gate_field_exception' },
  // The gate log searched (ADR 0056). metadata: from, to, unitId, byName
  // (a boolean: never the name), results, truncated.
  'gate.log_searched': { log: 'tenant', target: 'tenant' },
  // An incident keeps a visitor's photo at entry (ADR 0056), past its 30
  // days. metadata: evidenceId, kind, entryId.
  'incident.evidence_linked': { log: 'tenant', target: 'incident' },
  // An incident report signed (ADR 0056). metadata: signatureId, role,
  // canonicalVersion — never the hash's content.
  'incident.signed': { log: 'tenant', target: 'incident' },
  // At its signer's erasure: the image goes. metadata: incidentId.
  'incident_signature.image_cleared': {
    log: 'tenant',
    target: 'incident_signature',
  },
  // A service vehicle at the gate. metadata: kind, unitId, facilityId,
  // gateId, shiftId — never the plate nor the company.
  'service_vehicle.entered': { log: 'tenant', target: 'service_vehicle_visit' },
  // metadata: gateId, shiftId.
  'service_vehicle.exited': { log: 'tenant', target: 'service_vehicle_visit' },
  // By the system, after GATE_UNCONFIRMED_EXIT_HOURS. metadata: gateId.
  'service_vehicle.exit_unconfirmed': {
    log: 'tenant',
    target: 'service_vehicle_visit',
  },
  // The gate offline (ADR 0057). Ids, codes and counts only: never a key,
  // a signature, a code, a plate nor a name.
  // A guard enrolled a device. metadata: labelled (a boolean: never the label).
  'gate_device.enrolled': { log: 'tenant', target: 'gate_device' },
  // metadata: reasonCode.
  'gate_device.revoked': { log: 'tenant', target: 'gate_device' },
  // A device's upload refused whole. metadata: reason (signature, envelope,
  // payload).
  'gate_offline.upload_rejected': { log: 'tenant', target: 'gate_device' },
  // A revoked device's quarantined batch decided. metadata: decision
  // (accepted | rejected), actions, recorded.
  'gate_offline_batch.reviewed': {
    log: 'tenant',
    target: 'gate_offline_batch',
  },
  // metadata: kind, reviewCode.
  'gate_offline_flag.reviewed': { log: 'tenant', target: 'gate_offline_flag' },
  // Partners (ADR 0060). changes: standing, area and flags by value, the
  // services as `category` or `category:<subcategoryId>` codes; names,
  // descriptions, the business phone and the notify email as
  // `{ changed: true }` only.
  'partner.created': {
    log: 'tenant',
    target: 'partner',
    sensitive: [
      'nameEn',
      'nameAr',
      'descriptionEn',
      'descriptionAr',
      'businessPhone',
      'notifyEmail',
    ],
  },
  'partner.updated': {
    log: 'tenant',
    target: 'partner',
    sensitive: [
      'nameEn',
      'nameAr',
      'descriptionEn',
      'descriptionAr',
      'businessPhone',
      'notifyEmail',
    ],
  },
  'partner.services_changed': { log: 'tenant', target: 'partner' },
  // changes: windows as `weekday:start-end` codes.
  'partner.hours_changed': { log: 'tenant', target: 'partner' },
  // changes: the lines as `unit:price` codes, in order; never their names.
  'partner.prices_changed': { log: 'tenant', target: 'partner' },
  // changes: category, key, state and order by value; names as changed.
  'partner_subcategory.created': {
    log: 'tenant',
    target: 'partner_subcategory',
    sensitive: ['nameEn', 'nameAr'],
  },
  'partner_subcategory.updated': {
    log: 'tenant',
    target: 'partner_subcategory',
    sensitive: ['nameEn', 'nameAr'],
  },
  // changes: the settings by value.
  'partner.settings_changed': { log: 'tenant', target: 'tenant' },
  // A request to a partner (ADR 0060). metadata: number, partnerId, unitId,
  // category, subcategoryId, gatePass, itemCount, note (whether there is
  // one), the window. Never the note's words or anyone's name.
  'partner_request.created': { log: 'tenant', target: 'partner_request' },
  // Its moves. metadata: number, partnerId, unitId, from, to, via
  // (resident, partner_desk, relay or system), deskLinkId on the desk,
  // reasonCode, the window and staffCount where the move names them. A
  // desk's move is the system's (the desk is no account); the relay's is
  // the staff member's.
  'partner_request.accepted': { log: 'tenant', target: 'partner_request' },
  'partner_request.declined': { log: 'tenant', target: 'partner_request' },
  'partner_request.proposed': { log: 'tenant', target: 'partner_request' },
  'partner_request.proposal_accepted': {
    log: 'tenant',
    target: 'partner_request',
  },
  'partner_request.cancelled': { log: 'tenant', target: 'partner_request' },
  'partner_request.done': { log: 'tenant', target: 'partner_request' },
  'partner_request.no_show': { log: 'tenant', target: 'partner_request' },
  'partner_request.expired': { log: 'tenant', target: 'partner_request' },
  'partner_request.lapsed': { log: 'tenant', target: 'partner_request' },
  // A desk opened (the system). metadata: deskLinkId, requestCount,
  // withheldCount (requests whose consent was withdrawn).
  'partner_desk.looked_up': { log: 'tenant', target: 'partner' },
  // A desk link made or revoked. metadata: deskLinkId, expiresAt,
  // revokedCount. Never the token or its hash.
  'partner_desk_link.created': { log: 'tenant', target: 'partner' },
  'partner_desk_link.revoked': { log: 'tenant', target: 'partner' },
  // A rating (that it was, never how). metadata: number, partnerId,
  // comment (whether there is one).
  'partner_request.rated': { log: 'tenant', target: 'partner_request' },
  // A complaint against a partner (a management request on
  // `partner_service`). metadata: requestId, requestNumber, partnerId,
  // managementRequestId, reason, compensationAsk, requestedAmount. Never
  // its words: they are the management request's first message.
  'partner_complaint.created': { log: 'tenant', target: 'partner_complaint' },
  // metadata: requestId, partnerId, outcome, compensation.
  'partner_complaint.decided': { log: 'tenant', target: 'partner_complaint' },
  // metadata: reasonCode (partnerSuspend), cancelledCount, notifiedCount.
  'partner.suspended': { log: 'tenant', target: 'partner' },
  // metadata: reasonCode (the suspension's it ends).
  'partner.reinstated': { log: 'tenant', target: 'partner' },
  // Decision appeals (ADR 0059): ids, codes and times; the grounds and the
  // rationale as changed, never their words.
  // changes: number, kind, subjectId, unitId, decisionAt, attachments (how
  // many), the grounds as changed.
  'decision_appeal.lodged': {
    log: 'tenant',
    target: 'decision_appeal',
    sensitive: ['grounds'],
  },
  // The appellant withdrew it. No metadata.
  'decision_appeal.withdrawn': { log: 'tenant', target: 'decision_appeal' },
  // A manager decided it. changes: the rationale as changed; metadata:
  // outcome (upheld | overturned), effect (applied | follow_up | none),
  // effectReason (a code or null), deciderRoleKey.
  'decision_appeal.decided': {
    log: 'tenant',
    target: 'decision_appeal',
    sensitive: ['rationale'],
  },
  // The manager followed an overturn up. No metadata.
  'decision_appeal.followed_up': { log: 'tenant', target: 'decision_appeal' },
  // The appellant's erasure: its grounds and attachments went. metadata:
  // attachments (how many files were marked deleted).
  'decision_appeal.grounds_cleared': {
    log: 'tenant',
    target: 'decision_appeal',
  },
  // An overturned decision appeal withdrew the unit's notice. metadata:
  // noticeId, appealId.
  'neighbour_complaint.notice_withdrawn': {
    log: 'tenant',
    target: 'neighbour_complaint',
  },
  // Building representatives (ADR 0059); their threads' messages are not
  // the trail's. A board matter's approval names one. metadata: building,
  // unitId, replacedId (the one it replaced, or null), matterId.
  'governance_representative.appointed': {
    log: 'tenant',
    target: 'governance_representative',
  },
  // metadata: building, reason (ended | replaced | no_longer_owner |
  // account_closed), matterId (the board's matter, or null: the system).
  'governance_representative.ended': {
    log: 'tenant',
    target: 'governance_representative',
  },
  // A sitting member raised a matter about a building's representative.
  // metadata: action (appoint | end), building, accountId (whom it
  // names), representativeId (the term to end, or null).
  'governance_representative_matter.raised': {
    log: 'tenant',
    target: 'governance_representative_matter',
  },
  // Its raiser withdrew it. metadata: motionId (its open motion closed
  // with it, or null).
  'governance_representative_matter.withdrawn': {
    log: 'tenant',
    target: 'governance_representative_matter',
  },
  // A carried motion decided it. metadata: decision (approved |
  // rejected), motionId, effect (applied | not_applied | null),
  // effectReason.
  'governance_representative_matter.decided': {
    log: 'tenant',
    target: 'governance_representative_matter',
  },
  // Agenda proposals (ADR 0059). changes: the title and the words as
  // changed.
  'governance_agenda_proposal.proposed': {
    log: 'tenant',
    target: 'governance_agenda_proposal',
    sensitive: ['title', 'body'],
  },
  // The proposer withdrew it. No metadata.
  'governance_agenda_proposal.withdrawn': {
    log: 'tenant',
    target: 'governance_agenda_proposal',
  },
  // metadata: outcome (accepted | declined), reasonCode (agendaDecline, or
  // null), note (a boolean: never the words).
  'governance_agenda_proposal.decided': {
    log: 'tenant',
    target: 'governance_agenda_proposal',
  },
  // The proposer's erasure cleared its words. No metadata.
  'governance_agenda_proposal.text_cleared': {
    log: 'tenant',
    target: 'governance_agenda_proposal',
  },
  // An objection to a published decision. changes: publicationId, the
  // grounds as changed; never the unit.
  'governance_objection.lodged': {
    log: 'tenant',
    target: 'governance_objection',
    sensitive: ['grounds'],
  },
  // The board answered a decision's objections, on the publication.
  // metadata: objections (how many it answered).
  'governance_objection.answered': {
    log: 'tenant',
    target: 'board_publication',
  },
  // The objector's erasure cleared the grounds. No metadata.
  'governance_objection.grounds_cleared': {
    log: 'tenant',
    target: 'governance_objection',
  },
  // A step of an approved request's follow-up. metadata: status
  // (in_progress | implemented | cannot_implement), note (a boolean).
  'governance_approval_progress.recorded': {
    log: 'tenant',
    target: 'governance_approval',
  },
  // Common areas (ADR 0064): codes, the building and the facility; the
  // names as { changed: true }, the position never. metadata.replaced:
  // whether a tag was issued before (it no longer works).
  'common_area.created': {
    log: 'tenant',
    target: 'common_area',
    sensitive: ['nameAr', 'nameEn'],
  },
  'common_area.updated': {
    log: 'tenant',
    target: 'common_area',
    sensitive: ['nameAr', 'nameEn'],
  },
  'common_area.tag_issued': { log: 'tenant', target: 'common_area' },
  // The asset register (ADR 0064): codes, keys, dates and amounts. The
  // names, the vendor's name and phone and the serial number as
  // { changed: true }. metadata: reasonCode; parts (moved with the root);
  // replaced (a tag was issued before).
  'asset_type.created': {
    log: 'tenant',
    target: 'asset_type',
    sensitive: ['nameAr', 'nameEn'],
  },
  'asset_type.updated': {
    log: 'tenant',
    target: 'asset_type',
    sensitive: ['nameAr', 'nameEn'],
  },
  'asset.created': {
    log: 'tenant',
    target: 'asset',
    sensitive: [
      'nameAr',
      'nameEn',
      'vendorName',
      'vendorPhone',
      'serialNumber',
    ],
  },
  'asset.updated': {
    log: 'tenant',
    target: 'asset',
    sensitive: [
      'nameAr',
      'nameEn',
      'vendorName',
      'vendorPhone',
      'serialNumber',
    ],
  },
  'asset.status_changed': { log: 'tenant', target: 'asset' },
  'asset.retired': { log: 'tenant', target: 'asset' },
  'asset.moved': { log: 'tenant', target: 'asset' },
  'asset.tag_issued': { log: 'tenant', target: 'asset' },
  // A document's title as { changed: true }; metadata: the subject's id,
  // the kind and the file.
  'maintenance_document.added': {
    log: 'tenant',
    target: 'maintenance_document',
    sensitive: ['title'],
  },
  'maintenance_document.removed': {
    log: 'tenant',
    target: 'maintenance_document',
  },
  // An asset sheet: metadata rowCount, errorCount; created when applied.
  'asset_import.checked': { log: 'tenant', target: 'asset_import' },
  'asset_import.applied': { log: 'tenant', target: 'asset_import' },
  // The compound's own work orders (ADR 0064). metadata: origin, the asset
  // or area, the category's key and the priority; never the words.
  'ticket.work_order_opened': { log: 'tenant', target: 'ticket' },
  'ticket.work_accepted': { log: 'tenant', target: 'ticket' },
  'ticket.work_sent_back': { log: 'tenant', target: 'ticket' },
  // Checklists (ADR 0064): keys, the purpose, the version and how many
  // items; the names as { changed: true }, the items' labels never.
  'checklist.created': {
    log: 'tenant',
    target: 'checklist',
    sensitive: ['nameAr', 'nameEn'],
  },
  'checklist.updated': {
    log: 'tenant',
    target: 'checklist',
    sensitive: ['nameAr', 'nameEn'],
  },
  'checklist.items_replaced': { log: 'tenant', target: 'checklist' },
  // Maintenance plans (ADR 0064): codes, days, dates and the owner; the
  // title as { changed: true }. metadata: reasonCode, the date skipped,
  // the occurrence deferred. Opening its work orders is the system's
  // (ticket.work_order_opened), and its history the plan's own.
  'maintenance_plan.created': {
    log: 'tenant',
    target: 'maintenance_plan',
    sensitive: ['title'],
  },
  'maintenance_plan.updated': {
    log: 'tenant',
    target: 'maintenance_plan',
    sensitive: ['title'],
  },
  'maintenance_plan.deactivated': { log: 'tenant', target: 'maintenance_plan' },
  'maintenance_plan.reactivated': { log: 'tenant', target: 'maintenance_plan' },
  'maintenance_plan.deferred': { log: 'tenant', target: 'maintenance_plan' },
  'maintenance_plan.skipped': { log: 'tenant', target: 'maintenance_plan' },
  'maintenance_plan.occurrence_deferred': {
    log: 'tenant',
    target: 'maintenance_plan',
  },
  // Inspections (ADR 0064): codes, ids, days; a round's title as
  // { changed: true }. metadata: reasonCode; an inspection's findings and
  // its attestation's hash.
  'inspection_round.created': {
    log: 'tenant',
    target: 'inspection_round',
    sensitive: ['title'],
  },
  'inspection_round.updated': {
    log: 'tenant',
    target: 'inspection_round',
    sensitive: ['title'],
  },
  'inspection_round.deactivated': { log: 'tenant', target: 'inspection_round' },
  'inspection_round.reactivated': { log: 'tenant', target: 'inspection_round' },
  'inspection.created': { log: 'tenant', target: 'inspection' },
  'inspection.cancelled': { log: 'tenant', target: 'inspection' },
  'inspection.submitted': { log: 'tenant', target: 'inspection' },
  // A technician's recommendation to replace (ADR 0064): the asset and the
  // reason codes; the note as { changed: true }.
  'asset_replacement.recommended': {
    log: 'tenant',
    target: 'asset_replacement_recommendation',
    sensitive: ['note'],
  },
  'asset_replacement.accepted': {
    log: 'tenant',
    target: 'asset_replacement_recommendation',
  },
  'asset_replacement.declined': {
    log: 'tenant',
    target: 'asset_replacement_recommendation',
  },
  // A ticket's costs and the technicians' suggested quotes (ADR 0065):
  // amounts and codes; what an entry or a note says, as `{ changed }`.
  'ticket_cost.recorded': {
    log: 'tenant',
    target: 'ticket_cost_entry',
    sensitive: ['description'],
  },
  'ticket_cost.voided': { log: 'tenant', target: 'ticket_cost_entry' },
  'quote_suggestion.made': {
    log: 'tenant',
    target: 'ticket_quote_suggestion',
    sensitive: ['note'],
  },
  'quote_suggestion.sent': {
    log: 'tenant',
    target: 'ticket_quote_suggestion',
  },
  'quote_suggestion.dismissed': {
    log: 'tenant',
    target: 'ticket_quote_suggestion',
  },
  // The maintenance store (ADR 0065): codes, quantities and costs; names
  // as `{ changed }`; a receipt's reference only as whether it has one.
  'store.created': {
    log: 'tenant',
    target: 'store',
    sensitive: ['nameAr', 'nameEn'],
  },
  'store.updated': {
    log: 'tenant',
    target: 'store',
    sensitive: ['nameAr', 'nameEn'],
  },
  'stock_item.created': {
    log: 'tenant',
    target: 'stock_item',
    sensitive: ['nameAr', 'nameEn'],
  },
  'stock_item.updated': {
    log: 'tenant',
    target: 'stock_item',
    sensitive: ['nameAr', 'nameEn'],
  },
  'stock.received': { log: 'tenant', target: 'stock_item' },
  'stock.adjusted': { log: 'tenant', target: 'stock_item' },
  'stock.transferred': { log: 'tenant', target: 'stock_item' },
  'stock.returned': { log: 'tenant', target: 'stock_item' },
  'part_request.requested': { log: 'tenant', target: 'part_request' },
  'part_request.reserved': { log: 'tenant', target: 'part_request' },
  'part_request.issued': { log: 'tenant', target: 'part_request' },
  'part_request.declined': { log: 'tenant', target: 'part_request' },
  'part_request.cancelled': { log: 'tenant', target: 'part_request' },
  // Maintenance contracts (ADR 0065): dates, values and codes; the
  // vendor's name and phone and the scope as `{ changed }`.
  'maintenance_contract.created': {
    log: 'tenant',
    target: 'maintenance_contract',
    sensitive: ['vendorName', 'vendorPhone', 'scope'],
  },
  'maintenance_contract.updated': {
    log: 'tenant',
    target: 'maintenance_contract',
    sensitive: ['vendorName', 'vendorPhone', 'scope'],
  },
  'maintenance_contract.terminated': {
    log: 'tenant',
    target: 'maintenance_contract',
  },
  'maintenance_contract.assets_changed': {
    log: 'tenant',
    target: 'maintenance_contract',
  },
  // Energy and utilities (ADR 0066): codes, kinds, ids, days and values;
  // nothing here names a person.
  'meter.created': { log: 'tenant', target: 'meter' },
  'meter.updated': { log: 'tenant', target: 'meter' },
  'meter.retired': { log: 'tenant', target: 'meter' },
  // A reading is a fact, not a decision: only its correction or withdrawal
  // is audited, as an alert's acknowledgement and the spike rule are.
  'meter_reading.corrected': { log: 'tenant', target: 'meter_reading' },
  'meter_reading.withdrawn': { log: 'tenant', target: 'meter_reading' },
  'meter_alert.acknowledged': { log: 'tenant', target: 'meter_alert' },
  'energy.settings_changed': { log: 'tenant', target: 'tenant' },
  'meter_reading_import.checked': {
    log: 'tenant',
    target: 'meter_reading_import',
  },
  'meter_reading_import.applied': {
    log: 'tenant',
    target: 'meter_reading_import',
  },
  'energy_tariff.created': { log: 'tenant', target: 'energy_tariff' },
  'energy_measure.created': { log: 'tenant', target: 'energy_measure' },
  'energy_measure.ended': { log: 'tenant', target: 'energy_measure' },
  // A note is what residents are asked to do: recorded as changed only.
  'utility_outage.created': {
    log: 'tenant',
    target: 'utility_outage',
    sensitive: ['note'],
  },
  'utility_outage.updated': {
    log: 'tenant',
    target: 'utility_outage',
    sensitive: ['note'],
  },
  'utility_outage.ended': { log: 'tenant', target: 'utility_outage' },
  'utility_outage.cancelled': { log: 'tenant', target: 'utility_outage' },
  // Readiness (ADR 0067): kinds, days, ids, amounts and codes. A title is
  // the compound's own words: recorded as changed only.
  'readiness_program.created': {
    log: 'tenant',
    target: 'readiness_program',
    sensitive: ['title'],
  },
  'readiness_program.updated': {
    log: 'tenant',
    target: 'readiness_program',
    sensitive: ['title'],
  },
  'readiness_program.closed': { log: 'tenant', target: 'readiness_program' },
  'readiness_program.copied': { log: 'tenant', target: 'readiness_program' },
  'readiness_item.created': {
    log: 'tenant',
    target: 'readiness_item',
    sensitive: ['title'],
  },
  'readiness_item.updated': {
    log: 'tenant',
    target: 'readiness_item',
    sensitive: ['title'],
  },
  'readiness_item.done': { log: 'tenant', target: 'readiness_item' },
  'readiness_item.cancelled': { log: 'tenant', target: 'readiness_item' },
  'readiness_campaign.spawned': { log: 'tenant', target: 'readiness_item' },
  // Field safety (ADR 0067): hazards, ids, versions and codes. The
  // precautions are the technician's words: recorded as changed only.
  'work_permit.requested': {
    log: 'tenant',
    target: 'work_permit',
    sensitive: ['precautions'],
  },
  'work_permit.approved': { log: 'tenant', target: 'work_permit' },
  'work_permit.rejected': { log: 'tenant', target: 'work_permit' },
  'work_permit.revoked': { log: 'tenant', target: 'work_permit' },
  'safety_instruction.published': {
    log: 'tenant',
    target: 'safety_instruction',
  },
  'safety_instruction.acknowledged': {
    log: 'tenant',
    target: 'safety_instruction',
  },
  'ticket_category.permit_hazards_changed': {
    log: 'tenant',
    target: 'ticket_category',
  },
  'asset_type.permit_hazards_changed': { log: 'tenant', target: 'asset_type' },
  // A technician asked for their SOS to be called off; it stays open.
  // metadata: status, reasonCode.
  'emergency.cancel_requested': { log: 'tenant', target: 'emergency' },
} as const satisfies Record<string, AuditActionDefinition>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

type ActionsFor<L extends 'tenant' | 'platform'> = {
  [K in AuditAction]: (typeof AUDIT_ACTIONS)[K]['log'] extends L ? K : never;
}[AuditAction];

/** Written to `audit_log`, in the tenant transaction of the action. */
export type TenantAuditAction = ActionsFor<'tenant'>;
/** Written to `platform_audit_log`, in the transaction of the action. */
export type PlatformAuditAction = ActionsFor<'platform'>;

export const SECURITY_EVENTS = [
  'otp.requested',
  'otp.verify_failed',
  'otp.challenge_exhausted',
  'otp.rate_limited',
  'login.succeeded',
  'session.refresh_reuse_detected',
  'session.revoked',
  'platform.login_failed',
  'platform.login_locked',
  'platform.login_succeeded',
  // Platform step-up (ADR 0046): a fresh code before a sensitive action.
  'platform.step_up_requested',
  'platform.step_up_verified',
  'platform.step_up_failed',
  // The Paymob webhook (ADR 0046): a call refused (no HMAC match), a signed
  // callback naming another checkout's order, an amount that is not the
  // checkout's, Paymob contradicting a signed success, a checkout charged
  // twice. Compound and session ids only.
  'payment.webhook_rejected',
  'payment.order_mismatch',
  'payment.amount_mismatch',
  'payment.verification_contradicted',
  'payment.duplicate_charge',
  'invite.token_invalid',
  // "Not me" (ADR 0023): the phone left the account.
  'account.phone_reassigned',
  // A registration completed with an unknown or revoked link (ADR 0024).
  'registration.link_invalid',
  // Step-up (ADR 0036): a fresh code before a sensitive action.
  'step_up.requested',
  'step_up.verified',
  'step_up.failed',
  // A login from a device never seen on the account (ADR 0036).
  'login.new_device',
  // The account said "not me" about it: frozen, every session ended.
  'account.not_me',
] as const;

export type SecurityEventName = (typeof SECURITY_EVENTS)[number];

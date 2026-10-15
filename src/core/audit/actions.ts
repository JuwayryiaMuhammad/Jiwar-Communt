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
    sensitive: ['visitorDirections', 'emergencyPhone'],
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
  // passIds, matches. Never the plate, nor a hash of it.
  'gate.plate_lookup': { log: 'tenant', target: 'guard_shift' },
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

  // Finance (ADR 0046). The gateway's credentials are never recorded, not
  // even their last four characters: metadata names the fields that
  // changed (`fieldsChanged`) and the mode.
  'finance_gateway.set': { log: 'tenant', target: 'tenant' },
  // metadata: onlineEnabled.
  'finance_gateway.toggled': { log: 'tenant', target: 'tenant' },
  // The platform's side of the same (metadata as above; platformDisabled).
  'tenant.payment_gateway_set': { log: 'platform', target: 'tenant' },
  'tenant.payment_gateway_toggled': { log: 'platform', target: 'tenant' },
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

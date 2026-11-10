/**
 * The words of each notification kind (ADR 0027): the inbox stores a kind and
 * its params, never text; lib/notifications.ts fills these. One key per kind
 * of the backend catalog (src/core/notifications/kinds.ts).
 *
 * The params, as lib/notifications.ts hands them over:
 * - a code (`{categoryKey}`, `{reason}`, `{type}`…) arrives in words, from the
 *   shared code words; `{aType}` is the same words with English’s "a"/"an",
 *   `{aTypeCap}` with "A"/"An" to open a sentence (Arabic has no article: in
 *   Arabic both are the bare words);
 * - `decision`, `outcome`, `source`, `scope`, `matter`, `tied` and
 *   `disbursementKind` stay codes, for a select; `{decisionLabel}`,
 *   `{outcomeLabel}` and `{sourceLabel}` are their words;
 * - `{device}`, `{post}` and `{exception}` come from notify-words;
 * - `{at}`, `{expiresAt}`, `{effectiveAt}` and `{bidsDueAt}` are formatted
 *   instants, `{window}` a visit’s "12 Oct, 10:00–12:00", `{blockers}` a list;
 * - `hasUnitCode`, `hasHoldReason`, `hasWorkerName`, `hasAt`, `hasExpiresAt`,
 *   `hasUntil` and `hasArea` are `yes` or `no`: whether that optional param came.
 * Days (`{dueOn}`, `{endsOn}`…) and amounts are shown as the API sends them.
 */
export default {
  'gate.approval_requested': 'The gate asks to let {aRequestKind} in for unit {unitCode}',
  'gate.approval_reversed': 'Unit {unitCode} withdrew its approval of {aRequestKind}',
  'worker.entered': '{hasWorkerName, select, yes {{workerName}} other {A worker}} entered through {gateName} for unit {unitCode}',
  'worker.exited': '{hasWorkerName, select, yes {{workerName}} other {A worker}} left through {gateName} · unit {unitCode}',
  'visitor_pass.not_me': 'A visitor pass of unit {unitCode} was cancelled: the person said it was not theirs',
  'entry_credential.issued': 'A phone was registered for your entry code',
  'account.new_device_login': 'Your account was signed in to from a new {device}{hasAt, select, yes {, {at}} other {}}',
  'data_export.ready': 'Your data export is ready{hasExpiresAt, select, yes {, until {expiresAt}} other {}}',
  'household.member_account_deleted': 'A household member of unit {unitCode} deleted their account',
  'account.deletion_requested': 'Your account is set to be deleted on {effectiveAt}',
  'account.deletion_reminder': 'Your account will be deleted on {effectiveAt}',
  'account.deletion_delayed': 'Your account was not deleted yet: {blockers}',
  'account.deletion_queued': 'A deletion request is waiting for management: {blockers}',
  'account.deletion_closed': 'Your deletion request was closed without deleting the account ({reason})',
  'account.assisted_action': 'Management acted for you: {action} (asked {reason})',
  'ticket.emergency': 'Emergency: Ticket {ticketNumber} · {categoryKey}{hasUnitCode, select, yes { · unit {unitCode}} other {}}',
  // Emergencies and gate services (ADR 0047): the kind and codes only.
  'emergency.reported': '{aEmergencyTypeCap} emergency was reported',
  'emergency.escalated': 'Nobody has answered {aEmergencyType} emergency',
  'emergency.cancelled': 'An emergency was cancelled by the household',
  'emergency.cancel_requested': 'Who raised an SOS asked to call it off: check on them, then resolve it',
  'emergency.family_alert': 'An emergency was reported from your unit',
  'emergency.responder_on_the_way': 'A responder is on the way, about {etaMinutes} minutes',
  'gate_service.requested': 'A resident asked security for {serviceKind}',
  'partner_request.accepted': 'The partner accepted your request',
  'partner_request.declined': 'The partner declined your request ({reason})',
  'partner_request.proposed': 'The partner proposed another time for your request',
  'partner_request.cancelled': 'A partner request was cancelled ({reason})',
  'partner_request.done': 'The partner marked your request done',
  'partner_request.expired': 'Nobody accepted your partner request in time',
  'partner_request.awaiting_relay': 'A resident asked a partner without a desk link: {category}',
  'partner_complaint.decided': 'Your complaint about a partner was decided: {outcomeLabel}',
  'partner.suspended': 'A partner you asked or follow was suspended',
  // Decision appeals (ADR 0059).
  'decision_appeal.lodged': 'A resident appealed a staff decision: {kind}',
  'decision_appeal.decided': 'An appeal was {outcome, select, overturned {overturned} other {upheld}}: {kind}',
  // The owners' voice, the board's side (ADR 0059): never who.
  'governance_agenda.proposed': 'An owner proposed a matter for the board’s agenda',
  'governance_objection.lodged': 'An owner objected to a decision of the board',
  // The board's work (ADR 0075): codes only, never a name.
  'board_meeting.scheduled': '{aKindCap} meeting of the board was scheduled',
  'board_meeting.cancelled': 'A meeting of the board was called off ({reason})',
  'board_meeting_action.assigned': 'The board gave you an action item from its meeting',
  'board_meeting_action.overdue': 'An action item of yours from a board meeting is past its due day',
  'manager_handover.delivered': 'A manager delivered their handover',
  'board_report.ready': 'Last month’s board report is ready',
  'unit_permit.requested': 'A unit asked for a permit: {permitKind}',
  'unit_permit.approved': 'Your permit was approved: {permitKind}',
  'unit_permit.rejected': 'Your permit was not approved ({reason})',
  'unit_permit.revoked': 'Your permit was revoked ({reason})',
  'unit_permit.used': 'The goods on your permit went out at the gate',
  'unit_permit.cancelled': 'A permit was cancelled ({reason})',
  // Governance (ADR 0051): codes only, never a name or a choice.
  'governance_election.awaiting_certification':
    '{tied, select, yes {An election closed with a tie: record the board’s choice and certify it} other {An election closed: certify its result}}',
  'governance_election.cancelled': 'An election of the board was cancelled ({reason})',
  'governance_poll.result': 'A poll of the owners closed: {result}',
  // Board matters (ADR 0055): codes only, never a name, a vote or a reason.
  'governance_approval.raised': '{aTypeCap} request awaits the board’s decision',
  'governance_approval.decided': 'The board {decision, select, approved {approved} other {rejected}} {aType} request',
  'governance_approval.overdue': '{aTypeCap} request is past its deadline, undecided',
  'governance_approval.implemented': 'The management implemented an approved {type} request',
  'governance_approval.withdrawn': '{aTypeCap} request was withdrawn',
  'governance_motion.proposed':
    '{matter, select, appeal {A motion on an appeal awaits your vote} representative {A motion on a building’s representative awaits your vote} other {A motion on a request awaits your vote}}',
  'governance_appeal.lodged': '{aKindCap} was appealed to the board',
  'governance_appeal.decided': 'The board {outcome, select, overturned {overturned} other {upheld}} {aKind} on appeal',
  'governance_appeal.overdue': 'An appeal of {aKind} is past its deadline, undecided',
  'gate_service.accepted': 'Security accepted your request',
  'gate_service.closed': 'Security closed your request ({reason})',
  // Guard shifts and tasks (ADR 0050): codes only, never a name or a post.
  'guard_shift.absent': 'A guard did not start their shift',
  // The field team (ADR 0078).
  'technician_shift.absent': 'A technician did not go on duty for their shift',
  'technician_instruction.issued': 'An instruction went to the technicians',
  'technician_instruction.urgent': 'An urgent instruction went to the technicians',
  'technician_help.requested': 'A technician called for help ({helpKind})',
  'technician_help.taken': 'A call for help was taken',
  'technician_help.assigned': 'A technician was sent to help a colleague',
  'technician_help.escalated': 'Nobody took a technician’s call for help ({helpKind})',
  // The field team, part b (ADR 0090).
  'staff_certificate.expiring': '{aCertificateKindCap} certificate expires on {expiresOn}, in {daysLeft} days',
  'staff_certificate.expires_today': '{aCertificateKindCap} certificate expires today',
  'dangling_account.found': 'A staff account looks dangling ({reason})',
  'access_review.opened': 'An access review is open: {lines} accounts to keep or revoke',
  'reinforcement.suggested': '{open} open tickets for {available} available technicians: call reinforcement?',
  'reinforcement.called': 'The field team asks {needed} technicians to come in',
  'reinforcement.filled': 'A reinforcement call is filled',
  'reinforcement.cancelled': 'A reinforcement call was called off',
  'guard_shift.absent_unmanned': 'A guard did not start their shift and nobody is on duty there',
  'guard_task.assigned': '{aTaskKindCap} task for you',
  'guard_task.unit_inspected': 'Security inspected your closed unit ({outcomeLabel})',
  'guard_swap.requested': 'A colleague asks you to take one of their shifts',
  'guard_swap.accepted': 'A shift swap awaits your decision',
  'guard_swap.declined': 'Your colleague declined the shift swap',
  'guard_swap.approved': 'A shift swap was approved',
  'guard_swap.rejected': 'A shift swap was not approved',
  'guard_swap.expired': 'A shift swap expired: its shift started first',
  'guard_swap.cancelled': 'A shift swap no longer applies',
  'guard_instruction.issued': 'A new instruction to acknowledge',
  'guard_instruction.urgent': 'An urgent instruction to acknowledge',
  // Patrols (ADR 0052): codes only.
  'patrol.late': 'A patrol at your post has not started',
  'patrol.missed': 'A scheduled patrol was not started',
  'patrol.incomplete': 'A patrol ended with checkpoints not scanned ({reason})',
  // The gate's completion (ADR 0056): codes only, never a name or a plate.
  'patrol.geofence_exit': 'A guard on patrol was outside the route’s area for {minutes} minutes or more',
  'gate_exception.requested': 'A guard at {gateName} asks to let {exception} in for unit {unitCode}',
  // The gate offline (ADR 0057): counts and codes only.
  'gate_device.enrolled': 'A guard enrolled a device for the gate offline',
  'gate_device.sync_overdue': 'A gate device on shift has not been seen for {minutes} minutes',
  'gate_device.sequence_gap': '{missing} action(s) recorded offline on a gate device never arrived',
  'gate_device.upload_rejected': 'A gate device’s offline upload was refused ({reason})',
  'gate_offline.security_conflict': 'A gate device synced {flags} security conflict(s) from offline',
  'gate_offline.conflicts': 'A gate device synced {flags} entry conflict(s) to review',
  // The control room (ADR 0068): the event's code only.
  'control_room.alert': 'Control room alert: {eventKind}',
  'control_room.event': 'Control room: {eventKind}',
  'gate.call_incoming': '{gateName} is calling you',
  // Security (ADR 0053): codes only, never a plate, a name, a unit or a word.
  'gate_lockdown.started': '{scope, select, all {Every gate is locked down} other {A gate is locked down}}',
  'gate_lockdown.resident_notice': 'The compound’s gates are locked down for now',
  'gate_lockdown.ended': '{scope, select, all {The lockdown of every gate ended} other {A gate’s lockdown ended}}',
  'blocklist.ban_matched':
    '{source, select, offline_sync {A banned plate was let in while the gate was offline} other {A banned plate or person was refused at the gate ({sourceLabel})}}',
  'blocklist.watch_matched': 'A watched plate or person came to the gate ({sourceLabel})',
  'unit_permit.work_stopped': 'Security stopped the work on a permit ({reason})',
  'unit_permit.work_resumed': 'The work on a permit may go on',
  'unit_permit.damage_claimed': 'A damage claim was raised on a permit ({claimNumber})',
  'unit_permit.damage_appealed': 'A unit appealed a damage claim ({claimNumber})',
  'unit_permit.damage_appeal_decided': 'A damage claim’s appeal was decided: {decisionLabel} ({claimNumber})',
  'unit_permit.damage_withdrawn': 'A damage claim was withdrawn ({reason})',
  'unit_permit.damage_settled': 'A damage claim was settled ({claimNumber})',
  'unit_permit.debris_missed': 'A debris removal of a permit was missed',
  'unit_permit.refused_by_security': 'Security refused a guest or the truck of a permit',
  'visitor_pass.refused_by_security': 'Security refused your visitor at the gate',
  'incident.reported': '{aSeverityCap} {incidentType} incident was reported',
  'incident.critical': 'A critical {incidentType} incident was reported',
  'incident.assigned': 'An incident was given to you to investigate',
  'violation.issued': '{aViolationKindCap} violation was issued to your unit',
  'violation.appeal_upheld': 'Your appeal of a violation was not accepted',
  'violation.appeal_accepted': 'Your appeal of a violation was accepted: it is cancelled',
  // Children (ADR 0054): the keepers are told of an unauthorized pickup only.
  'child.unauthorized_pickup': 'Someone not allowed tried to collect a child at the gate',
  'ticket.assigned':
    'Ticket {ticketNumber} is assigned to you · {priority} · {categoryKey}{hasUnitCode, select, yes { · unit {unitCode}} other {}}',
  'ticket.unassigned': 'Ticket {ticketNumber} was given to someone else{hasUnitCode, select, yes { · unit {unitCode}} other {}}',
  'ticket.status_changed':
    'Ticket {ticketNumber} is now {status}{hasHoldReason, select, yes { ({holdReason})} other {}}{hasUnitCode, select, yes { · unit {unitCode}} other {}}',
  'ticket.completed': 'Ticket {ticketNumber} is done and waits for confirmation{hasUnitCode, select, yes { · unit {unitCode}} other {}}',
  'ticket.declined':
    'Ticket {ticketNumber} was declined by its technician and is back in the queue{hasUnitCode, select, yes { · unit {unitCode}} other {}}',
  'ticket.quote_suggested':
    'Ticket {ticketNumber}: the technician suggests a {amount} EGP quote to send{hasUnitCode, select, yes { · unit {unitCode}} other {}}',
  'ticket.technician_unavailable':
    'Ticket {ticketNumber} is back in the queue: its technician is unavailable{hasUnitCode, select, yes { · unit {unitCode}} other {}}',
  'ticket.priority_changed': 'Ticket {ticketNumber} is now {priority} priority{hasUnitCode, select, yes { · unit {unitCode}} other {}}',
  'ticket.rejected':
    'Ticket {ticketNumber}: the reporter rejected the work ({rejectionCount}×){hasUnitCode, select, yes { · unit {unitCode}} other {}}',
  'ticket.reopened':
    'Ticket {ticketNumber} was reopened by its reporter ({rejectionCount}×){hasUnitCode, select, yes { · unit {unitCode}} other {}}',
  'ticket.escalated':
    'Ticket {ticketNumber} was rejected {rejectionCount} times and needs a look{hasUnitCode, select, yes { · unit {unitCode}} other {}}',
  'ticket.auto_closed': 'Ticket {ticketNumber} was closed: nobody confirmed in time{hasUnitCode, select, yes { · unit {unitCode}} other {}}',
  'ticket.message': 'New message on ticket {ticketNumber}{hasUnitCode, select, yes { · unit {unitCode}} other {}}',
  'ticket.opened_on_behalf': 'Ticket {ticketNumber} was opened in your name{hasUnitCode, select, yes { · unit {unitCode}} other {}}',
  'ticket.unassignable':
    'Ticket {ticketNumber} has no technician who can take it · {categoryKey}{hasUnitCode, select, yes { · unit {unitCode}} other {}}',
  'ticket.unassignable_emergency':
    'Emergency ticket {ticketNumber} has no technician who can take it · {categoryKey}{hasUnitCode, select, yes { · unit {unitCode}} other {}}',
  'ticket.sla_breached': 'Ticket {ticketNumber} passed its {clock} target',
  'ticket.sla_breached_emergency': 'Emergency ticket {ticketNumber} passed its {clock} target',
  'ticket.sla_at_risk': 'Ticket {ticketNumber} is close to its {clock} target',
  'ticket.sla_at_risk_emergency': 'Emergency ticket {ticketNumber} is close to its {clock} target',
  'ticket.closed_by_staff': 'Ticket {ticketNumber} was closed by the management{hasUnitCode, select, yes { · unit {unitCode}} other {}}',
  // Maintenance analytics and cases (ADR 0081).
  'maintenance_case.opened': 'A community case opened: {ticketCount} {categoryKey} tickets in one building',
  'ticket.case_linked': 'Ticket {ticketNumber} joined a community case{hasUnitCode, select, yes { · unit {unitCode}} other {}}',
  'ticket.case_resolved': 'The case of ticket {ticketNumber} was resolved{hasUnitCode, select, yes { · unit {unitCode}} other {}}',
  'maintenance.plan_suggested': '{ticketCount} repeat {categoryKey} faults suggest planned work',
  'ticket.resident_escalated': 'A resident asked for attention on overdue ticket {ticketNumber}',
  'ticket.resident_escalated_emergency': 'A resident asked for attention on overdue emergency ticket {ticketNumber}',
  'ticket.visit_proposed': 'Ticket {ticketNumber}: a visit is proposed for {window}',
  'ticket.visit_confirmed': 'Ticket {ticketNumber}: the visit is confirmed for {window}',
  'ticket.visit_cancelled': 'Ticket {ticketNumber}: the visit of {window} was cancelled',
  'ticket.visit_arrived': 'Ticket {ticketNumber}: the technician has arrived',
  'ticket.visit_arrival_confirmed': 'Ticket {ticketNumber}: the residents confirmed the arrival',
  'ticket.visit_no_access': 'Ticket {ticketNumber}: nobody let the technician in ({window})',
  'ticket.visit_late': 'Ticket {ticketNumber}: the technician is late for the visit of {window}',
  'ticket.visit_consent_granted': 'Ticket {ticketNumber}: entry was allowed while nobody is home ({window})',
  'ticket.category_changed': 'Ticket {ticketNumber} is now under {categoryKey}{hasUnitCode, select, yes { · unit {unitCode}} other {}}',
  'parcel.arrived':
    'A parcel from {carrier} ({pieces, plural, one {# piece} other {# pieces}}) is at the gate for unit {unitCode}',
  'parcel.collected':
    'A parcel from {carrier} ({pieces, plural, one {# piece} other {# pieces}}) of unit {unitCode} was handed over',
  'parcel.reminder': 'A parcel from {carrier} has waited {days, plural, one {# day} other {# days}} at the gate for unit {unitCode}',
  'parcel.held_long': 'Parcel {parcelNumber} ({carrier}) has waited {days, plural, one {# day} other {# days}} for unit {unitCode}',
  'parcel.rejected': 'Parcel {parcelNumber} ({carrier}) was refused by the unit: send it back',
  'parcel.unclaimable': 'Parcel {parcelNumber} ({carrier}) arrived for unit {unitCode}, where nobody can collect it',
  // Requests to the management (ADR 0039): the number and the topic, never what was written.
  'management_request.created': 'Request {requestNumber} ({topicKey}) is new',
  'management_request.assigned': 'Request {requestNumber} ({topicKey}) was assigned to you',
  'management_request.escalated': 'Request {requestNumber} ({topicKey}) is overdue: nobody has responded',
  'management_request.resident_replied': 'Request {requestNumber} ({topicKey}): the resident wrote',
  'management_request.reopened': 'Request {requestNumber} ({topicKey}) was reopened by the resident',
  'management_request.withdrawn': 'Request {requestNumber} ({topicKey}) was withdrawn by the resident',
  'management_appointment.requested': 'Request {requestNumber} ({topicKey}): the resident picked an appointment slot',
  'management_appointment.accepted': 'Request {requestNumber} ({topicKey}): the resident accepted the proposed slot',
  'management_appointment.cancelled_by_resident': 'Request {requestNumber} ({topicKey}): the resident cancelled the appointment',
  // The resident's side: read here only by someone who is both.
  'management_request.replied': 'Request {requestNumber} ({topicKey}): the management replied',
  'management_request.status_changed': 'Request {requestNumber} ({topicKey}) has moved',
  'management_request.auto_closed': 'Request {requestNumber} ({topicKey}) was closed: no reply to the answer',
  'management_request.opened_for_you': 'Request {requestNumber} ({topicKey}) was opened for you by the management',
  'management_appointment.proposed': 'Request {requestNumber} ({topicKey}): the management proposed an appointment slot',
  'management_appointment.countered': 'Request {requestNumber} ({topicKey}): the management proposed another slot',
  'management_appointment.confirmed': 'Request {requestNumber} ({topicKey}): the appointment is confirmed',
  'management_appointment.cancelled': 'Request {requestNumber} ({topicKey}): the management cancelled the appointment',
  // Community life (ADR 0040): what happened, never a word anyone wrote.
  'community_announcement.important': 'An important announcement was published',
  'community_event.cancelled': 'An event you said you are going to was cancelled',
  'community_suggestion.status_changed': 'Your suggestion about {topicKey} is now {status}',
  // Neighbours (ADR 0042): the number and the category, or the kind of a
  // post; never a message, a notice's text, a unit or a name.
  'neighbour_complaint.submitted': 'Complaint {complaintNumber} ({categoryKey}) is new',
  'neighbour_complaint.author_replied': 'Complaint {complaintNumber} ({categoryKey}): the complainant wrote',
  'neighbour_complaint.withdrawn': 'Complaint {complaintNumber} ({categoryKey}) was withdrawn by the complainant',
  'neighbour_notice.unit_replied': 'Complaint {complaintNumber} ({categoryKey}): the unit answered its notice',
  'neighbour_item.claimed': 'A resident claimed a {post} at the desk',
  'neighbour_conversation.reported': 'A resident reported a conversation about a post',
  // The residents' side: read here only by someone who is both.
  'neighbour_complaint.under_review': 'Complaint {complaintNumber} ({categoryKey}) is under review',
  'neighbour_complaint.in_mediation': 'Complaint {complaintNumber} ({categoryKey}) is in mediation',
  'neighbour_complaint.resolved': 'Complaint {complaintNumber} ({categoryKey}) was resolved',
  'neighbour_complaint.dismissed': 'Complaint {complaintNumber} ({categoryKey}) was dismissed',
  'neighbour_complaint.replied': 'Complaint {complaintNumber} ({categoryKey}): the management wrote',
  'neighbour_complaint.notice_sent': 'Complaint {complaintNumber} ({categoryKey}): the management sent the unit a notice',
  'neighbour_notice.received': 'The management sent your unit a notice about {categoryKey}',
  'neighbour_notice.replied': 'The management wrote again on your unit’s notice about {categoryKey}',
  'neighbour_item.handed_over': 'The {post} was handed over to you at the office',
  'neighbour_claim.declined': 'Your claim on a {post} was declined',
  'neighbour_post.removed': 'Your {post} was removed from its board by the management',
  'neighbour_conversation.started': 'A neighbour wrote to you about your {post}',
  'neighbour_conversation.message': 'New message in a conversation about a {post}',
  'neighbour_conversation.reveal_requested': 'A neighbour agreed to show names in a conversation about a {post}',
  'neighbour_conversation.names_revealed': 'Names are now shown in a conversation about a {post}',
  'neighbour_report.closed': 'Your report of a conversation was looked at',
  'neighbours.welcome': 'Welcome: the compound’s rules, office hours and emergency numbers are ready to read',
  // Bookings and the club (ADR 0044): to residents.
  'booking.approved': 'Your booking was approved',
  'booking.rejected': 'Your booking was not approved ({reason})',
  'booking.approval_expired': 'Your booking request was not approved in time',
  'booking.cancelled_by_staff': 'The management cancelled your booking ({reason})',
  'booking.cancelled_by_closure': 'Your booking was cancelled: the facility is closed ({reason})',
  'booking.companion_invited': 'You were invited to come along to a booking',
  'booking.companion_cancelled': 'A booking you were to come along to was cancelled',
  'booking_waitlist.offered': 'A place you wait for is free: book it soon',
  'booking_waitlist.closed': 'A slot you waited for is closed',
  'booking.reminder': 'Your booking starts in about two hours',
  // Common-area use requests (ADR 0084).
  'space_use.approved': 'Your request to use {hasArea, select, yes {{area}} other {a common area}} was approved',
  'space_use.refused': 'Your request to use {hasArea, select, yes {{area}} other {a common area}} was refused ({reason})',
  'space_use.cancelled': 'Your approved use of {hasArea, select, yes {{area}} other {a common area}} was cancelled ({reason})',
  'space_use.expired': 'Your request to use {hasArea, select, yes {{area}} other {a common area}} was not decided in time',
  'booking_suspension.started': 'Your unit cannot make new bookings for a while',
  'facility_ban.started':
    'You may not book {scope, select, all {any facility} other {this facility}}{hasUntil, select, yes { until {until}} other {}}',
  'facility_ban.lifted': 'You may book again',
  'club_membership.expiring': 'Your club membership ends within a week',
  'club_membership_request.paid': 'Your club membership is paid: it starts as planned',
  // The asset register, plans and inspections (ADR 0064).
  'asset.warranty_expiring': 'The warranty of asset {assetRef} ends on {endsOn}',
  'stock.reorder_level': '{itemRef} is at or under its reorder level',
  'maintenance_contract.expiring': 'Contract {contractRef} ends on {endsOn}',
  // Vendors, compound contracts and purchase requests (ADR 0077).
  'maintenance_contract.payment_due': 'Contract {contractRef} has {amount} EGP due on {dueOn}',
  'vendor_document.expiring': 'A paper of vendor {vendorRef} expires on {expiresOn}',
  'purchase_request.submitted': 'Purchase request {requestRef} ({amount} EGP) waits for approval',
  // Compliance and corrective actions (ADR 0087).
  'compliance_item.assigned': 'A compliance item ({complianceKind}) is yours, next due {dueOn}',
  'compliance.due_soon': 'A compliance item ({complianceKind}) is due on {dueOn}, in {daysLeft} days',
  'compliance.overdue': 'A compliance item ({complianceKind}) due on {dueOn} is not done',
  'incident_action.assigned': 'A corrective action is yours, due {dueOn}',
  'incident_action.overdue': 'A corrective action due {dueOn} is still open',
  'purchase_request.decided': 'Your purchase request {requestRef} was {decision, select, approved {approved} other {turned down}}',
  // The contractor portal and tenders (ADR 0088).
  'vendor_dispatch.offered': 'Ticket {ticketNumber} is offered to your company',
  'vendor_dispatch.decided': 'The vendor {decision, select, accepted {took} other {turned down}} ticket {ticketNumber}',
  'vendor_dispatch.withdrawn': 'Ticket {ticketNumber} is no longer offered to your company',
  'tender.invited': 'Tender {tenderRef} takes your bid until {bidsDueAt}',
  'tender.opening_started': 'Tender {tenderRef} waits for a second person to open it',
  'tender.opened': 'Tender {tenderRef} was opened with {bidCount} bid(s)',
  'tender.decided':
    'Tender {tenderRef} was {outcome, select, awarded {awarded to you} cancelled {called off} other {awarded to another}}',
  // Payables (ADR 0089).
  'vendor_invoice.received': 'Vendor invoice {invoiceRef} waits for approval',
  'vendor_invoice.decided': 'Vendor invoice {invoiceRef} was {decision, select, approved {approved} other {turned down}}',
  'contract_disbursement.requested':
    '{disbursementKind, select, advance {An advance} other {A retention release}} {disbursementRef} waits for approval',
  'vendor_guarantee.expiring': 'A vendor’s guarantee expires on {expiresOn}',
  // The general ledger (ADR 0092).
  'gl_manual_entry.submitted': 'Journal entry {entryRef} waits for your approval',
  'gl_manual_entry.decided': 'Journal entry {entryRef} was {decision, select, approved {approved and posted} other {turned down}}',
  'meter.anomaly': 'Meter {meterRef} used far more than usual up to {readOn}',
  'part_request.created': 'Ticket {ticketNumber} asks the store for {itemRef}',
  'maintenance.plan_overdue': 'Planned work on asset {assetRef}, due {dueOn}, is overdue',
  'inspection.assigned': 'An inspection of {targetRef} is yours, due {dueOn}',
  'inspection.overdue': 'The inspection of {targetRef}, due {dueOn}, is overdue',
  'asset.replacement_recommended': 'A technician recommends replacing asset {assetRef}',
  'readiness_item.assigned': 'An item of a readiness program is yours, due {dueOn}',
  'readiness_item.overdue': 'Your readiness item, due {dueOn}, is overdue',
  'work_permit.requested': 'Ticket {ticketNumber} asks for {aHazard} permit',
  'work_permit.approved': 'The {hazard} permit for ticket {ticketNumber} is approved',
  'work_permit.rejected': 'The {hazard} permit for ticket {ticketNumber} was rejected',
  'work_permit.revoked': 'The {hazard} permit for ticket {ticketNumber} was revoked',
  // Money and the unit (ADR 0069): what the finance staff are asked for.
  'instalment_plan_request.submitted': 'A resident asked for a payment plan on an invoice',
  'collector_visit.requested': 'A resident asked for a collector to take cash at their unit',
  // Treasury and custody (ADR 0085).
  'finance.custody_variance': 'Hand-in {handinNumber} was counted other than expected',
  'finance.custody_investigation_assigned': 'The variance of hand-in {handinNumber} is yours to investigate by {dueOn}',
  'cheque.due': 'A post-dated cheque is due on {dueOn}: deposit it',
  // Community (ADR 0071): the staff's.
  'market_listing.under_review': 'Several homes reported a listing: it is off the market for review',
  'gallery_photo.reported': 'A resident reported a gallery photo',
  // The staff inbox and deputies (ADR 0073).
  'staff_inbox.overdue': 'Something in your inbox passed its due time',
  'deputy.appointed': 'You are a deputy: {permissions} permission(s) are yours until it ends',
  'deputy.ended': 'A deputyship of yours ended',
  // The operations dashboard (ADR 0079).
  'staff_brief.ready': 'The daily brief for {date} is ready',
  'staff_review.ready': 'The end-of-day review of {date} is ready',
  'maintenance.service_pressure':
    'Service pressure: {open} open tickets for {available, plural, one {# available technician} other {# available technicians}}',
  // Experience and recovery (ADR 0082).
  'experience_case.opened': 'Case {caseNumber} was opened: {signal}',
  'experience_case.assigned': 'Case {caseNumber} ({caseKind}) is yours',
  'experience_compensation.proposed': 'A compensation ({compensationKind}) on case {caseNumber} waits for your decision',
  // The reports platform (ADR 0086).
  'report_run.ready': 'A scheduled report for {periodFrom} to {periodTo} is ready to download',
  'compound_export.ready': 'The compound’s export is ready to download',
  // Cash flow (ADR 0091).
  'finance.cash_low': 'The compound’s cash falls below its minimum from {belowFrom}',
} as const;

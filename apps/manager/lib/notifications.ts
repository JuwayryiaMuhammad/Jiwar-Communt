/**
 * The inbox stores a kind and its params, never text (ADR 0027): the words
 * are written here, one entry per kind of the backend catalog
 * (src/core/notifications/kinds.ts). An unknown kind still reads as
 * something. Plain TypeScript with no imports, so the tests run it as is.
 */
export interface NotificationLike {
  kind: string;
  params: Record<string, string | number>;
  targetType: string | null;
  targetId: string | null;
}

type P = NotificationLike['params'];

const dateTime = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const timeOnly = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

function words(value: string | number | undefined): string {
  return value === undefined ? '' : String(value).replace(/[._]/g, ' ');
}

/** "a major contract", "an annual budget": the code in words, with its article. */
function aWords(value: string | number | undefined): string {
  const w = words(value);
  return `${/^[aeiou]/i.test(w) ? 'an' : 'a'} ${w}`;
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function when(value: string | number | undefined): string {
  const d = new Date(String(value));
  return value === undefined || Number.isNaN(d.getTime()) ? '' : dateTime.format(d);
}

/** "12 Oct, 10:00–12:00", from the visit's two instants. */
function windowText(p: P): string {
  const end = new Date(String(p.endsAt));
  const start = when(p.startsAt);
  if (!start) return '';
  return Number.isNaN(end.getTime()) ? start : `${start}–${timeOnly.format(end)}`;
}

/** "MR-000012 (billing fees)": a request by its number and topic (ADR 0039). */
const request = (p: P) => `Request ${p.requestNumber} (${words(p.topicKey)})`;
/** "Complaint NC-000123 (noise)": a complaint by its number and category (ADR 0042). */
const complaint = (p: P) => `Complaint ${p.complaintNumber} (${words(p.categoryKey)})`;
/** The kind of a board post, in words; never its text. */
const POST_TEXT: Record<string, string> = {
  lost: 'lost item',
  found: 'found item',
  lend: 'lending offer',
  borrow: 'request to borrow',
};
const post = (p: P) => POST_TEXT[String(p.postKind)] ?? 'post';
const ticket = (p: P) => `Ticket ${p.ticketNumber}`;
const aTicket = (p: P) => `ticket ${p.ticketNumber}`;
const inUnit = (p: P) => (p.unitCode ? ` · unit ${p.unitCode}` : '');
const days = (p: P) => `${p.days} day${Number(p.days) === 1 ? '' : 's'}`;
const pieces = (p: P) => `${p.pieces} piece${Number(p.pieces) === 1 ? '' : 's'}`;
const list = (value: string | number | undefined) =>
  String(value ?? '')
    .split(',')
    .filter(Boolean)
    .map(words)
    .join(', ');

/** The coarse device type of a login (the backend's DeviceType). */
const DEVICE_TEXT: Record<string, string> = {
  ios: 'iPhone or iPad',
  android: 'Android phone',
  desktop_web: 'computer browser',
  mobile_web: 'phone browser',
};

/** A field exception's kind, inside a sentence (ADR 0056). */
const EXCEPTION_KIND_TEXT: Record<string, string> = {
  worker_outside_hours: 'a worker outside their hours',
  visitor_without_pass: 'a visitor without a pass',
  unregistered_vehicle: 'an unregistered vehicle',
};

const TEXT: Record<string, (p: P) => string> = {
  'gate.approval_requested': (p) => `The gate asks to let a ${words(p.requestKind)} in for unit ${p.unitCode}`,
  'gate.approval_reversed': (p) => `Unit ${p.unitCode} withdrew its approval of a ${words(p.requestKind)}`,
  'worker.entered': (p) => `${p.workerName ?? 'A worker'} entered through ${p.gateName} for unit ${p.unitCode}`,
  'worker.exited': (p) => `${p.workerName ?? 'A worker'} left through ${p.gateName} · unit ${p.unitCode}`,
  'visitor_pass.not_me': (p) => `A visitor pass of unit ${p.unitCode} was cancelled: the person said it was not theirs`,
  'entry_credential.issued': () => 'A phone was registered for your entry code',
  'account.new_device_login': (p) =>
    `Your account was signed in to from a new ${DEVICE_TEXT[String(p.deviceType)] ?? 'device'}${when(p.at) ? `, ${when(p.at)}` : ''}`,
  'data_export.ready': (p) => `Your data export is ready${when(p.expiresAt) ? `, until ${when(p.expiresAt)}` : ''}`,
  'household.member_account_deleted': (p) => `A household member of unit ${p.unitCode} deleted their account`,
  'account.deletion_requested': (p) => `Your account is set to be deleted on ${when(p.effectiveAt)}`,
  'account.deletion_reminder': (p) => `Your account will be deleted on ${when(p.effectiveAt)}`,
  'account.deletion_delayed': (p) => `Your account was not deleted yet: ${list(p.blockers)}`,
  'account.deletion_queued': (p) => `A deletion request is waiting for management: ${list(p.blockers)}`,
  'account.deletion_closed': (p) => `Your deletion request was closed without deleting the account (${words(p.reason)})`,
  'account.assisted_action': (p) => `Management acted for you: ${words(p.action)} (asked ${words(p.reason)})`,
  'ticket.emergency': (p) => `Emergency: ${ticket(p)} · ${words(p.categoryKey)}${inUnit(p)}`,
  // Emergencies and gate services (ADR 0047): the kind and codes only.
  'emergency.reported': (p) => `A ${words(p.emergencyType)} emergency was reported`,
  'emergency.escalated': (p) => `Nobody has answered a ${words(p.emergencyType)} emergency`,
  'emergency.cancelled': () => 'An emergency was cancelled by the household',
  'emergency.cancel_requested': () => 'Who raised an SOS asked to call it off: check on them, then resolve it',
  'emergency.family_alert': () => 'An emergency was reported from your unit',
  'emergency.responder_on_the_way': (p) => `A responder is on the way, about ${p.etaMinutes} minutes`,
  'gate_service.requested': (p) => `A resident asked security for ${words(p.serviceKind)}`,
  'partner_request.accepted': () => 'The partner accepted your request',
  'partner_request.declined': (p) => `The partner declined your request (${words(p.reason)})`,
  'partner_request.proposed': () => 'The partner proposed another time for your request',
  'partner_request.cancelled': (p) => `A partner request was cancelled (${words(p.reason)})`,
  'partner_request.done': () => 'The partner marked your request done',
  'partner_request.expired': () => 'Nobody accepted your partner request in time',
  'partner_request.awaiting_relay': (p) => `A resident asked a partner without a desk link: ${words(p.category)}`,
  'partner_complaint.decided': (p) => `Your complaint about a partner was decided: ${words(p.outcome)}`,
  'partner.suspended': () => 'A partner you asked or follow was suspended',
  // Decision appeals (ADR 0059).
  'decision_appeal.lodged': (p) => `A resident appealed a staff decision: ${words(p.kind)}`,
  'decision_appeal.decided': (p) =>
    `An appeal was ${p.outcome === 'overturned' ? 'overturned' : 'upheld'}: ${words(p.kind)}`,
  // The owners' voice, the board's side (ADR 0059): never who.
  'governance_agenda.proposed': () => 'An owner proposed a matter for the board’s agenda',
  'governance_objection.lodged': () => 'An owner objected to a decision of the board',
  'unit_permit.requested': (p) => `A unit asked for a permit: ${words(p.permitKind)}`,
  'unit_permit.approved': (p) => `Your permit was approved: ${words(p.permitKind)}`,
  'unit_permit.rejected': (p) => `Your permit was not approved (${words(p.reason)})`,
  'unit_permit.revoked': (p) => `Your permit was revoked (${words(p.reason)})`,
  'unit_permit.used': () => 'The goods on your permit went out at the gate',
  'unit_permit.cancelled': (p) => `A permit was cancelled (${words(p.reason)})`,
  // Governance (ADR 0051): codes only, never a name or a choice.
  'governance_election.awaiting_certification': (p) =>
    p.tied === 'yes' ? 'An election closed with a tie: record the board’s choice and certify it' : 'An election closed: certify its result',
  'governance_election.cancelled': (p) => `An election of the board was cancelled (${words(p.reason)})`,
  'governance_poll.result': (p) => `A poll of the owners closed: ${words(p.result)}`,
  // Board matters (ADR 0055): codes only, never a name, a vote or a reason.
  'governance_approval.raised': (p) => `${cap(aWords(p.type))} request awaits the board’s decision`,
  'governance_approval.decided': (p) => `The board ${p.decision === 'approved' ? 'approved' : 'rejected'} ${aWords(p.type)} request`,
  'governance_approval.overdue': (p) => `${cap(aWords(p.type))} request is past its deadline, undecided`,
  'governance_approval.implemented': (p) => `The management implemented an approved ${words(p.type)} request`,
  'governance_approval.withdrawn': (p) => `${cap(aWords(p.type))} request was withdrawn`,
  'governance_motion.proposed': (p) =>
    p.matter === 'appeal'
      ? 'A motion on an appeal awaits your vote'
      : p.matter === 'representative'
        ? 'A motion on a building’s representative awaits your vote'
        : 'A motion on a request awaits your vote',
  'governance_appeal.lodged': (p) => `${cap(aWords(p.kind))} was appealed to the board`,
  'governance_appeal.decided': (p) => `The board ${p.outcome === 'overturned' ? 'overturned' : 'upheld'} ${aWords(p.kind)} on appeal`,
  'governance_appeal.overdue': (p) => `An appeal of ${aWords(p.kind)} is past its deadline, undecided`,
  'gate_service.accepted': () => 'Security accepted your request',
  'gate_service.closed': (p) => `Security closed your request (${words(p.reason)})`,
  // Guard shifts and tasks (ADR 0050): codes only, never a name or a post.
  'guard_shift.absent': () => 'A guard did not start their shift',
  'guard_shift.absent_unmanned': () => 'A guard did not start their shift and nobody is on duty there',
  'guard_task.assigned': (p) => `A ${words(p.taskKind)} task for you`,
  'guard_task.unit_inspected': (p) => `Security inspected your closed unit (${words(p.outcome)})`,
  'guard_swap.requested': () => 'A colleague asks you to take one of their shifts',
  'guard_swap.accepted': () => 'A shift swap awaits your decision',
  'guard_swap.declined': () => 'Your colleague declined the shift swap',
  'guard_swap.approved': () => 'A shift swap was approved',
  'guard_swap.rejected': () => 'A shift swap was not approved',
  'guard_swap.expired': () => 'A shift swap expired: its shift started first',
  'guard_swap.cancelled': () => 'A shift swap no longer applies',
  'guard_instruction.issued': () => 'A new instruction to acknowledge',
  'guard_instruction.urgent': () => 'An urgent instruction to acknowledge',
  // Patrols (ADR 0052): codes only.
  'patrol.late': () => 'A patrol at your post has not started',
  'patrol.missed': () => 'A scheduled patrol was not started',
  'patrol.incomplete': (p) => `A patrol ended with checkpoints not scanned (${words(p.reason)})`,
  // The gate's completion (ADR 0056): codes only, never a name or a plate.
  'patrol.geofence_exit': (p) => `A guard on patrol was outside the route’s area for ${p.minutes} minutes or more`,
  'gate_exception.requested': (p) =>
    `A guard at ${p.gateName} asks to let ${EXCEPTION_KIND_TEXT[String(p.exceptionKind)] ?? 'someone'} in for unit ${p.unitCode}`,
  // The gate offline (ADR 0057): counts and codes only.
  'gate_device.enrolled': () => 'A guard enrolled a device for the gate offline',
  'gate_device.sync_overdue': (p) => `A gate device on shift has not been seen for ${p.minutes} minutes`,
  'gate_device.sequence_gap': (p) => `${p.missing} action(s) recorded offline on a gate device never arrived`,
  'gate_device.upload_rejected': (p) => `A gate device’s offline upload was refused (${words(p.reason)})`,
  'gate_offline.security_conflict': (p) => `A gate device synced ${p.flags} security conflict(s) from offline`,
  'gate_offline.conflicts': (p) => `A gate device synced ${p.flags} entry conflict(s) to review`,
  // The control room (ADR 0068): the event's code only.
  'control_room.alert': (p) => `Control room alert: ${words(p.eventKind)}`,
  'control_room.event': (p) => `Control room: ${words(p.eventKind)}`,
  'gate.call_incoming': (p) => `${p.gateName} is calling you`,
  // Security (ADR 0053): codes only, never a plate, a name, a unit or a word.
  'gate_lockdown.started': (p) => (p.scope === 'all' ? 'Every gate is locked down' : 'A gate is locked down'),
  'gate_lockdown.resident_notice': () => 'The compound’s gates are locked down for now',
  'gate_lockdown.ended': (p) => (p.scope === 'all' ? 'The lockdown of every gate ended' : 'A gate’s lockdown ended'),
  'blocklist.ban_matched': (p) =>
    p.source === 'offline_sync'
      ? 'A banned plate was let in while the gate was offline'
      : `A banned plate or person was refused at the gate (${words(p.source)})`,
  'blocklist.watch_matched': (p) => `A watched plate or person came to the gate (${words(p.source)})`,
  'unit_permit.work_stopped': (p) => `Security stopped the work on a permit (${words(p.reason)})`,
  'unit_permit.work_resumed': () => 'The work on a permit may go on',
  'unit_permit.refused_by_security': () => 'Security refused a guest or the truck of a permit',
  'visitor_pass.refused_by_security': () => 'Security refused your visitor at the gate',
  'incident.reported': (p) => `A ${words(p.severity)} ${words(p.incidentType)} incident was reported`,
  'incident.critical': (p) => `A critical ${words(p.incidentType)} incident was reported`,
  'incident.assigned': () => 'An incident was given to you to investigate',
  'violation.issued': (p) => `A ${words(p.violationKind)} violation was issued to your unit`,
  'violation.appeal_upheld': () => 'Your appeal of a violation was not accepted',
  'violation.appeal_accepted': () => 'Your appeal of a violation was accepted: it is cancelled',
  // Children (ADR 0054): the keepers are told of an unauthorized pickup only.
  'child.unauthorized_pickup': () => 'Someone not allowed tried to collect a child at the gate',
  'ticket.assigned': (p) => `${ticket(p)} is assigned to you · ${words(p.priority)} · ${words(p.categoryKey)}${inUnit(p)}`,
  'ticket.unassigned': (p) => `${ticket(p)} was given to someone else${inUnit(p)}`,
  'ticket.status_changed': (p) =>
    `${ticket(p)} is now ${words(p.status)}${p.holdReason ? ` (${words(p.holdReason)})` : ''}${inUnit(p)}`,
  'ticket.completed': (p) => `${ticket(p)} is done and waits for confirmation${inUnit(p)}`,
  'ticket.declined': (p) => `${ticket(p)} was declined by its technician and is back in the queue${inUnit(p)}`,
  'ticket.quote_suggested': (p) => `${ticket(p)}: the technician suggests a ${p.amount} EGP quote to send${inUnit(p)}`,
  'ticket.technician_unavailable': (p) => `${ticket(p)} is back in the queue: its technician is unavailable${inUnit(p)}`,
  'ticket.priority_changed': (p) => `${ticket(p)} is now ${words(p.priority)} priority${inUnit(p)}`,
  'ticket.rejected': (p) => `${ticket(p)}: the reporter rejected the work (${p.rejectionCount}×)${inUnit(p)}`,
  'ticket.reopened': (p) => `${ticket(p)} was reopened by its reporter (${p.rejectionCount}×)${inUnit(p)}`,
  'ticket.escalated': (p) => `${ticket(p)} was rejected ${p.rejectionCount} times and needs a look${inUnit(p)}`,
  'ticket.auto_closed': (p) => `${ticket(p)} was closed: nobody confirmed in time${inUnit(p)}`,
  'ticket.message': (p) => `New message on ${aTicket(p)}${inUnit(p)}`,
  'ticket.opened_on_behalf': (p) => `${ticket(p)} was opened in your name${inUnit(p)}`,
  'ticket.unassignable': (p) => `${ticket(p)} has no technician who can take it · ${words(p.categoryKey)}${inUnit(p)}`,
  'ticket.unassignable_emergency': (p) =>
    `Emergency ${aTicket(p)} has no technician who can take it · ${words(p.categoryKey)}${inUnit(p)}`,
  'ticket.sla_breached': (p) => `${ticket(p)} passed its ${words(p.clock)} target`,
  'ticket.sla_breached_emergency': (p) => `Emergency ${aTicket(p)} passed its ${words(p.clock)} target`,
  'ticket.resident_escalated': (p) => `A resident asked for attention on overdue ${aTicket(p)}`,
  'ticket.resident_escalated_emergency': (p) => `A resident asked for attention on overdue emergency ${aTicket(p)}`,
  'ticket.visit_proposed': (p) => `${ticket(p)}: a visit is proposed for ${windowText(p)}`,
  'ticket.visit_confirmed': (p) => `${ticket(p)}: the visit is confirmed for ${windowText(p)}`,
  'ticket.visit_cancelled': (p) => `${ticket(p)}: the visit of ${windowText(p)} was cancelled`,
  'ticket.visit_arrived': (p) => `${ticket(p)}: the technician has arrived`,
  'ticket.visit_arrival_confirmed': (p) => `${ticket(p)}: the residents confirmed the arrival`,
  'ticket.visit_no_access': (p) => `${ticket(p)}: nobody let the technician in (${windowText(p)})`,
  'ticket.visit_late': (p) => `${ticket(p)}: the technician is late for the visit of ${windowText(p)}`,
  'ticket.visit_consent_granted': (p) => `${ticket(p)}: entry was allowed while nobody is home (${windowText(p)})`,
  'ticket.category_changed': (p) => `${ticket(p)} is now under ${words(p.categoryKey)}${inUnit(p)}`,
  'parcel.arrived': (p) => `A parcel from ${words(p.carrier)} (${pieces(p)}) is at the gate for unit ${p.unitCode}`,
  'parcel.collected': (p) => `A parcel from ${words(p.carrier)} (${pieces(p)}) of unit ${p.unitCode} was handed over`,
  'parcel.reminder': (p) => `A parcel from ${words(p.carrier)} has waited ${days(p)} at the gate for unit ${p.unitCode}`,
  'parcel.held_long': (p) => `Parcel ${p.parcelNumber} (${words(p.carrier)}) has waited ${days(p)} for unit ${p.unitCode}`,
  'parcel.rejected': (p) => `Parcel ${p.parcelNumber} (${words(p.carrier)}) was refused by the unit: send it back`,
  'parcel.unclaimable': (p) => `Parcel ${p.parcelNumber} (${words(p.carrier)}) arrived for unit ${p.unitCode}, where nobody can collect it`,
  // Requests to the management (ADR 0039): the number and the topic, never what was written.
  'management_request.created': (p) => `${request(p)} is new`,
  'management_request.assigned': (p) => `${request(p)} was assigned to you`,
  'management_request.escalated': (p) => `${request(p)} is overdue: nobody has responded`,
  'management_request.resident_replied': (p) => `${request(p)}: the resident wrote`,
  'management_request.reopened': (p) => `${request(p)} was reopened by the resident`,
  'management_request.withdrawn': (p) => `${request(p)} was withdrawn by the resident`,
  'management_appointment.requested': (p) => `${request(p)}: the resident picked an appointment slot`,
  'management_appointment.accepted': (p) => `${request(p)}: the resident accepted the proposed slot`,
  'management_appointment.cancelled_by_resident': (p) => `${request(p)}: the resident cancelled the appointment`,
  // The resident's side: read here only by someone who is both.
  'management_request.replied': (p) => `${request(p)}: the management replied`,
  'management_request.status_changed': (p) => `${request(p)} has moved`,
  'management_request.auto_closed': (p) => `${request(p)} was closed: no reply to the answer`,
  'management_request.opened_for_you': (p) => `${request(p)} was opened for you by the management`,
  'management_appointment.proposed': (p) => `${request(p)}: the management proposed an appointment slot`,
  'management_appointment.countered': (p) => `${request(p)}: the management proposed another slot`,
  'management_appointment.confirmed': (p) => `${request(p)}: the appointment is confirmed`,
  'management_appointment.cancelled': (p) => `${request(p)}: the management cancelled the appointment`,
  // Community life (ADR 0040): what happened, never a word anyone wrote.
  'community_announcement.important': () => 'An important announcement was published',
  'community_event.cancelled': () => 'An event you said you are going to was cancelled',
  'community_suggestion.status_changed': (p) => `Your suggestion about ${words(p.topicKey)} is now ${words(p.status)}`,
  // Neighbours (ADR 0042): the number and the category, or the kind of a
  // post; never a message, a notice's text, a unit or a name.
  'neighbour_complaint.submitted': (p) => `${complaint(p)} is new`,
  'neighbour_complaint.author_replied': (p) => `${complaint(p)}: the complainant wrote`,
  'neighbour_complaint.withdrawn': (p) => `${complaint(p)} was withdrawn by the complainant`,
  'neighbour_notice.unit_replied': (p) => `${complaint(p)}: the unit answered its notice`,
  'neighbour_item.claimed': (p) => `A resident claimed a ${post(p)} at the desk`,
  'neighbour_conversation.reported': () => 'A resident reported a conversation about a post',
  // The residents' side: read here only by someone who is both.
  'neighbour_complaint.under_review': (p) => `${complaint(p)} is under review`,
  'neighbour_complaint.in_mediation': (p) => `${complaint(p)} is in mediation`,
  'neighbour_complaint.resolved': (p) => `${complaint(p)} was resolved`,
  'neighbour_complaint.dismissed': (p) => `${complaint(p)} was dismissed`,
  'neighbour_complaint.replied': (p) => `${complaint(p)}: the management wrote`,
  'neighbour_complaint.notice_sent': (p) => `${complaint(p)}: the management sent the unit a notice`,
  'neighbour_notice.received': (p) => `The management sent your unit a notice about ${words(p.categoryKey)}`,
  'neighbour_notice.replied': (p) => `The management wrote again on your unit’s notice about ${words(p.categoryKey)}`,
  'neighbour_item.handed_over': (p) => `The ${post(p)} was handed over to you at the office`,
  'neighbour_claim.declined': (p) => `Your claim on a ${post(p)} was declined`,
  'neighbour_post.removed': (p) => `Your ${post(p)} was removed from its board by the management`,
  'neighbour_conversation.started': (p) => `A neighbour wrote to you about your ${post(p)}`,
  'neighbour_conversation.message': (p) => `New message in a conversation about a ${post(p)}`,
  'neighbour_conversation.reveal_requested': (p) => `A neighbour agreed to show names in a conversation about a ${post(p)}`,
  'neighbour_conversation.names_revealed': (p) => `Names are now shown in a conversation about a ${post(p)}`,
  'neighbour_report.closed': () => 'Your report of a conversation was looked at',
  'neighbours.welcome': () => 'Welcome: the compound’s rules, office hours and emergency numbers are ready to read',
  // Bookings and the club (ADR 0044): to residents.
  'booking.approved': () => 'Your booking was approved',
  'booking.rejected': (p) => `Your booking was not approved (${words(p.reason)})`,
  'booking.approval_expired': () => 'Your booking request was not approved in time',
  'booking.cancelled_by_staff': (p) => `The management cancelled your booking (${words(p.reason)})`,
  'booking.cancelled_by_closure': (p) => `Your booking was cancelled: the facility is closed (${words(p.reason)})`,
  'booking.reminder': () => 'Your booking starts in about two hours',
  'booking_suspension.started': () => 'Your unit cannot make new bookings for a while',
  'facility_ban.started': (p) =>
    `You may not book ${p.scope === 'all' ? 'any facility' : 'this facility'}${p.until ? ` until ${p.until}` : ''}`,
  'facility_ban.lifted': () => 'You may book again',
  'club_membership.expiring': () => 'Your club membership ends within a week',
  // The asset register, plans and inspections (ADR 0064).
  'asset.warranty_expiring': (p) => `The warranty of asset ${p.assetRef} ends on ${p.endsOn}`,
  'stock.reorder_level': (p) => `${p.itemRef} is at or under its reorder level`,
  'maintenance_contract.expiring': (p) => `Contract ${p.contractRef} ends on ${p.endsOn}`,
  'meter.anomaly': (p) => `Meter ${p.meterRef} used far more than usual up to ${p.readOn}`,
  'part_request.created': (p) => `${ticket(p)} asks the store for ${p.itemRef}`,
  'maintenance.plan_overdue': (p) => `Planned work on asset ${p.assetRef}, due ${p.dueOn}, is overdue`,
  'inspection.assigned': (p) => `An inspection of ${p.targetRef} is yours, due ${p.dueOn}`,
  'inspection.overdue': (p) => `The inspection of ${p.targetRef}, due ${p.dueOn}, is overdue`,
  'asset.replacement_recommended': (p) => `A technician recommends replacing asset ${p.assetRef}`,
  'readiness_item.assigned': (p) => `An item of a readiness program is yours, due ${p.dueOn}`,
  'readiness_item.overdue': (p) => `Your readiness item, due ${p.dueOn}, is overdue`,
  'work_permit.requested': (p) => `${ticket(p)} asks for a ${words(p.hazard)} permit`,
  'work_permit.approved': (p) => `The ${words(p.hazard)} permit for ${aTicket(p)} is approved`,
  'work_permit.rejected': (p) => `The ${words(p.hazard)} permit for ${aTicket(p)} was rejected`,
  'work_permit.revoked': (p) => `The ${words(p.hazard)} permit for ${aTicket(p)} was revoked`,
  // Money and the unit (ADR 0069): what the finance staff are asked for.
  'instalment_plan_request.submitted': () => 'A resident asked for a payment plan on an invoice',
  'collector_visit.requested': () => 'A resident asked for a collector to take cash at their unit',
};

export function notificationText(n: NotificationLike): string {
  const render = TEXT[n.kind];
  if (!render) return words(n.kind).replace(/^./, (c) => c.toUpperCase());
  return render(n.params);
}

/**
 * Where a notification leads in this dashboard, or null. `can` is the
 * reader's permissions: a link is offered only where the page would open.
 */
export function notificationHref(n: NotificationLike, can: (permission: string) => boolean): string | null {
  // A part request is the store's to answer, on its queue (ADR 0065).
  if (n.kind === 'part_request.created') return can('stock.manage') ? '/stock/part-requests' : null;
  if (n.targetType === 'ticket' && n.targetId) return can('tickets.dispatch') ? `/maintenance/${n.targetId}` : null;
  // The asset register (ADR 0064).
  if (n.targetType === 'asset' && n.targetId) return can('assets.read') ? `/assets/${n.targetId}` : null;
  if (n.targetType === 'stock_item' && n.targetId) return can('stock.manage') ? `/stock/${n.targetId}` : null;
  if (n.targetType === 'maintenance_contract' && n.targetId) return can('assets.manage') ? `/contracts/${n.targetId}` : null;
  // Energy (ADR 0066).
  if (n.targetType === 'meter' && n.targetId) return can('energy.read') ? `/meters/${n.targetId}` : null;
  // Readiness (ADR 0067): the program, for who keeps readiness.
  if (n.targetType === 'readiness_program' && n.targetId) return can('readiness.manage') ? `/readiness/${n.targetId}` : null;
  // Money and the unit (ADR 0069): the finance staff's queues.
  if (n.targetType === 'plan_request') return can('finance.invoice') ? '/finance/plan-requests' : null;
  if (n.targetType === 'collector_visit') return can('finance.payments') ? '/finance/collector-visits' : null;
  if (n.targetType === 'maintenance_plan' && n.targetId) return can('assets.read') ? `/maintenance-plans/${n.targetId}` : null;
  if (n.targetType === 'inspection' && n.targetId) return can('inspections.manage') ? `/inspections/${n.targetId}` : null;
  if (n.targetType === 'asset_replacement_recommendation') return can('assets.manage') ? '/replacement-recommendations' : null;
  if (n.targetType === 'parcel' && n.targetId) return can('parcels.manage') ? `/parcels?parcel=${n.targetId}` : null;
  if (n.targetType === 'management_request' && n.targetId)
    return can('requests.handle') ? `/management-requests/${n.targetId}` : null;
  if (n.targetType === 'community_announcement' && n.targetId)
    return can('community.publish') ? `/announcements/${n.targetId}` : null;
  if (n.targetType === 'community_event' && n.targetId) return can('community.publish') ? `/events/${n.targetId}` : null;
  if (n.targetType === 'community_suggestion' && n.targetId)
    return can('community.suggestions') ? `/suggestions/${n.targetId}` : null;
  // Neighbours (ADR 0042). A notice, a conversation and the welcome are the
  // residents' own: nothing in this dashboard opens them.
  if (n.targetType === 'neighbour_complaint' && n.targetId) return can('neighbours.handle') ? `/complaints/${n.targetId}` : null;
  if (n.targetType === 'neighbour_post' && n.targetId) return can('neighbours.handle') ? `/lost-found/${n.targetId}` : null;
  if (n.targetType === 'neighbour_report' && n.targetId)
    return can('neighbours.handle') ? `/conversation-reports/${n.targetId}` : null;
  if (n.targetType === 'emergency')
    return can('emergencies.manage') || can('emergencies.respond') ? '/emergencies' : null;
  if (n.targetType === 'gate_service_request') return can('gate_services.handle') ? '/gate-services' : null;
  if (n.targetType === 'unit_permit' && n.targetId) return can('permits.manage') ? `/permits/${n.targetId}` : null;
  // Partners (ADR 0060): a request to relay, to its page for whoever keeps the partners.
  if (n.targetType === 'partner_request' && n.targetId)
    return can('partners.manage') ? `/partners/requests/${n.targetId}` : null;
  if (n.targetType === 'partner_complaint' && n.targetId)
    return can('partners.manage') ? `/partners/complaints/${n.targetId}` : null;
  if (n.targetType === 'partner' && n.targetId) return can('partners.manage') ? `/partners/${n.targetId}` : null;
  // Decision appeals (ADR 0059): to the appeal, for whoever decides them.
  if (n.targetType === 'decision_appeal' && n.targetId)
    return can('appeals.decide') ? `/appeals/${n.targetId}` : null;
  // Guard shifts and tasks (ADR 0050): the keepers' pages. A task, an
  // instruction or a swap to answer is a guard's, in the app.
  if (n.targetType === 'guard_roster_slot') return can('guard_roster.manage') ? '/security/roster' : null;
  if (n.targetType === 'guard_shift_swap') return can('guard_roster.manage') ? '/security/swaps' : null;
  if (n.targetType === 'guard_task') return can('guard_tasks.manage') ? '/security/tasks' : null;
  if (n.targetType === 'guard_instruction') return can('guard_instructions.manage') ? '/security/instructions' : null;
  if (n.targetType === 'governance_election' && n.targetId)
    return can('governance.manage') ? `/governance/elections/${n.targetId}` : null;
  if (n.targetType === 'governance_poll' && n.targetId)
    return can('governance.manage') ? `/governance/polls/${n.targetId}` : null;
  // Board matters (ADR 0055): a member to the board's page, the management to its own.
  if (n.targetType === 'governance_approval' && n.targetId) {
    if (can('governance.board')) return `/board/approvals/${n.targetId}`;
    return can('governance.approvals') ? `/governance/approvals/${n.targetId}` : null;
  }
  if (n.targetType === 'board_motion') {
    if (!can('governance.board')) return null;
    if (n.params.matter === 'appeal') return '/board/appeals';
    return n.params.matter === 'representative' ? '/board/representatives' : '/board/approvals';
  }
  // The owners' voice (ADR 0059): a proposal or a decision's objections, to the board's page.
  if (n.targetType === 'governance_agenda_proposal' && n.targetId)
    return can('governance.board') ? `/board/agenda/${n.targetId}` : null;
  if (n.targetType === 'board_publication' && n.kind === 'governance_objection.lodged' && n.targetId)
    return can('governance.board') ? `/board/objections/${n.targetId}` : null;
  if (n.targetType === 'governance_board_appeal' && n.targetId) {
    if (can('governance.board')) return `/board/appeals/${n.targetId}`;
    return can('governance.manage') ? `/governance/board-appeals/${n.targetId}` : null;
  }
  // Patrols (ADR 0052): a run's page for whoever reads the runs.
  if (n.targetType === 'patrol_run') return can('patrols.manage') || can('guard_reports.read') ? '/security/patrols/runs' : null;
  // Security (ADR 0053): each keeper's page.
  if (n.targetType === 'gate_lockdown') return can('lockdown.end') ? '/security/lockdowns' : null;
  if (n.targetType === 'blocklist_entry' && n.targetId)
    return can('blocklist.manage') ? `/security/blocklist?entry=${n.targetId}` : null;
  if (n.targetType === 'incident' && n.targetId)
    return can('incidents.manage') ? `/security/incidents?incident=${n.targetId}` : null;
  if (n.targetType === 'unit_violation' && n.targetId)
    return can('violations.manage') || can('violations.issue') || can('fines.billing') ? `/violations?violation=${n.targetId}` : null;
  // The gate offline (ADR 0057): a device, or an uploaded batch's flags.
  if (n.targetType === 'gate_device' && n.targetId)
    return can('gate_devices.manage') ? `/security/gate-devices?device=${n.targetId}` : null;
  if (n.targetType === 'gate_offline_batch' && n.targetId)
    return can('gate_devices.manage') ? `/security/offline-flags?batch=${n.targetId}` : null;
  // The control room's channel (ADR 0068).
  if (n.targetType === 'control_room_event' && n.targetId)
    return can('control_room.watch') ? `/security/control-room?event=${n.targetId}` : null;
  // A field exception to answer (ADR 0056), for the on-duty management.
  if (n.targetType === 'gate_field_exception' && n.targetId)
    return can('gate_exceptions.decide') ? `/security/field-exceptions?exception=${n.targetId}` : null;
  // Children (ADR 0054): an unauthorized pickup's alert, for the keepers.
  if (n.targetType === 'child_pickup' && n.targetId)
    return can('guard_roster.manage') ? `/security/child-alerts?open=${n.targetId}` : null;
  if (n.kind === 'account.deletion_queued') return can('accounts.erase') ? '/deletions' : null;
  if (n.kind === 'account.new_device_login') return '/account';
  if (n.targetType === 'worker_engagement') return can('workers.review') ? '/workers?tab=all' : null;
  return null;
}

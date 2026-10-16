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
  'emergency.family_alert': () => 'An emergency was reported from your unit',
  'emergency.responder_on_the_way': (p) => `A responder is on the way, about ${p.etaMinutes} minutes`,
  'gate_service.requested': (p) => `A resident asked security for ${words(p.serviceKind)}`,
  'unit_permit.requested': (p) => `A unit asked for a permit: ${words(p.permitKind)}`,
  'unit_permit.approved': (p) => `Your permit was approved: ${words(p.permitKind)}`,
  'unit_permit.rejected': (p) => `Your permit was not approved (${words(p.reason)})`,
  'unit_permit.revoked': (p) => `Your permit was revoked (${words(p.reason)})`,
  'unit_permit.cancelled': (p) => `A permit was cancelled (${words(p.reason)})`,
  'gate_service.accepted': () => 'Security accepted your request',
  'gate_service.closed': (p) => `Security closed your request (${words(p.reason)})`,
  'ticket.assigned': (p) => `${ticket(p)} is assigned to you · ${words(p.priority)} · ${words(p.categoryKey)}${inUnit(p)}`,
  'ticket.unassigned': (p) => `${ticket(p)} was given to someone else${inUnit(p)}`,
  'ticket.status_changed': (p) =>
    `${ticket(p)} is now ${words(p.status)}${p.holdReason ? ` (${words(p.holdReason)})` : ''}${inUnit(p)}`,
  'ticket.completed': (p) => `${ticket(p)} is done and waits for confirmation${inUnit(p)}`,
  'ticket.declined': (p) => `${ticket(p)} was declined by its technician and is back in the queue${inUnit(p)}`,
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
  'club_membership.expiring': () => 'Your club membership ends within a week',
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
  if (n.targetType === 'ticket' && n.targetId) return can('tickets.dispatch') ? `/maintenance/${n.targetId}` : null;
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
  if (n.kind === 'account.deletion_queued') return can('accounts.erase') ? '/deletions' : null;
  if (n.kind === 'account.new_device_login') return '/account';
  if (n.targetType === 'worker_engagement') return can('workers.review') ? '/workers?tab=all' : null;
  return null;
}

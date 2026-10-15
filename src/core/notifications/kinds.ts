import type {
  DeliveryClass,
  NotificationCategory,
} from '../preferences/categories';

/**
 * The notification catalog (ADR 0027), like the audit catalog: every kind a
 * domain may write is declared here with its priority, what it points at
 * and the params it carries. The inbox stores codes and params, never text;
 * the apps render them in the reader's language (ADR 0013).
 *
 * A param is `personal` when it names a person outside the recipient's
 * account (a visitor, a worker). Personal params are scrubbed when the data
 * they came from expires, and never hold a document, phone or code (a unit
 * test checks the names).
 *
 * Every kind also declares its delivery category and whether it is critical
 * (ADR 0036). The inbox always records it; the preferences decide only the
 * delivery channels (email now, push later). Critical kinds: security
 * (a new device logged in, a new entry device), emergency tickets, staff
 * work (a ticket assigned to me, a gate approval request and its reversal),
 * and the deletion notices (confirmation, reminder, delay).
 */
export type NotificationPriority = 'normal' | 'critical';

export interface ParamSpec {
  personal?: boolean;
  optional?: boolean;
}

export interface KindSpec {
  /** How the inbox shows it (the critical-unread badge). */
  priority: NotificationPriority;
  /** Which preference switch governs its delivery (ADR 0036). */
  category: NotificationCategory;
  /**
   * Delivered on every channel whatever the preferences say: never muted,
   * never held by quiet hours or a pause (ADR 0036). A unit test fails if a
   * kind does not say.
   */
  critical: boolean;
  /** What `targetId` refers to; the apps open it. */
  target: string;
  params: Record<string, ParamSpec>;
}

export const NOTIFICATION_KINDS = {
  /** A guard asks the household whether to let someone in (ADR 0028). */
  'gate.approval_requested': {
    priority: 'critical',
    category: 'gate_visitors',
    critical: true,
    target: 'gate_approval_request',
    params: {
      unitCode: {},
      requestKind: {},
      partySize: {},
      gateName: {},
      visitorName: { personal: true, optional: true },
      workerName: { personal: true, optional: true },
    },
  },
  /** A household reversed an approval before the entry: stop them. */
  'gate.approval_reversed': {
    priority: 'critical',
    category: 'gate_visitors',
    critical: true,
    target: 'gate_approval_request',
    params: { unitCode: {}, requestKind: {} },
  },
  'worker.entered': {
    priority: 'normal',
    category: 'gate_visitors',
    critical: false,
    target: 'worker_engagement',
    params: {
      unitCode: {},
      gateName: {},
      workerName: { personal: true },
    },
  },
  'worker.exited': {
    priority: 'normal',
    category: 'gate_visitors',
    critical: false,
    target: 'worker_engagement',
    params: {
      unitCode: {},
      gateName: {},
      workerName: { personal: true },
    },
  },
  /**
   * The person the host sent a pass link to said "this isn't me" on the
   * public page (ADR 0030): the pass is cancelled. Nothing about who.
   */
  'visitor_pass.not_me': {
    priority: 'normal',
    category: 'gate_visitors',
    critical: false,
    target: 'visitor_pass',
    params: { unitCode: {} },
  },
  /**
   * A phone was registered for the account's entry QR (ADR 0031). A stolen
   * account's first move is to register a phone and walk in: the owner must
   * see it and may revoke it. Nothing about the device.
   */
  'entry_credential.issued': {
    priority: 'normal',
    category: 'account_security',
    critical: true,
    target: 'entry_credential',
    params: {},
  },
  /**
   * Someone logged in to the account from a device never seen on it
   * (ADR 0036). The coarse device type and the time, never an IP or a
   * place. Its "not me" acts on the device (`POST /me/devices/{id}/not-me`).
   */
  'account.new_device_login': {
    priority: 'critical',
    category: 'account_security',
    critical: true,
    target: 'known_device',
    params: { deviceType: {}, at: {} },
  },
  /**
   * The account's personal-data export is ready (ADR 0036). No link: the
   * app downloads it with the account's own session, until `expiresAt`.
   */
  'data_export.ready': {
    priority: 'normal',
    category: 'account_security',
    critical: false,
    target: 'data_export',
    params: { expiresAt: {} },
  },
  /**
   * A family member's account was deleted (ADR 0036), to the unit's
   * primary: the unit's code only, never who or why.
   */
  'household.member_account_deleted': {
    priority: 'normal',
    category: 'household',
    critical: false,
    target: 'household_member',
    params: { unitCode: {} },
  },
  // Account deletion (ADR 0036). The confirmation, the reminder and the
  // delay are critical: pause and quiet hours never hold them.
  /** The request was filed (by the account or for it): undo until `effectiveAt`. */
  'account.deletion_requested': {
    priority: 'critical',
    category: 'account_security',
    critical: true,
    target: 'account_deletion_request',
    params: { effectiveAt: {} },
  },
  /** Two days before the erasure. */
  'account.deletion_reminder': {
    priority: 'critical',
    category: 'account_security',
    critical: true,
    target: 'account_deletion_request',
    params: { effectiveAt: {} },
  },
  /** Not erased: something blocks it (blocker codes, comma-separated). */
  'account.deletion_delayed': {
    priority: 'critical',
    category: 'account_security',
    critical: true,
    target: 'account_deletion_request',
    params: { blockers: {} },
  },
  /** A blocked request waits in the queue (the `accounts.erase` holders). */
  'account.deletion_queued': {
    priority: 'normal',
    category: 'account_security',
    critical: false,
    target: 'account_deletion_request',
    params: { blockers: {} },
  },
  /** A manager closed the queued request without erasing. */
  'account.deletion_closed': {
    priority: 'normal',
    category: 'account_security',
    critical: false,
    target: 'account_deletion_request',
    // The close reason's code (a param named `…Code` reads as a secret).
    params: { reason: {} },
  },
  /**
   * A manager acted for the account (ADR 0036): what (`action`) and how the
   * person asked (`reason`, a code). Never who.
   */
  'account.assisted_action': {
    priority: 'normal',
    category: 'account_security',
    critical: false,
    target: 'account',
    params: { action: {}, reason: {} },
  },
  // --------------------------------------------------------------------------
  // Maintenance (ADR 0032). The ticket number and codes only: never the
  // description, a common-area label (free text, so a common-area ticket
  // has no unitCode), a message or anyone's contact data.
  // --------------------------------------------------------------------------
  /** Opened at emergency priority (or raised to it): every dispatcher, now. */
  'ticket.emergency': {
    priority: 'critical',
    category: 'maintenance',
    critical: true,
    target: 'ticket',
    params: {
      ticketNumber: {},
      unitCode: { optional: true },
      categoryKey: {},
    },
  },
  /** A ticket is yours now (the technician). */
  'ticket.assigned': {
    priority: 'normal',
    category: 'maintenance',
    critical: true,
    target: 'ticket',
    params: {
      ticketNumber: {},
      unitCode: { optional: true },
      priority: {},
      categoryKey: {},
    },
  },
  /** Reassigned to someone else: the old technician no longer sees it. */
  'ticket.unassigned': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, unitCode: { optional: true } },
  },
  /** The reporter's ticket moved (assigned, started, on hold, resumed…). */
  'ticket.status_changed': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: {
      ticketNumber: {},
      unitCode: { optional: true },
      status: {},
      holdReason: { optional: true },
    },
  },
  /** The work is done: please confirm, or reject (the reporter). */
  'ticket.completed': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, unitCode: { optional: true } },
  },
  /** A technician declined it: it is back in the queue (dispatchers). */
  'ticket.declined': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, unitCode: { optional: true } },
  },
  /** Its technician can no longer work: back in the queue (dispatchers). */
  'ticket.technician_unavailable': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, unitCode: { optional: true } },
  },
  /** A dispatcher changed the priority of the technician's ticket. */
  'ticket.priority_changed': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, unitCode: { optional: true }, priority: {} },
  },
  /** The reporter rejected the work (dispatchers, and the technician it returns to). */
  'ticket.rejected': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: {
      ticketNumber: {},
      unitCode: { optional: true },
      rejectionCount: {},
    },
  },
  /** The reporter reopened a closed ticket (as a rejection). */
  'ticket.reopened': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: {
      ticketNumber: {},
      unitCode: { optional: true },
      rejectionCount: {},
    },
  },
  /** Rejected or reopened again: back in the queue, to look at (dispatchers). */
  'ticket.escalated': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: {
      ticketNumber: {},
      unitCode: { optional: true },
      rejectionCount: {},
    },
  },
  /** Nobody confirmed in time: closed (the reporter may still reopen). */
  'ticket.auto_closed': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, unitCode: { optional: true } },
  },
  /** A new message on a ticket the reader may see; never its body. */
  'ticket.message': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, unitCode: { optional: true } },
  },
  /** Dispatch opened a ticket in the reporter's name. */
  'ticket.opened_on_behalf': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, unitCode: { optional: true } },
  },
  // Dispatch (ADR 0033). The engine found nobody to give the ticket to: the
  // dispatchers, once per ticket and cycle. Two kinds because the priority
  // belongs to the kind.
  /** The queued ticket has no technician who can take it (dispatchers). */
  'ticket.unassignable': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: {
      ticketNumber: {},
      unitCode: { optional: true },
      categoryKey: {},
    },
  },
  /** The same, for an emergency. */
  'ticket.unassignable_emergency': {
    priority: 'critical',
    category: 'maintenance',
    critical: true,
    target: 'ticket',
    params: {
      ticketNumber: {},
      unitCode: { optional: true },
      categoryKey: {},
    },
  },
  // Visits and the SLA (ADR 0034).
  // An SLA clock passed its target: dispatchers and managers. The number and
  // the clock only. Two kinds because the priority belongs to the kind.
  /** An SLA clock (response or resolution) passed its target. */
  'ticket.sla_breached': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, clock: {} },
  },
  /** The same, on an emergency. */
  'ticket.sla_breached_emergency': {
    priority: 'critical',
    category: 'maintenance',
    critical: true,
    target: 'ticket',
    params: { ticketNumber: {}, clock: {} },
  },
  // ADR 0038: a resident asked for attention on an overdue ticket. The
  // ticket number only, like a breach.
  /** A resident escalated an overdue ticket (the dispatchers and managers). */
  'ticket.resident_escalated': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {} },
  },
  /** The same, on an emergency. */
  'ticket.resident_escalated_emergency': {
    priority: 'critical',
    category: 'maintenance',
    critical: true,
    target: 'ticket',
    params: { ticketNumber: {} },
  },
  // A visit (ADR 0034): the ticket number and the window, nothing else —
  // never the unit's code (a window and a unit say which home is empty
  // when), never consent or a receiver.
  /** A window is proposed (to the other side). */
  'ticket.visit_proposed': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, startsAt: {}, endsAt: {} },
  },
  /** The other side confirmed the window. */
  'ticket.visit_confirmed': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, startsAt: {}, endsAt: {} },
  },
  /** The visit was cancelled (by a side or by the system). */
  'ticket.visit_cancelled': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, startsAt: {}, endsAt: {} },
  },
  /** The technician is at the door (the residents). */
  'ticket.visit_arrived': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, startsAt: {}, endsAt: {} },
  },
  /** The residents' side confirmed the arrival (the technician, ADR 0038). */
  'ticket.visit_arrival_confirmed': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, startsAt: {}, endsAt: {} },
  },
  /** Nobody let the technician in: choose a new time (the residents). */
  'ticket.visit_no_access': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, startsAt: {}, endsAt: {} },
  },
  /** Confirmed, and not arrived 15 minutes after the start (residents, dispatch). */
  'ticket.visit_late': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, startsAt: {}, endsAt: {} },
  },
  /**
   * Someone other than the primary allowed the technician in while nobody
   * is home (to the primary, who may revoke it until the arrival).
   */
  'ticket.visit_consent_granted': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, startsAt: {}, endsAt: {} },
  },
  /** A dispatcher corrected the category of the technician's ticket. */
  'ticket.category_changed': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: {
      ticketNumber: {},
      unitCode: { optional: true },
      categoryKey: {},
    },
  },
  // --------------------------------------------------------------------------
  // Parcels (ADR 0035). The carrier, the pieces, the unit, the parcel number
  // and a time: never a name (the label's, a delegate's) and never a code,
  // which the resident reads from the parcel in a no-store response.
  // --------------------------------------------------------------------------
  /** A parcel is at the gate for your unit (every eligible occupant). */
  'parcel.arrived': {
    priority: 'normal',
    category: 'parcels',
    critical: false,
    target: 'parcel',
    params: { carrier: {}, pieces: {}, receivedAt: {}, unitCode: {} },
  },
  /**
   * A parcel was handed over: the unit's other residents (ADR 0035). How it
   * went (`method`: code, resident_qr, delegate), never to whom.
   */
  'parcel.collected': {
    priority: 'normal',
    category: 'parcels',
    critical: false,
    target: 'parcel',
    params: { carrier: {}, pieces: {}, unitCode: {}, method: {} },
  },
  /** A parcel has waited for its residents (once, at the reminder days). */
  'parcel.reminder': {
    priority: 'normal',
    category: 'parcels',
    critical: false,
    target: 'parcel',
    params: { carrier: {}, pieces: {}, days: {}, unitCode: {} },
  },
  /** A parcel has been held a long time (the managers, once). */
  'parcel.held_long': {
    priority: 'normal',
    category: 'parcels',
    critical: false,
    target: 'parcel',
    params: { parcelNumber: {}, unitCode: {}, carrier: {}, days: {} },
  },
  /** A resident said "not mine": the guards, to send it back (ADR 0035). */
  'parcel.rejected': {
    priority: 'normal',
    category: 'parcels',
    critical: false,
    target: 'parcel',
    params: { parcelNumber: {}, carrier: {} },
  },
  /** A parcel arrived for a unit nobody can collect for (the managers, once). */
  'parcel.unclaimable': {
    priority: 'normal',
    category: 'parcels',
    critical: false,
    target: 'parcel',
    params: { parcelNumber: {}, unitCode: {}, carrier: {} },
  },
  // Requests to the management (ADR 0039). No kind is critical. Params are
  // the request number and the topic's key only: never a message, a note, a
  // rating or a name. The target is always the request.
  /** The management wrote on the author's request (a reply, or the official one); never its body. */
  'management_request.replied': {
    priority: 'normal',
    category: 'management',
    critical: false,
    target: 'management_request',
    params: { requestNumber: {}, topicKey: {} },
  },
  /** The management took the author's request in hand, or closed it. */
  'management_request.status_changed': {
    priority: 'normal',
    category: 'management',
    critical: false,
    target: 'management_request',
    params: { requestNumber: {}, topicKey: {} },
  },
  /** The author's answered request closed itself after the compound's days. */
  'management_request.auto_closed': {
    priority: 'normal',
    category: 'management',
    critical: false,
    target: 'management_request',
    params: { requestNumber: {}, topicKey: {} },
  },
  /** The management opened a request in the author's name. */
  'management_request.opened_for_you': {
    priority: 'normal',
    category: 'management',
    critical: false,
    target: 'management_request',
    params: { requestNumber: {}, topicKey: {} },
  },
  /** The management proposed a slot (the author accepts, or picks another). */
  'management_appointment.proposed': {
    priority: 'normal',
    category: 'management',
    critical: false,
    target: 'management_request',
    params: { requestNumber: {}, topicKey: {} },
  },
  /** The management proposed another slot instead of the author's pick. */
  'management_appointment.countered': {
    priority: 'normal',
    category: 'management',
    critical: false,
    target: 'management_request',
    params: { requestNumber: {}, topicKey: {} },
  },
  /** The management confirmed the author's slot. */
  'management_appointment.confirmed': {
    priority: 'normal',
    category: 'management',
    critical: false,
    target: 'management_request',
    params: { requestNumber: {}, topicKey: {} },
  },
  /** The management cancelled the author's appointment. */
  'management_appointment.cancelled': {
    priority: 'normal',
    category: 'management',
    critical: false,
    target: 'management_request',
    params: { requestNumber: {}, topicKey: {} },
  },
  /** A new request (whoever handles requests). */
  'management_request.created': {
    priority: 'normal',
    category: 'management',
    critical: false,
    target: 'management_request',
    params: { requestNumber: {}, topicKey: {} },
  },
  /** A request was given to you (the assignee). */
  'management_request.assigned': {
    priority: 'normal',
    category: 'management',
    critical: false,
    target: 'management_request',
    params: { requestNumber: {}, topicKey: {} },
  },
  /** A request's response is overdue (whoever holds requests.manage; once per cycle). */
  'management_request.escalated': {
    priority: 'normal',
    category: 'management',
    critical: false,
    target: 'management_request',
    params: { requestNumber: {}, topicKey: {} },
  },
  /** The author wrote on a request (its assignee, else the handlers); never its body. */
  'management_request.resident_replied': {
    priority: 'normal',
    category: 'management',
    critical: false,
    target: 'management_request',
    params: { requestNumber: {}, topicKey: {} },
  },
  /** The author reopened a closed request (its assignee, else the handlers). */
  'management_request.reopened': {
    priority: 'normal',
    category: 'management',
    critical: false,
    target: 'management_request',
    params: { requestNumber: {}, topicKey: {} },
  },
  /** The author withdrew a request (its assignee alone). */
  'management_request.withdrawn': {
    priority: 'normal',
    category: 'management',
    critical: false,
    target: 'management_request',
    params: { requestNumber: {}, topicKey: {} },
  },
  /** The author picked a slot (the assignee, else the handlers). */
  'management_appointment.requested': {
    priority: 'normal',
    category: 'management',
    critical: false,
    target: 'management_request',
    params: { requestNumber: {}, topicKey: {} },
  },
  /** The author accepted the slot the management proposed. */
  'management_appointment.accepted': {
    priority: 'normal',
    category: 'management',
    critical: false,
    target: 'management_request',
    params: { requestNumber: {}, topicKey: {} },
  },
  /** The author cancelled their appointment. */
  'management_appointment.cancelled_by_resident': {
    priority: 'normal',
    category: 'management',
    critical: false,
    target: 'management_request',
    params: { requestNumber: {}, topicKey: {} },
  },
  // Community life (ADR 0040). Nothing here is critical, and no param is
  // a text: what happened is the kind, the rest is read on the target.
  /** An important announcement came out (its audience at that moment). */
  'community_announcement.important': {
    priority: 'normal',
    category: 'community',
    critical: false,
    target: 'community_announcement',
    params: {},
  },
  /** An event the account said it is going to was cancelled. */
  'community_event.cancelled': {
    priority: 'normal',
    category: 'community',
    critical: false,
    target: 'community_event',
    params: {},
  },
  /**
   * The staff moved the author's suggestion or answered it. `status` is
   * where it stands; never a word of the suggestion or of the answer.
   */
  'community_suggestion.status_changed': {
    priority: 'normal',
    category: 'community',
    critical: false,
    target: 'community_suggestion',
    params: { status: {}, topicKey: {} },
  },
  // Neighbours (ADR 0042). No kind is critical. A complaint's kinds carry
  // its number and its category's key only: never a message, a notice's
  // text, a unit or a name. The number never reaches the unit complained
  // about: its own kinds target the notice and carry the category alone.
  /** A resident filed a complaint against a unit: to the staff who handle them. */
  'neighbour_complaint.submitted': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_complaint',
    params: { complaintNumber: {}, categoryKey: {} },
  },
  /** The author wrote on their complaint: to the staff; never its body. */
  'neighbour_complaint.author_replied': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_complaint',
    params: { complaintNumber: {}, categoryKey: {} },
  },
  /** The author took their complaint back: to the staff. */
  'neighbour_complaint.withdrawn': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_complaint',
    params: { complaintNumber: {}, categoryKey: {} },
  },
  /** The management took the author's complaint under review. */
  'neighbour_complaint.under_review': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_complaint',
    params: { complaintNumber: {}, categoryKey: {} },
  },
  /** The management put the author's complaint in mediation. */
  'neighbour_complaint.in_mediation': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_complaint',
    params: { complaintNumber: {}, categoryKey: {} },
  },
  /** The management resolved the author's complaint. */
  'neighbour_complaint.resolved': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_complaint',
    params: { complaintNumber: {}, categoryKey: {} },
  },
  /** The management dismissed the author's complaint. */
  'neighbour_complaint.dismissed': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_complaint',
    params: { complaintNumber: {}, categoryKey: {} },
  },
  /** The management wrote on the author's complaint; never its body. */
  'neighbour_complaint.replied': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_complaint',
    params: { complaintNumber: {}, categoryKey: {} },
  },
  /** The management sent the unit complained about its notice: to the author. */
  'neighbour_complaint.notice_sent': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_complaint',
    params: { complaintNumber: {}, categoryKey: {} },
  },
  /** The unit answered its notice: to the staff, on the complaint. */
  'neighbour_notice.unit_replied': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_complaint',
    params: { complaintNumber: {}, categoryKey: {} },
  },
  /** The management sent a unit a notice: to whoever answers for the unit. */
  'neighbour_notice.received': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_notice',
    params: { categoryKey: {} },
  },
  /** The management wrote to the unit again on its notice; never its body. */
  'neighbour_notice.replied': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_notice',
    params: { categoryKey: {} },
  },
  // The boards: the post's kind only, never its words or a place.
  /** A resident claimed a found item: to the staff at the desk. */
  'neighbour_item.claimed': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_post',
    params: { postKind: {} },
  },
  /** The office handed the found item to the recipient. */
  'neighbour_item.handed_over': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_post',
    params: { postKind: {} },
  },
  /** The claimant's claim on a found item was declined, or its item went elsewhere. */
  'neighbour_claim.declined': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_post',
    params: { postKind: {} },
  },
  /** The management took the author's post off its board. */
  'neighbour_post.removed': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_post',
    params: { postKind: {} },
  },
  // Masked contact: the post's kind at most, never a name or a building.
  /** A neighbour wrote to the author about their post; never a word of it, nor who. */
  'neighbour_conversation.started': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_conversation',
    params: { postKind: {} },
  },
  /** The other side wrote in the conversation; never its body. */
  'neighbour_conversation.message': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_conversation',
    params: { postKind: {} },
  },
  /** The other side agreed to show names and waits for this one. */
  'neighbour_conversation.reveal_requested': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_conversation',
    params: { postKind: {} },
  },
  /** Both agreed: first names are shown. The name itself is read in the app. */
  'neighbour_conversation.names_revealed': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_conversation',
    params: { postKind: {} },
  },
  /** A participant reported a conversation: to the staff who handle them. */
  'neighbour_conversation.reported': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_report',
    params: {},
  },
  /** The staff looked at the reporter's report; never its outcome. */
  'neighbour_report.closed': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_conversation',
    params: {},
  },
  /** A household just moved in: its primary is pointed at the compound's welcome. */
  'neighbours.welcome': {
    priority: 'normal',
    category: 'neighbours',
    critical: false,
    target: 'neighbour_welcome',
    params: {},
  },
  // Bookings and the club (ADR 0044). No kind is critical. They target the
  // booking (or the suspension, the membership) and carry a reason's code
  // at most (`reason`: a param named `…Code` reads as a secret): never a
  // facility's name, a time, a unit or a name. To the booker
  // only; never to the one who acted.
  /** The management approved a booking that waited for it. */
  'booking.approved': {
    priority: 'normal',
    category: 'bookings',
    critical: false,
    target: 'booking',
    params: {},
  },
  /** The management did not approve it; the reason is a code. */
  'booking.rejected': {
    priority: 'normal',
    category: 'bookings',
    critical: false,
    target: 'booking',
    params: { reason: {} },
  },
  /** Nobody approved it before its start: it was cancelled by the system. */
  'booking.approval_expired': {
    priority: 'normal',
    category: 'bookings',
    critical: false,
    target: 'booking',
    params: {},
  },
  /** The management cancelled it; the reason is a code. */
  'booking.cancelled_by_staff': {
    priority: 'normal',
    category: 'bookings',
    critical: false,
    target: 'booking',
    params: { reason: {} },
  },
  /** The facility closed over it; `reason` is the closure's reason code. */
  'booking.cancelled_by_closure': {
    priority: 'normal',
    category: 'bookings',
    critical: false,
    target: 'booking',
    params: { reason: {} },
  },
  /**
   * The unit's no-shows suspended it from booking: to everyone who books
   * for it. The end is read on the suspension.
   */
  'booking_suspension.started': {
    priority: 'normal',
    category: 'bookings',
    critical: false,
    target: 'booking_suspension',
    params: {},
  },
  /** A confirmed booking starts in about two hours: to its booker, once. */
  'booking.reminder': {
    priority: 'normal',
    category: 'bookings',
    critical: false,
    target: 'booking',
    params: {},
  },
  /**
   * The unit's club membership ends within a week: to the people it covers
   * who have an account, once per end date.
   */
  'club_membership.expiring': {
    priority: 'normal',
    category: 'bookings',
    critical: false,
    target: 'club_membership',
    params: {},
  },
  // Vehicles and parking (ADR 0045). No kind is critical. They target the
  // vehicle and carry a reason's code at most: never a plate, a unit or a
  // name. Never to the one who acted.
  /** The staff approved a vehicle: to its registrant. */
  'vehicle.approved': {
    priority: 'normal',
    category: 'vehicles',
    critical: false,
    target: 'vehicle',
    params: {},
  },
  /** The staff rejected it; the reason is a code. */
  'vehicle.rejected': {
    priority: 'normal',
    category: 'vehicles',
    critical: false,
    target: 'vehicle',
    params: { reason: {} },
  },
  /**
   * Its permit's last day is within 30 days: to its registrant (or the
   * unit's primary), once per last day.
   */
  'vehicle.permit_expiring': {
    priority: 'normal',
    category: 'vehicles',
    critical: false,
    target: 'vehicle',
    params: {},
  },
  /**
   * A fine was issued to the unit: to its vehicle keepers and its primary.
   * The reason is a code; never the plate, the amount or who reported it.
   */
  'vehicle_fine.issued': {
    priority: 'normal',
    category: 'vehicles',
    critical: false,
    target: 'vehicle_fine',
    params: { reason: {} },
  },
  /**
   * A vehicle of the unit was removed because its registrant no longer
   * holds `vehicles` there: to the unit's primary, so a car that stays is
   * registered again.
   */
  'vehicle.registrant_left': {
    priority: 'normal',
    category: 'vehicles',
    critical: false,
    target: 'vehicle',
    params: {},
  },
  /** The appeal was decided and the fine stands: to the appellant. */
  'vehicle_fine.appeal_upheld': {
    priority: 'normal',
    category: 'vehicles',
    critical: false,
    target: 'vehicle_fine',
    params: {},
  },
  /** The appeal was accepted and the fine cancelled: to the appellant. */
  'vehicle_fine.appeal_accepted': {
    priority: 'normal',
    category: 'vehicles',
    critical: false,
    target: 'vehicle_fine',
    params: {},
  },
  // Emergencies (ADR 0047). Every kind is critical: never muted, never held.
  // They target the emergency and carry its type at most: never a name or a
  // unit on the lock screen. Never to the one who acted.
  /** Reported: every guard on an open shift and every responder, now. */
  'emergency.reported': {
    priority: 'critical',
    category: 'safety',
    critical: true,
    target: 'emergency',
    params: { emergencyType: {} },
  },
  /** Reported from their unit: the others who live there, generic text. */
  'emergency.family_alert': {
    priority: 'critical',
    category: 'safety',
    critical: true,
    target: 'emergency',
    params: {},
  },
  /** Nobody answered in time, or nobody was there to answer: the management. */
  'emergency.escalated': {
    priority: 'critical',
    category: 'safety',
    critical: true,
    target: 'emergency',
    params: { emergencyType: {} },
  },
  /** A responder accepted, with their minutes: the reporter and the family. */
  'emergency.responder_on_the_way': {
    priority: 'critical',
    category: 'safety',
    critical: true,
    target: 'emergency',
    params: { etaMinutes: {} },
  },
  /** Cancelled by the household: its responder, or those told of it. */
  'emergency.cancelled': {
    priority: 'critical',
    category: 'safety',
    critical: true,
    target: 'emergency',
    params: {},
  },
  // Gate services (ADR 0047). The new request is staff work, critical, like
  // a ticket assigned; what the requester is told is not. They carry the
  // kind and codes at most: never a name, a unit or what was written.
  /** A new request: the guards on shift (at the lane's gate) and the handlers. */
  'gate_service.requested': {
    priority: 'critical',
    category: 'safety',
    critical: true,
    target: 'gate_service_request',
    params: { serviceKind: {} },
  },
  /** Security accepted it, with their minutes when given: the requester. */
  'gate_service.accepted': {
    priority: 'normal',
    category: 'safety',
    critical: false,
    target: 'gate_service_request',
    params: { serviceKind: {}, etaMinutes: { optional: true } },
  },
  /** Security closed it, with a reason's code: the requester. */
  'gate_service.closed': {
    priority: 'normal',
    category: 'safety',
    critical: false,
    target: 'gate_service_request',
    params: { serviceKind: {}, reason: {} },
  },
  // Finance (ADR 0046). No kind is critical, and none carries a param: never
  // an amount, a number, a unit or a name. To every account that sees the
  // unit's money (capabilities.financeView).
  /** A new invoice for the unit. */
  'invoice.issued': {
    priority: 'normal',
    category: 'finance',
    critical: false,
    target: 'invoice',
    params: {},
  },
  /** An invoice still owed falls due in three days. */
  'invoice.due_soon': {
    priority: 'normal',
    category: 'finance',
    critical: false,
    target: 'invoice',
    params: {},
  },
  /** An invoice is still owed after its due date. */
  'invoice.overdue': {
    priority: 'normal',
    category: 'finance',
    critical: false,
    target: 'invoice',
    params: {},
  },
  /** A payment for the unit, at the office or online; its receipt is in the app. */
  'payment.received': {
    priority: 'normal',
    category: 'finance',
    critical: false,
    target: 'payment',
    params: {},
  },
} as const satisfies Record<string, KindSpec>;

export type NotificationKind = keyof typeof NOTIFICATION_KINDS;

export type NotificationParams = Record<string, string | number>;

/** Every param name that is personal in at least one kind. */
export const PERSONAL_PARAMS: readonly string[] = [
  ...new Set(
    Object.values(NOTIFICATION_KINDS as Record<string, KindSpec>).flatMap((k) =>
      Object.entries(k.params)
        .filter(([, spec]) => spec.personal)
        .map(([name]) => name),
    ),
  ),
].sort();

/** Throws on an unknown kind, an unknown or missing param, or a bad value. */
export function checkNotification(
  kind: string,
  params: NotificationParams,
): KindSpec {
  const spec = (NOTIFICATION_KINDS as Record<string, KindSpec>)[kind];
  if (!spec) throw new Error(`Unknown notification kind ${kind}`);
  for (const [name, value] of Object.entries(params)) {
    if (!spec.params[name])
      throw new Error(`Notification ${kind} has no param ${name}`);
    if (typeof value !== 'string' && typeof value !== 'number')
      throw new Error(`Notification ${kind} param ${name} must be a scalar`);
  }
  for (const [name, p] of Object.entries(spec.params)) {
    if (!p.optional && !(name in params))
      throw new Error(`Notification ${kind} needs param ${name}`);
  }
  return spec;
}

/** The delivery class of a kind, for deliveryDecision. */
export function kindDelivery(kind: NotificationKind): DeliveryClass {
  const spec = (NOTIFICATION_KINDS as Record<string, KindSpec>)[kind];
  return { category: spec.category, critical: spec.critical };
}

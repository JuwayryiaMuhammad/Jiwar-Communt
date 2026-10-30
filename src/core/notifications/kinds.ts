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
  /**
   * A lease's notice date has come (ADR 0062): renew or leave. Its
   * tenants and the unit's owners; the dates only.
   */
  'contract.expiring': {
    priority: 'normal',
    category: 'household',
    critical: false,
    target: 'contract',
    params: { endsOn: {}, noticeBy: {} },
  },
  /** The management renewed the lease or declined the request (ADR 0062). */
  'contract.renewal_decided': {
    priority: 'normal',
    category: 'household',
    critical: false,
    target: 'contract',
    params: { outcome: {} },
  },
  /** A new version of the bylaws or the occupants' rights (ADR 0062). */
  'compound_document.published': {
    priority: 'normal',
    category: 'community',
    critical: false,
    target: 'compound_document',
    params: { subject: {}, versionNo: {} },
  },
  /**
   * A residing primary gave notice to move out (ADR 0063): to the holders
   * of `residents.manage`; the planned day only.
   */
  'unit_move.notice_given': {
    priority: 'normal',
    category: 'household',
    critical: false,
    target: 'unit_move',
    params: { plannedOn: {} },
  },
  /** A warranty in the unit's vault ends within 30 days (ADR 0062). */
  'unit_document.warranty_expiring': {
    priority: 'normal',
    category: 'household',
    critical: false,
    target: 'unit_document',
    params: { expiresOn: {} },
  },
  /**
   * A manager decided the account's name or phone change (ADR 0062):
   * which field and how, never the value.
   */
  'account.identity_change_decided': {
    priority: 'normal',
    category: 'account_security',
    critical: false,
    target: 'account_identity_change',
    params: { field: {}, outcome: {} },
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
  /** A quote waits for the residents' approval (ADR 0058). */
  'ticket.quote_proposed': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, unitCode: { optional: true }, amount: {} },
  },
  /** The residents approved the quote: the work may start (dispatch, technician). */
  'ticket.quote_approved': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, unitCode: { optional: true } },
  },
  /** The residents declined the quote, with a reason code (dispatch, technician). */
  'ticket.quote_declined': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, unitCode: { optional: true }, reason: {} },
  },
  /** The dispatch withdrew a quote that waited (the residents). */
  'ticket.quote_withdrawn': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, unitCode: { optional: true } },
  },
  /** A technician suggests a quote for the ticket (dispatchers; ADR 0065). */
  'ticket.quote_suggested': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, unitCode: { optional: true }, amount: {} },
  },
  /** Dispatch did not send it, and says why (the technician; ADR 0065). */
  'ticket.quote_suggestion_dismissed': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, unitCode: { optional: true }, reason: {} },
  },
  /** A technician asks the store for a part (who keeps it; ADR 0065). */
  'part_request.created': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, itemRef: {} },
  },
  /** The store holds the part: collect it (the technician; ADR 0065). */
  'part_request.reserved': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, itemRef: {} },
  },
  /** The store will not give it, and says why (the technician; ADR 0065). */
  'part_request.declined': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { ticketNumber: {}, itemRef: {}, reason: {} },
  },
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
  /**
   * The staff banned the account from booking one facility or all, and
   * lifted the ban (ADR 0067): to the account. The scope and the last day,
   * never the reason.
   */
  'facility_ban.started': {
    priority: 'normal',
    category: 'bookings',
    critical: false,
    target: 'facility_ban',
    params: { scope: {}, until: { optional: true } },
  },
  'facility_ban.lifted': {
    priority: 'normal',
    category: 'bookings',
    critical: false,
    target: 'facility_ban',
    params: { scope: {} },
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
  /**
   * Who raised a staff SOS asked for it to be called off (ADR 0067): it
   * stays open; a responder checks and resolves it. As critical as the SOS.
   */
  'emergency.cancel_requested': {
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
  // Permits (ADR 0049). None is critical. They carry the permit's kind and a
  // reason's code at most: never a name, a unit, a plate or what was
  // written.
  /** A new permit to decide: the `permits.manage` holders. */
  'unit_permit.requested': {
    priority: 'normal',
    category: 'permits',
    critical: false,
    target: 'unit_permit',
    params: { permitKind: {} },
  },
  /**
   * A works permit's requester asks for the finished works to be inspected
   * (ADR 0063): to the holders of `permits.manage`; the cycle only.
   */
  'permit_inspection.requested': {
    priority: 'normal',
    category: 'permits',
    critical: false,
    target: 'permit_inspection',
    params: { cycle: {} },
  },
  /** The completion inspection passed or failed (ADR 0063): to the requester. */
  'permit_inspection.decided': {
    priority: 'normal',
    category: 'permits',
    critical: false,
    target: 'permit_inspection',
    params: { outcome: {} },
  },
  /** The management approved it: the requester. */
  'unit_permit.approved': {
    priority: 'normal',
    category: 'permits',
    critical: false,
    target: 'unit_permit',
    params: { permitKind: {} },
  },
  /** The management rejected it, with a reason's code: the requester. */
  'unit_permit.rejected': {
    priority: 'normal',
    category: 'permits',
    critical: false,
    target: 'unit_permit',
    params: { permitKind: {}, reason: {} },
  },
  /** The management revoked it, with a reason's code: the requester. */
  'unit_permit.revoked': {
    priority: 'normal',
    category: 'permits',
    critical: false,
    target: 'unit_permit',
    params: { permitKind: {}, reason: {} },
  },
  /** A material exit's goods went out at a gate: the requester. */
  'unit_permit.used': {
    priority: 'normal',
    category: 'permits',
    critical: false,
    target: 'unit_permit',
    params: { permitKind: {} },
  },
  /**
   * The system cancelled it (nobody decided in time, or its requester
   * left): the requester, or the unit's primary.
   */
  'unit_permit.cancelled': {
    priority: 'normal',
    category: 'permits',
    critical: false,
    target: 'unit_permit',
    params: { permitKind: {}, reason: {} },
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
  /**
   * Where the fees went (ADR 0069): a spending report, to everyone who
   * sees a unit's money — tenants as well as owners.
   */
  /** A resident asked for a payment plan (ADR 0069): to the finance staff. */
  'instalment_plan_request.submitted': {
    priority: 'normal',
    category: 'finance',
    critical: false,
    target: 'plan_request',
    params: {},
  },
  /** The requester's plan request accepted: the plan itself is announced too. */
  'instalment_plan_request.accepted': {
    priority: 'normal',
    category: 'finance',
    critical: false,
    target: 'plan_request',
    params: {},
  },
  'instalment_plan_request.declined': {
    priority: 'normal',
    category: 'finance',
    critical: false,
    target: 'plan_request',
    params: { reasonCode: {} },
  },
  /** With an invoice's due-soon notice, once: it may be paid by a plan (ADR 0069). */
  'invoice.plan_available': {
    priority: 'normal',
    category: 'finance',
    critical: false,
    target: 'invoice',
    params: {},
  },
  'finance.spending_report_published': {
    priority: 'normal',
    category: 'finance',
    critical: false,
    target: 'spending_report',
    params: { fiscalYear: {}, asOf: {} },
  },
  // Finance part 2 (ADR 0048), under the same rules.
  /** An invoice of the unit was split into instalments: one notice, not one per instalment. */
  'instalment_plan.created': {
    priority: 'normal',
    category: 'finance',
    critical: false,
    target: 'instalment_plan',
    params: {},
  },
  /** The staff accepted the dispute: a credit note took part or all of the invoice off. To its opener. */
  'invoice.dispute_accepted': {
    priority: 'normal',
    category: 'finance',
    critical: false,
    target: 'invoice_dispute',
    params: {},
  },
  /** The staff rejected the dispute: the invoice stands. To its opener. */
  'invoice.dispute_rejected': {
    priority: 'normal',
    category: 'finance',
    critical: false,
    target: 'invoice_dispute',
    params: {},
  },
  /** A formal notice (ADR 0058): its type; opening it records the reading. */
  'formal_notice.issued': {
    priority: 'normal',
    category: 'finance',
    critical: false,
    target: 'formal_notice',
    params: { type: {} },
  },
  /** The staff credited one of the unit's invoices (ADR 0058): the reason code. */
  'credit_note.issued': {
    priority: 'normal',
    category: 'finance',
    critical: false,
    target: 'invoice',
    params: { reason: {} },
  },
  /** A compensation: a credit note with its compensation reason code. */
  'compensation.granted': {
    priority: 'normal',
    category: 'finance',
    critical: false,
    target: 'invoice',
    params: { reason: {} },
  },
  /** A checkout's payment failed (once per checkout): its alternatives are on it. */
  'payment.failed': {
    priority: 'normal',
    category: 'finance',
    critical: false,
    target: 'payment_session',
    params: {},
  },
  // Guard shifts and tasks (ADR 0050). Params are codes at most: never a
  // name, a unit or a post's name.
  /**
   * A guard did not open their slot an hour after its start, and another
   * guard is on shift at that post. To the roster's keepers.
   */
  'guard_shift.absent': {
    priority: 'normal',
    category: 'guard_duty',
    critical: false,
    target: 'guard_roster_slot',
    params: {},
  },
  /** The same, and nobody is on shift at that post: it is unmanned. */
  'guard_shift.absent_unmanned': {
    priority: 'critical',
    category: 'guard_duty',
    critical: true,
    target: 'guard_roster_slot',
    params: {},
  },
  /**
   * A task for the guard: theirs, or their post's while they are on shift
   * there. Its kind only.
   */
  'guard_task.assigned': {
    priority: 'normal',
    category: 'guard_duty',
    critical: false,
    target: 'guard_task',
    params: { taskKind: {} },
  },
  /**
   * Security inspected the closed unit. To its primary, and to whoever
   * asked for the visit (ADR 0063): the outcome's code only, never a photo,
   * a note or who (the report is read in the app).
   */
  'guard_task.unit_inspected': {
    priority: 'normal',
    category: 'household',
    critical: false,
    target: 'unit',
    params: { outcome: {} },
  },
  /**
   * A closed unit's owner, or its proxy, asked for an inspection (ADR
   * 0063): to the holders of `guard_tasks.manage`; the preferred day only.
   */
  'unit_inspection.requested': {
    priority: 'normal',
    category: 'guard_duty',
    critical: false,
    target: 'unit_inspection_request',
    params: { preferredOn: {} },
  },
  /** A colleague asks the guard to take one of their slots. */
  'guard_swap.requested': {
    priority: 'normal',
    category: 'guard_duty',
    critical: false,
    target: 'guard_shift_swap',
    params: {},
  },
  /** The colleague accepted: to the roster's keepers, to decide. */
  'guard_swap.accepted': {
    priority: 'normal',
    category: 'guard_duty',
    critical: false,
    target: 'guard_shift_swap',
    params: {},
  },
  /** The colleague declined: to the requester. */
  'guard_swap.declined': {
    priority: 'normal',
    category: 'guard_duty',
    critical: false,
    target: 'guard_shift_swap',
    params: {},
  },
  /** Approved: the slots have their new guards. To both guards. */
  'guard_swap.approved': {
    priority: 'normal',
    category: 'guard_duty',
    critical: false,
    target: 'guard_shift_swap',
    params: {},
  },
  /** Rejected by the roster's keepers. To both guards. */
  'guard_swap.rejected': {
    priority: 'normal',
    category: 'guard_duty',
    critical: false,
    target: 'guard_shift_swap',
    params: {},
  },
  /** A slot started before it was decided. To both guards. */
  'guard_swap.expired': {
    priority: 'normal',
    category: 'guard_duty',
    critical: false,
    target: 'guard_shift_swap',
    params: {},
  },
  /** The system cancelled it (a slot cancelled or changed, a guard gone). To both guards. */
  'guard_swap.cancelled': {
    priority: 'normal',
    category: 'guard_duty',
    critical: false,
    target: 'guard_shift_swap',
    params: {},
  },
  /** An instruction to acknowledge. Never its title or words. */
  'guard_instruction.issued': {
    priority: 'normal',
    category: 'guard_duty',
    critical: false,
    target: 'guard_instruction',
    params: {},
  },
  /** An urgent instruction to acknowledge. */
  'guard_instruction.urgent': {
    priority: 'critical',
    category: 'guard_duty',
    critical: true,
    target: 'guard_instruction',
    params: {},
  },
  // Governance (ADR 0051). Nothing is critical; params are codes only: never
  // a name, a title, or what anyone chose.
  /** The account took a seat on the board: appointed or elected. */
  'governance_board.seat': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'board_term',
    params: { role: {} },
  },
  /** Voting opened on a poll: every elector (a unit's voting owner). */
  'governance_poll.opened': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'governance_poll',
    params: {},
  },
  /** A poll closes within a day: the electors whose unit has not voted. */
  'governance_poll.closing_soon': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'governance_poll',
    params: {},
  },
  /** A poll's result: its electors and the sitting board. */
  'governance_poll.result': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'governance_poll',
    params: { result: {} },
  },
  /** An election's nominations opened: every owner (who may stand). */
  'governance_election.nominations_opened': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'governance_election',
    params: {},
  },
  /** An election's voting opened: every elector. */
  'governance_election.opened': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'governance_election',
    params: {},
  },
  /** An election closes within a day: the electors whose unit has not voted. */
  'governance_election.closing_soon': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'governance_election',
    params: {},
  },
  /**
   * Voting closed: the manager certifies it (`governance.manage` holders)
   * and the sitting board hears it; `tied` (yes | no) when the board has a
   * tie to resolve first.
   */
  'governance_election.awaiting_certification': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'governance_election',
    params: { tied: {} },
  },
  /** An election was cancelled: the sitting board; `reason` its code. */
  'governance_election.cancelled': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'governance_election',
    params: { reason: {} },
  },
  /** An election was certified: its electors and its candidates. */
  'governance_election.result': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'governance_election',
    params: {},
  },
  // Board matters (ADR 0055). None critical; params are codes only.
  /** A decision package awaits the board: the sitting board; `type` its code. */
  'governance_approval.raised': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'governance_approval',
    params: { type: {} },
  },
  /** The board decided a request: who raised it, the `governance.manage` holders and the sitting board; `decision` approved | rejected. */
  'governance_approval.decided': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'governance_approval',
    params: { type: {}, decision: {} },
  },
  /** A request passed its deadline undecided, once: the sitting board and the `governance.manage` holders. */
  'governance_approval.overdue': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'governance_approval',
    params: { type: {} },
  },
  /** The manager marked an approved request implemented: the sitting board. */
  'governance_approval.implemented': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'governance_approval',
    params: { type: {} },
  },
  /** A pending request was withdrawn: the sitting board. */
  'governance_approval.withdrawn': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'governance_approval',
    params: { type: {} },
  },
  /** A member proposed a motion: the other sitting members; `matter` approval | appeal | representative. */
  'governance_motion.proposed': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'board_motion',
    params: { matter: {} },
  },
  /** A staff decision was appealed to the board: the sitting board; `kind` its kind. */
  'governance_appeal.lodged': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'governance_board_appeal',
    params: { kind: {} },
  },
  /** The board decided an appeal: the appellant, the `governance.manage` holders and the sitting board; `outcome` upheld | overturned. */
  'governance_appeal.decided': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'governance_board_appeal',
    params: { kind: {}, outcome: {} },
  },
  /** An appeal passed its deadline undecided, once: the sitting board and the `governance.manage` holders. */
  'governance_appeal.overdue': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'governance_board_appeal',
    params: { kind: {} },
  },
  // Patrols (ADR 0052). None critical; params are codes at most.
  /** A scheduled run nobody started 15 minutes after its start. To the guards on shift at its post. */
  'patrol.late': {
    priority: 'normal',
    category: 'guard_duty',
    critical: false,
    target: 'patrol_run',
    params: {},
  },
  /** A scheduled run nobody started in its window. To the roster's keepers. */
  'patrol.missed': {
    priority: 'normal',
    category: 'guard_duty',
    critical: false,
    target: 'patrol_run',
    params: {},
  },
  /**
   * A run ended with checkpoints not scanned: the guard ended it, their
   * shift ended, or it timed out. To the roster's keepers.
   */
  'patrol.incomplete': {
    priority: 'normal',
    category: 'guard_duty',
    critical: false,
    target: 'patrol_run',
    params: { reason: {} },
  },
  // Security (ADR 0053).
  /**
   * A guard locked one gate or all down. To the guards on shift and the
   * management (`lockdown.end`). params.scope: gate or all.
   */
  'gate_lockdown.started': {
    priority: 'critical',
    category: 'safety',
    critical: true,
    target: 'gate_lockdown',
    params: { scope: {} },
  },
  /**
   * The compound's gates are locked down: every resident, a generic text
   * (no gate, no reason). Sent when the first lockdown starts.
   */
  'gate_lockdown.resident_notice': {
    priority: 'critical',
    category: 'safety',
    critical: true,
    target: 'gate_lockdown',
    params: {},
  },
  /**
   * The management ended a lockdown: the guards on shift and the
   * management; the residents too once none is left.
   */
  'gate_lockdown.ended': {
    priority: 'normal',
    category: 'safety',
    critical: false,
    target: 'gate_lockdown',
    params: { scope: {} },
  },
  /**
   * A banned plate or person was met at the gate (ADR 0053): refused, or
   * met on a pass, a permit or a lookup. To the blocklist's keepers.
   * params.source: where. Never the plate, the person or the unit.
   */
  'blocklist.ban_matched': {
    priority: 'normal',
    category: 'safety',
    critical: false,
    target: 'blocklist_entry',
    params: { source: {} },
  },
  /** A watched plate or person was met at the gate: let in, and told. */
  'blocklist.watch_matched': {
    priority: 'normal',
    category: 'safety',
    critical: false,
    target: 'blocklist_entry',
    params: { source: {} },
  },
  /**
   * The host's visitor was refused by security (ADR 0053): once per pass,
   * never why.
   */
  'visitor_pass.refused_by_security': {
    priority: 'normal',
    category: 'gate_visitors',
    critical: false,
    target: 'visitor_pass',
    params: {},
  },
  /**
   * Work on the works permit was stopped at the site (ADR 0053): to the
   * requester and the unit's primary, and, when a guard stopped it, to the
   * permits' staff. params.reason: the code.
   */
  'unit_permit.work_stopped': {
    priority: 'normal',
    category: 'permits',
    critical: false,
    target: 'unit_permit',
    params: { reason: {} },
  },
  /** The management let the work go on: the requester and the primary. */
  'unit_permit.work_resumed': {
    priority: 'normal',
    category: 'permits',
    critical: false,
    target: 'unit_permit',
    params: {},
  },
  /**
   * An incident was reported (ADR 0053), low to high severity: to the
   * incidents' keepers. params.severity, params.incidentType.
   */
  'incident.reported': {
    priority: 'normal',
    category: 'safety',
    critical: false,
    target: 'incident',
    params: { severity: {}, incidentType: {} },
  },
  /** A critical incident was reported: to the incidents' keepers, critical. */
  'incident.critical': {
    priority: 'critical',
    category: 'safety',
    critical: true,
    target: 'incident',
    params: { incidentType: {} },
  },
  /** You investigate an incident: to its investigator. */
  'incident.assigned': {
    priority: 'normal',
    category: 'safety',
    critical: false,
    target: 'incident',
    params: {},
  },
  /**
   * A violation to the unit (ADR 0053): its keepers and its primary, as a
   * fine is. params.violationKind only: never a place, an amount or a name.
   */
  'violation.issued': {
    priority: 'normal',
    category: 'household',
    critical: false,
    target: 'unit_violation',
    params: { violationKind: {} },
  },
  /** The appeal was turned down: the appellant. */
  'violation.appeal_upheld': {
    priority: 'normal',
    category: 'household',
    critical: false,
    target: 'unit_violation',
    params: {},
  },
  /** The appeal was accepted, the violation cancelled: the appellant. */
  'violation.appeal_accepted': {
    priority: 'normal',
    category: 'household',
    critical: false,
    target: 'unit_violation',
    params: {},
  },
  /** A guest of the event, or the move's truck, was refused by security. */
  'unit_permit.refused_by_security': {
    priority: 'normal',
    category: 'permits',
    critical: false,
    target: 'unit_permit',
    params: {},
  },
  // Children (ADR 0054), in the `household` category. Ids only: never the
  // child's name, the escort's, or where.
  /**
   * Someone tried to collect a child who may not go with them, or a guard
   * held a child for a person who could not be identified: the household
   * adults and the roster's keepers. Critical: never muted.
   */
  'child.unauthorized_pickup': {
    priority: 'critical',
    category: 'household',
    critical: true,
    target: 'child_pickup',
    params: {},
  },
  /** A child who may not leave alone tried to: the household adults. */
  'child.exit_alone': {
    priority: 'critical',
    category: 'household',
    critical: true,
    target: 'child_pickup',
    params: {},
  },
  /** A child left (collected, or alone as allowed), when the household asks to know. */
  'child.picked_up': {
    priority: 'normal',
    category: 'household',
    critical: false,
    target: 'child_pickup',
    params: { outcome: {} },
  },
  // Field exceptions (ADR 0056): codes only, never a name or a plate.
  /**
   * A guard asks the on-duty management to let someone the gate refused in,
   * once: every holder of `gate_exceptions.decide`. Critical: someone waits.
   */
  'gate_exception.requested': {
    priority: 'critical',
    category: 'gate_visitors',
    critical: true,
    target: 'gate_field_exception',
    params: { exceptionKind: {}, unitCode: {}, gateName: {} },
  },
  /** The management answered the guard who asked: `decision` approved | rejected. */
  'gate_exception.decided': {
    priority: 'critical',
    category: 'guard_duty',
    critical: true,
    target: 'gate_field_exception',
    params: { decision: {}, unitCode: {} },
  },
  /** Nobody answered in time: the guard who asked. */
  'gate_exception.expired': {
    priority: 'critical',
    category: 'guard_duty',
    critical: true,
    target: 'gate_field_exception',
    params: { unitCode: {} },
  },
  /**
   * A visitor still inside past their visit's expected length (ADR 0056),
   * once per visit: the guards on shift at the gate they came in by. The
   * target is their `in` entry; `minutes` the expected length.
   */
  'visit.overstayed': {
    priority: 'normal',
    category: 'guard_duty',
    critical: false,
    target: 'gate_entry',
    params: { unitCode: {}, minutes: {} },
  },
  /** The same, to the host: their visitor is still inside. */
  'visit.overstayed_host': {
    priority: 'normal',
    category: 'gate_visitors',
    critical: false,
    target: 'gate_entry',
    params: { unitCode: {}, minutes: {} },
  },
  /**
   * A patrol's guard outside its route's geofence for `minutes` or more
   * (ADR 0056), once per exit: the `patrols.manage` holders. The target is
   * the run; never where.
   */
  'patrol.geofence_exit': {
    priority: 'normal',
    category: 'guard_duty',
    critical: false,
    target: 'patrol_run',
    params: { minutes: {} },
  },
  /**
   * A guard enrolled a device for the gate offline (ADR 0057): the
   * `gate_devices.manage` holders, who revoke one they do not recognise.
   */
  'gate_device.enrolled': {
    priority: 'normal',
    category: 'safety',
    critical: false,
    target: 'gate_device',
    params: {},
  },
  /**
   * A guard device on an open shift, its bundle live, not seen for
   * `minutes` (ADR 0057): the `gate_devices.manage` holders, once per
   * outage. The gate may have lost its network: check on it.
   */
  'gate_device.sync_overdue': {
    priority: 'normal',
    category: 'safety',
    critical: false,
    target: 'gate_device',
    params: { minutes: {} },
  },
  /**
   * A device's sequence still misses `missing` actions that long after its
   * last upload (ADR 0057): the same holders, once per gap. Actions may be
   * lost, or deleted on the device.
   */
  'gate_device.sequence_gap': {
    priority: 'normal',
    category: 'safety',
    critical: false,
    target: 'gate_device',
    params: { missing: {} },
  },
  /**
   * An upload's batch the server took held what it knew better (ADR 0057):
   * someone let in during a lockdown, a banned plate, a worker banned or
   * work stopped, a once-only code used twice, an action that cannot have
   * happened. Once per batch, critically, to the `gate_devices.manage`
   * holders; `flags` counts them. The target is the batch.
   */
  'gate_offline.security_conflict': {
    priority: 'critical',
    category: 'safety',
    critical: true,
    target: 'gate_offline_batch',
    params: { flags: {} },
  },
  /**
   * The same for what the management should look at (a credential revoked
   * or out of its hours, a capacity, a device's clock or bundle): once per
   * batch, not critically.
   */
  'gate_offline.conflicts': {
    priority: 'normal',
    category: 'safety',
    critical: false,
    target: 'gate_offline_batch',
    params: { flags: {} },
  },
  /**
   * Someone was let in offline while a lockdown held the gate (ADR 0057):
   * the guards on shift at that gate, critically. The target is the gate.
   */
  'gate_offline.lockdown_entered': {
    priority: 'critical',
    category: 'guard_duty',
    critical: true,
    target: 'gate',
    params: {},
  },
  /**
   * A device's upload was refused (ADR 0057): a signature that does not
   * verify, a payload that does not parse, an action whose id or sequence
   * number another one holds. `reason` the code; once per device in 15
   * minutes, critically, to the `gate_devices.manage` holders.
   */
  'gate_device.upload_rejected': {
    priority: 'critical',
    category: 'safety',
    critical: true,
    target: 'gate_device',
    params: { reason: {} },
  },
  // Partners (ADR 0060): to the requester, of the partner's and the
  // system's moves on their request (their own tell nobody); codes only,
  // never the partner's name, a time or a unit.
  /** The partner accepted the request. */
  'partner_request.accepted': {
    priority: 'normal',
    category: 'partners',
    critical: false,
    target: 'partner_request',
    params: {},
  },
  /** The partner declined it; `reason` from `partnerRequestDecline`. */
  'partner_request.declined': {
    priority: 'normal',
    category: 'partners',
    critical: false,
    target: 'partner_request',
    params: { reason: {} },
  },
  /** The partner proposed another window: the requester accepts or declines. */
  'partner_request.proposed': {
    priority: 'normal',
    category: 'partners',
    critical: false,
    target: 'partner_request',
    params: {},
  },
  /** The partner cancelled an accepted request; `side` and `reason` are codes. */
  'partner_request.cancelled': {
    priority: 'normal',
    category: 'partners',
    critical: false,
    target: 'partner_request',
    params: { side: {}, reason: {} },
  },
  /** The partner marked it done: the requester may rate it. */
  'partner_request.done': {
    priority: 'normal',
    category: 'partners',
    critical: false,
    target: 'partner_request',
    params: {},
  },
  /** Nobody accepted it before its window started. */
  'partner_request.expired': {
    priority: 'normal',
    category: 'partners',
    critical: false,
    target: 'partner_request',
    params: {},
  },
  /**
   * A request to a partner with no live desk link, to the `partners.manage`
   * holders: the management relays it. `category` the code.
   */
  'partner_request.awaiting_relay': {
    priority: 'normal',
    category: 'partners',
    critical: false,
    target: 'partner_request',
    params: { category: {} },
  },
  /**
   * The management decided the requester's complaint against a partner
   * (ADR 0060): `outcome` and `compensation` are codes. Its conversation is
   * the management request's, with its own notices.
   */
  'partner_complaint.decided': {
    priority: 'normal',
    category: 'partners',
    critical: false,
    target: 'partner_complaint',
    params: { outcome: {}, compensation: {} },
  },
  /**
   * A partner the resident asked or keeps as a favourite was suspended
   * (ADR 0060): their live requests to it are cancelled. Its page offers
   * alternatives in the same categories. Never why.
   */
  'partner.suspended': {
    priority: 'normal',
    category: 'partners',
    critical: false,
    target: 'partner',
    params: {},
  },
  // Decision appeals (ADR 0059). Codes only: the kind of decision and the
  // outcome, never the grounds or the rationale.
  /** A resident appealed a staff decision: the `appeals.decide` holders. */
  'decision_appeal.lodged': {
    priority: 'normal',
    category: 'management',
    critical: false,
    target: 'decision_appeal',
    params: { kind: {} },
  },
  /** A manager decided it: the appellant and the unit's primary. */
  'decision_appeal.decided': {
    priority: 'normal',
    category: 'management',
    critical: false,
    target: 'decision_appeal',
    params: { kind: {}, outcome: {} },
  },
  /**
   * The management rejected a worker the household registered: who
   * registered them, with the reason's code (they may appeal it).
   */
  'worker.engagement_rejected': {
    priority: 'normal',
    category: 'household',
    critical: false,
    target: 'worker_engagement',
    params: { reason: {} },
  },
  // Building representatives (ADR 0059): the building's label, never a
  // message.
  /** The board named the account its building's representative. */
  'governance_representative.appointed': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'governance_representative',
    params: { building: {} },
  },
  /** The account's term ended: `reason` the code. */
  'governance_representative.ended': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'governance_representative',
    params: { building: {}, reason: {} },
  },
  /** A resident wrote to the representative. */
  'representative.message_received': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'representative_thread',
    params: {},
  },
  /** The representative answered the resident. */
  'representative.replied': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'representative_thread',
    params: {},
  },
  /** An owner proposed a matter for the agenda: the sitting board. */
  'governance_agenda.proposed': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'governance_agenda_proposal',
    params: {},
  },
  /** The board accepted or declined the proposal: its proposer. */
  'governance_agenda.decided': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'governance_agenda_proposal',
    params: { outcome: {} },
  },
  /** An owner objected to a published decision: the sitting board. */
  'governance_objection.lodged': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'board_publication',
    params: {},
  },
  /** The board answered a decision's objections: every objector. */
  'governance_objection.answered': {
    priority: 'normal',
    category: 'governance',
    critical: false,
    target: 'board_publication',
    params: {},
  },
  // The asset register (ADR 0064): to who keeps it. The asset's reference
  // (its code in the register) and the day only, never its name or its
  // vendor.
  /** An asset's warranty ends within 30 days. */
  /** What the store holds of an item fell to its reorder level (ADR 0065). */
  'stock.reorder_level': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'stock_item',
    params: { itemRef: {} },
  },
  /**
   * A utility outage in a resident's building (ADR 0066): told 48 hours
   * ahead, or at once; a new start, its end and its cancellation go to
   * exactly those told. The kind and the instants, never the note.
   */
  'utility_outage.announced': {
    priority: 'normal',
    category: 'utilities',
    critical: false,
    target: 'utility_outage',
    params: { outageKind: {}, startsAt: {}, endsAt: {} },
  },
  'utility_outage.rescheduled': {
    priority: 'normal',
    category: 'utilities',
    critical: false,
    target: 'utility_outage',
    params: { outageKind: {}, startsAt: {}, endsAt: {} },
  },
  'utility_outage.ended': {
    priority: 'normal',
    category: 'utilities',
    critical: false,
    target: 'utility_outage',
    params: { outageKind: {}, startsAt: {}, endsAt: {} },
  },
  'utility_outage.cancelled': {
    priority: 'normal',
    category: 'utilities',
    critical: false,
    target: 'utility_outage',
    params: { outageKind: {}, startsAt: {}, endsAt: {} },
  },
  /**
   * A readiness item given to its owner, and one past its day, told once
   * (ADR 0067): the day only, never the title. It leads to the program.
   */
  'readiness_item.assigned': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'readiness_program',
    params: { dueOn: {} },
  },
  'readiness_item.overdue': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'readiness_program',
    params: { dueOn: {} },
  },
  /**
   * A work permit asked for (to who decides them), and its decision or
   * revocation (to the technician who asked; ADR 0067): the hazard and the
   * ticket's number, never the precautions.
   */
  'work_permit.requested': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { hazard: {}, ticketNumber: {} },
  },
  'work_permit.approved': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { hazard: {}, ticketNumber: {} },
  },
  'work_permit.rejected': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { hazard: {}, ticketNumber: {} },
  },
  'work_permit.revoked': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'ticket',
    params: { hazard: {}, ticketNumber: {} },
  },
  /** A meter's latest period used far more than its mean (ADR 0066). */
  'meter.anomaly': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'meter',
    params: { meterRef: {}, readOn: {} },
  },
  /**
   * The same spike on a unit's meter, to the household living there (ADR
   * 0069) when the mean it beat was all its own: the kind and the day,
   * never a figure.
   */
  'meter.unit_spike': {
    priority: 'normal',
    category: 'utilities',
    critical: false,
    target: 'unit',
    params: { meterKind: {}, readOn: {} },
  },
  /** A maintenance contract ends within its notice days (ADR 0065). */
  'maintenance_contract.expiring': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'maintenance_contract',
    params: { contractRef: {}, endsOn: {} },
  },
  'asset.warranty_expiring': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'asset',
    params: { assetRef: {}, endsOn: {} },
  },
  /** A plan's work is past its due date and grace (the owner and dispatch). */
  'maintenance.plan_overdue': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'maintenance_plan',
    params: { assetRef: {}, dueOn: {} },
  },
  // Inspections (ADR 0064): the target's code and the day only.
  /** An inspection is mine to do, due on a day. */
  'inspection.assigned': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'inspection',
    params: { targetRef: {}, dueOn: {} },
  },
  /** An inspection is past its day (the inspector, who manages them). */
  'inspection.overdue': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'inspection',
    params: { targetRef: {}, dueOn: {} },
  },
  /** A technician recommends replacing an asset (who keeps the register). */
  'asset.replacement_recommended': {
    priority: 'normal',
    category: 'maintenance',
    critical: false,
    target: 'asset_replacement_recommendation',
    params: { assetRef: {} },
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

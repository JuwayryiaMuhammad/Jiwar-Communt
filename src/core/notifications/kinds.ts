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

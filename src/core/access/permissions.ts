import type { AccountType } from '@prisma/client';

// ============================================================================
// Permission catalog (ADR 0010)
// ============================================================================
//
// The only place permissions are defined. `kinds` lists the role kinds a
// permission may ever be granted to, so e.g. `roles.manage` can never reach
// the resident role, whatever a manager does.
//
// Changing this file? Run `pnpm access:sync` (a deploy step). Removal is
// never inferred: to remove a permission, move it to `retiredPermissions`;
// to rename one, add `old: new` to `renamedPermissions`. Narrowing `kinds`
// is the exception: the sync revokes the grants a kind may no longer hold,
// and PermissionsGuard ignores them until it has run.

export interface PermissionDefinition {
  kinds: readonly AccountType[];
  /**
   * Held by what an account is, never by its role (ADR 0051): a sitting
   * board member holds `governance.board` while the seat lasts. `kinds` is
   * empty, so no role may hold it (the API refuses it, a grant made in the
   * database never counts); the domain that owns the fact registers its
   * check with `DerivedGrants`, asked on every request, never cached.
   */
  derived?: true;
}

export const PERMISSIONS = {
  'units.read': { kinds: ['manager', 'resident', 'family'] },
  'units.create': { kinds: ['manager'] },
  // The compound's units as a list (`GET /units`) for a staff role: their
  // codes, buildings and floors, never their people. Not `units.read`: that
  // one opens each unit's household and money to whoever the unit is theirs.
  'units.directory': { kinds: ['staff'] },
  'accounts.read': { kinds: ['manager'] },
  'accounts.manage': { kinds: ['manager'] },
  // Account deletion (ADR 0023): the three-step erasure, and legal holds.
  'accounts.erase': { kinds: ['manager'] },
  'accounts.legal_hold': { kinds: ['manager'] },
  'residents.read': { kinds: ['manager'] },
  'residents.manage': { kinds: ['manager'] },
  // Acting for an account that does not use the app (ADR 0036): its
  // delivery preferences, consents, an export or a deletion request, each
  // with a reason code, marked assisted, the account told.
  'residents.assist': { kinds: ['manager'] },
  'roles.read': { kinds: ['manager'] },
  'roles.manage': { kinds: ['manager'] },
  'audit.read': { kinds: ['manager'] },
  'settings.manage': { kinds: ['manager'] },
  // Household (ADR 0016). The service still requires the unit's primary
  // resident (or a delegate) on top of the permission.
  'household.manage': { kinds: ['resident', 'family'] },
  'household.approve': { kinds: ['manager'] },
  // Manager decisions on a household: removal during a separation (ADR 0021).
  'household.override': { kinds: ['manager'] },
  // Only the primary resident delegates (checked by the service).
  'household.delegate': { kinds: ['resident'] },
  // Domestic workers (ADR 0017). The service still requires an occupant of
  // the unit (or a `workers` delegate) on top of `workers.manage`.
  'workers.manage': { kinds: ['resident', 'family'] },
  'workers.review': { kinds: ['manager'] },
  'workers.ban': { kinds: ['manager'] },
  // The compliance officer (ADR 0022): underage reports and their cases.
  'workers.compliance': { kinds: ['manager'] },
  // Lost and confiscated cards: management now, security with the gate.
  'workers.incidents': { kinds: ['manager'] },
  // The gate (ADR 0028). Guards operate it inside a shift; managers set up
  // the gates and read the entries; occupants and members invite visitors
  // (capabilities.visitorsInvite decides per unit).
  'gate.operate': { kinds: ['staff'] },
  'gate.manage': { kinds: ['manager'] },
  'gate.read': { kinds: ['manager'] },
  'visitors.invite': { kinds: ['resident', 'family'] },
  // One's own photo, shown to the guard at the gate (ADR 0031).
  'profile.photo': { kinds: ['resident', 'family'] },
  // Maintenance (ADR 0032). Residents and family open tickets
  // (capabilities.tickets decides per unit); technicians work the ones
  // assigned to them; dispatchers (a supervisor, or the manager) assign
  // them and see every ticket; the manager sets categories and settings.
  'tickets.create': { kinds: ['resident', 'family'] },
  'tickets.work': { kinds: ['staff'] },
  'tickets.dispatch': { kinds: ['staff', 'manager'] },
  'maintenance.manage': { kinds: ['manager'] },
  // Parcels (ADR 0035). Guards receive and hand over inside a shift; the
  // manager reads every parcel (no names) and sets the holding periods.
  // Residents act through the capability `parcels`, with no permission.
  'parcels.handle': { kinds: ['staff'] },
  'parcels.manage': { kinds: ['manager'] },
  // Requests to the management (ADR 0039). Residents and family open and
  // follow their own; handlers (a staff member, or the manager) answer,
  // assign and close them and run the appointments; the manager sets the
  // topics, targets, office hours and reads the ratings.
  'requests.create': { kinds: ['resident', 'family'] },
  'requests.handle': { kinds: ['staff', 'manager'] },
  'requests.manage': { kinds: ['manager'] },
  // Community life (ADR 0040). Residents and family read what is published
  // to them, answer events, vote for their unit (capabilities.pollsVote
  // decides per unit) and send suggestions; staff holding
  // `community.publish` write announcements, works, events and polls, and
  // those holding `community.suggestions` handle the suggestions.
  'community.read': { kinds: ['resident', 'family'] },
  'suggestions.create': { kinds: ['resident', 'family'] },
  'community.publish': { kinds: ['staff', 'manager'] },
  'community.suggestions': { kinds: ['staff', 'manager'] },
  // Neighbours (ADR 0042). Residents and family complain about another
  // unit and follow their own complaints, and use the lost-and-found and
  // lending boards with their masked contact; handlers (a staff member, or
  // the manager) work the complaints, the desk and the reported
  // conversations; the manager sets the categories, limits and welcome.
  'neighbours.complain': { kinds: ['resident', 'family'] },
  'neighbours.board': { kinds: ['resident', 'family'] },
  'neighbours.handle': { kinds: ['staff', 'manager'] },
  'neighbours.manage': { kinds: ['manager'] },
  // Facilities and bookings (ADR 0044). Residents and family see the
  // facilities and book for a unit (capabilities.bookings decides per
  // unit); `facilities.manage` sets up facilities, their rules, hours,
  // peaks and closures, and the club's plans; `bookings.handle` works the
  // bookings (approvals, no-shows, cancellations, suspensions);
  // `club.billing` keeps the memberships and records offline payments (the
  // accountant).
  'facilities.book': { kinds: ['resident', 'family'] },
  'facilities.manage': { kinds: ['staff', 'manager'] },
  'bookings.handle': { kinds: ['staff', 'manager'] },
  'club.billing': { kinds: ['staff', 'manager'] },
  // Vehicles and parking (ADR 0045). Residents and family register their
  // unit's vehicles (capabilities.vehicles decides per unit) and report
  // wrong parking; `vehicles.manage` approves vehicles, issues stickers and
  // sets up slots and visitor areas; `fines.issue` issues fines and decides
  // appeals; `fines.billing` records offline payments (the accountant);
  // `parking_reports.handle` works the reports queue. The guard's plate
  // lookup is `gate.operate`.
  'vehicles.register': { kinds: ['resident', 'family'] },
  'parking.report': { kinds: ['resident', 'family'] },
  'vehicles.manage': { kinds: ['staff', 'manager'] },
  'fines.issue': { kinds: ['staff', 'manager'] },
  'fines.billing': { kinds: ['staff', 'manager'] },
  'parking_reports.handle': { kinds: ['staff', 'manager'] },
  // Finance (ADR 0046). Residents and family see and pay a unit's invoices
  // with `units.read` (capabilities.financeView / financePay decide per
  // unit). `finance.gateway` sets the compound's Paymob account and turns
  // online payment on or off; `finance.billing` keeps the recurring
  // billing plans; `finance.invoice` issues invoices and credit notes;
  // `finance.payments` records payments made at the office, reverses them
  // and lists every payment (a cashier may hold it alone).
  'finance.gateway': { kinds: ['manager'] },
  'finance.billing': { kinds: ['staff', 'manager'] },
  'finance.invoice': { kinds: ['staff', 'manager'] },
  'finance.payments': { kinds: ['staff', 'manager'] },
  // Emergencies and gate services (ADR 0047). Residents and family report
  // an emergency (capabilities.emergency decides per unit) and ask security
  // for a service (capabilities.gateEntry: people who live there). A guard
  // on an open shift responds with `gate.operate`; `emergencies.respond`
  // makes anyone else a responder (a control room); `emergencies.manage`
  // watches every emergency, is told when nobody answered, and may answer
  // or resolve one; `gate_services.handle` works the requests queue.
  'emergencies.report': { kinds: ['resident', 'family'] },
  'gate_services.request': { kinds: ['resident', 'family'] },
  'emergencies.respond': { kinds: ['staff', 'manager'] },
  'emergencies.manage': { kinds: ['manager'] },
  'gate_services.handle': { kinds: ['staff', 'manager'] },
  // Finance part 2 (ADR 0048). `finance.refund` pays a unit's credit back
  // and reverses such refunds, after a step-up (manager only);
  // `finance.reports` reads the compound's ledger and the finance reports
  // and exports them. Instalment plans and disputes are `finance.invoice`.
  'finance.refund': { kinds: ['manager'] },
  'finance.reports': { kinds: ['staff', 'manager'] },
  // The annual budget and expenses (ADR 0055). `finance.budget` drafts a
  // fiscal year's budget, records expenses against its lines and voids
  // them, and sets the month the fiscal year starts. The board approves
  // the budget; budget vs actual is `finance.reports`.
  'finance.budget': { kinds: ['staff', 'manager'] },
  // Permits (ADR 0049). Residents and family ask for a unit's permits: the
  // unit's primary for works, moves and material exits, anyone who may
  // invite visitors for an event (the service decides per unit);
  // `permits.manage` decides them, removes a contractor worker, unlocks a
  // locked-out worker or guard and sets the compound's work hours. The
  // guard sees and records them with `gate.operate`, inside a shift.
  'permits.request': { kinds: ['resident', 'family'] },
  'permits.manage': { kinds: ['staff', 'manager'] },
  // Guard shifts and tasks (ADR 0050). A guard works inside a shift with
  // `gate.operate`. `guard_roster.manage` keeps the roster (weekly
  // templates and single slots), reads attendance and overtime, approves
  // swaps and keeps the handover checklist; `guard_tasks.manage` gives
  // guards tasks; `guard_instructions.manage` sends instructions guards
  // must acknowledge; `guard_reports.read` reads and exports the daily
  // report; `found_items.manage` receives found items from the gate and
  // records claims at the office.
  'guard_roster.manage': { kinds: ['staff', 'manager'] },
  'guard_tasks.manage': { kinds: ['staff', 'manager'] },
  'guard_instructions.manage': { kinds: ['staff', 'manager'] },
  'guard_reports.read': { kinds: ['staff', 'manager'] },
  'found_items.manage': { kinds: ['staff', 'manager'] },
  // Governance (ADR 0051). Owners read the board, the polls and the
  // elections and vote with `governance.read` (capabilities.governanceVote
  // decides per unit; a tenant sees nothing). `governance.board` is a
  // sitting board member's, derived from the seat: it puts polls and
  // elections to the owners and publishes the board's decisions and
  // minutes. `governance.manage` keeps the board register, appoints,
  // disqualifies, certifies, and may do whatever the board does.
  'governance.read': { kinds: ['resident'] },
  'governance.board': { kinds: [], derived: true },
  'governance.manage': { kinds: ['manager'] },
  // Board matters (ADR 0055). `governance.approvals` raises decision
  // packages for the board (the manager and the accountant), follows them
  // and withdraws its own. A sitting member decides them, and appeals to
  // the board, with `governance.board`; `governance.manage` marks an
  // approved request implemented, keeps the deadlines and thresholds and
  // follows decided appeals up, never deciding either.
  'governance.approvals': { kinds: ['staff', 'manager'] },
  // Patrols (ADR 0052). `patrols.manage` keeps the checkpoints (and their
  // QR), the routes and their schedules, and cancels runs; a guard walks
  // them with `gate.operate`, inside a shift. Runs and the patrol report
  // are read with `patrols.manage` or `guard_reports.read`.
  'patrols.manage': { kinds: ['staff', 'manager'] },
  // Security (ADR 0053). `incidents.manage` investigates and closes the
  // incidents guards report; `blocklist.manage` keeps the bans and the
  // watchlist; `violations.manage` decides the appeals of the violations
  // and cancels them, `violations.issue` issues them from the office (a
  // guard issues inside a shift with `gate.operate`). `lockdown.end` ends a
  // lockdown a guard started: the manager only. Payments of violations are
  // `fines.billing`, as the fines' are.
  'incidents.manage': { kinds: ['staff', 'manager'] },
  'blocklist.manage': { kinds: ['staff', 'manager'] },
  'violations.manage': { kinds: ['staff', 'manager'] },
  'violations.issue': { kinds: ['staff', 'manager'] },
  'lockdown.end': { kinds: ['manager'] },
  // The gate's completion (ADR 0056). `gate_exceptions.decide`: the
  // on-duty management answers the guards' field exceptions (every holder
  // is asked, the first answer wins).
  'gate_exceptions.decide': { kinds: ['manager'] },
  // The gate log searched by a visitor's full name, exactly (ADR 0056):
  // the manager only, audited, rate-limited.
  'gate_log.search': { kinds: ['manager'] },
  // The gate offline (ADR 0057): the guard devices (enrolled by a guard,
  // revoked here), their sync health, the flags their uploads raised, and
  // the quarantined batches of a revoked one, accepted or rejected.
  'gate_devices.manage': { kinds: ['staff', 'manager'] },
  // Partners (ADR 0060). Residents and family find the compound's service
  // partners, keep favourites and request a service for a unit
  // (capabilities.visitorsInvite decides per unit: the partner's staff
  // come to the door); `partners.manage` lists the partners, their
  // services, prices, hours and desk links, suspends and reinstates them,
  // relays requests for a partner who phones, and decides complaints.
  'partners.request': { kinds: ['resident', 'family'] },
  'partners.manage': { kinds: ['staff', 'manager'] },
} as const satisfies Record<string, PermissionDefinition>;

export type Permission = keyof typeof PERMISSIONS;

/** Permissions removed on purpose; `access:sync` deletes them everywhere. */
export const RETIRED_PERMISSIONS: readonly string[] = [];

/** `old → new`; `access:sync` moves assignments as they are. */
export const RENAMED_PERMISSIONS: Readonly<Record<string, Permission>> = {};

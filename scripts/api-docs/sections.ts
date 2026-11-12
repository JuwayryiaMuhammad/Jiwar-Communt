/**
 * How each audience's operations are grouped into files (and Postman folders).
 * A section takes the first matching operation; anything no rule takes lands
 * in the audience's "Other" section and is reported, so a new controller never
 * disappears from the docs.
 */
import type { Audience } from './audiences';

export interface OpFacts {
  /** Without `/api/v1`, with a leading slash. */
  path: string;
  method: string;
  tag: string;
}

export interface Section {
  slug: string;
  title: string;
  blurb: string;
  /** Files under docs/api/notes/ that explain the area. */
  notes?: string[];
  match: (op: OpFacts) => boolean;
}

/** True when `path` is one of the prefixes or below it. */
function under(path: string, prefixes: string[]): boolean {
  return prefixes.some((p) => path === `/${p}` || path.startsWith(`/${p}/`));
}
const pre =
  (...prefixes: string[]) =>
  (op: OpFacts) =>
    under(op.path, prefixes);
const tag =
  (...tags: string[]) =>
  (op: OpFacts) =>
    tags.includes(op.tag);
const any =
  (...rules: ((op: OpFacts) => boolean)[]) =>
  (op: OpFacts) =>
    rules.some((r) => r(op));

/** Sign-in, session and account endpoints every signed-in user has. */
const accountRule = any(
  tag(
    'auth',
    'consents',
    'security',
    'preferences',
    'notifications',
    'push',
    'files',
  ),
  (op) => op.tag === 'data-exports' && op.path.startsWith('/me/'),
  pre(
    'me/locale',
    'me/sessions',
    'me/devices',
    'me/logins',
    'me/deletion-request',
    'me/contact',
    'me/photo',
    'me/identity-changes',
  ),
  (op) => op.path === '/me',
);

const ACCOUNT_SECTION: Section = {
  slug: 'auth-and-account',
  title: 'Sign-in and account',
  blurb:
    'Sign in with a one-time code, sessions and devices, the profile, consents, personal-data export and account deletion, notifications and push tokens, file uploads.',
  notes: ['account-checks.md'],
  match: accountRule,
};

const OTHER: Section = {
  slug: 'other',
  title: 'Other',
  blurb:
    'Endpoints no section rule claimed. Move them to a section in `scripts/api-docs/sections.ts`.',
  match: () => true,
};

// ---------------------------------------------------------------------------
// resident
// ---------------------------------------------------------------------------
const RESIDENT: Section[] = [
  {
    ...ACCOUNT_SECTION,
    blurb:
      'Sign in with a one-time code, self-registration and invites, sessions and devices, the profile, consents, personal-data export and account deletion, notifications and push tokens, file uploads, and "my requests, appeals and notices".',
    match: any(
      accountRule,
      pre('me/requests', 'me/appeals', 'me/search', 'me/notices'),
      pre('registrations', 'public/registrations', 'invites', 'proxy-invites'),
    ),
  },
  {
    slug: 'units-and-household',
    title: 'Unit and household',
    blurb:
      "The caller's units and permissions on them, the household and its invites, delegation, members' permissions, proxies, contracts, moves and unit documents.",
    notes: [
      'unit-and-contracts.md',
      'moving-and-closed-units.md',
      'transfers-closed-units.md',
      'money-and-unit.md',
      'unit-register.md',
    ],
    match: any(
      tag(
        'units',
        'household',
        'member-permissions',
        'delegations',
        'unit-states',
      ),
      pre('me/units', 'me/delegations', 'me/contracts', 'me/proxy-units'),
    ),
  },
  {
    slug: 'domestic-workers',
    title: 'Domestic workers',
    blurb:
      'Registering a worker for the unit, the access code and card, suspending and ending, the wage and its payments, attendance.',
    match: tag('workers'),
  },
  {
    slug: 'gate-and-visitors',
    title: 'Gate and visitors',
    blurb:
      "Visitor passes, the gate's approval requests and standing instructions, gate calls, entry QR credentials, gate status, parcels, children at the gate.",
    notes: ['gate-card-visitors.md', 'children.md'],
    match: tag(
      'visitors',
      'gate-requests',
      'gate-calls',
      'gates',
      'parcels',
      'children',
      'entry-credentials',
    ),
  },
  {
    slug: 'vehicles-and-parking',
    title: 'Vehicles, parking and violations',
    blurb:
      "The unit's vehicles, parking slots and visitor parking, fines and appeals, wrong-parking reports, violations.",
    notes: ['gate-card-vehicles.md'],
    match: tag('vehicles', 'parking', 'parking-reports', 'fines', 'violations'),
  },
  {
    slug: 'emergencies-and-gate-services',
    title: 'Emergencies and gate services',
    blurb:
      'Reporting an emergency, emergency contacts, help requests (wheelchair, escort, lane), security reports, places.',
    notes: ['gate-card-emergency-services.md'],
    match: tag('emergencies', 'gate-services', 'places'),
  },
  {
    slug: 'permits',
    title: 'Permits (fit-out, moving, material exit, events)',
    blurb:
      'Asking for a works, moving, material-exit or event permit, contractor workers, guests, fit-out.',
    notes: ['permits.md', 'fit-out.md'],
    match: tag('permits'),
  },
  {
    slug: 'maintenance',
    title: 'Maintenance and tickets',
    blurb:
      'Opening a ticket, follow-up and messages, visit slots, confirming, rating and escalating, preventive services, outages, unit consumption.',
    notes: ['dispatch-depth.md', 'maintenance-analytics.md'],
    match: any(tag('tickets', 'maintenance'), pre('me/outages')),
  },
  {
    slug: 'management-requests',
    title: 'Requests to management',
    blurb:
      'A request to the management and its conversation, office appointments, appealing a decision, official letters.',
    notes: ['office-queue.md', 'appeals-and-voice.md'],
    match: tag('management-requests', 'management'),
  },
  {
    slug: 'community',
    title: 'Community and daily life',
    blurb:
      'Announcements, events, polls, suggestions, prayer times, buses, the gallery, the daily brief.',
    notes: ['community-life.md', 'experience.md'],
    match: tag('community'),
  },
  {
    slug: 'neighbours',
    title: 'Neighbours',
    blurb:
      'Complaints between neighbours, notices, lost-and-found and the board, conversations and blocking, the welcome message.',
    match: tag('neighbours'),
  },
  {
    slug: 'facilities-and-bookings',
    title: 'Facilities, bookings and the club',
    blurb:
      'Facilities and their slots, bookings, invitations and the waiting list, club membership, shared spaces.',
    notes: ['spaces.md', 'booking-extras-charges.md'],
    match: tag('bookings', 'facilities', 'club', 'spaces'),
  },
  {
    slug: 'finance',
    title: 'Money',
    blurb:
      'Invoices and payments, paying online, instalment plans, disputing an invoice, deposits, the clearance certificate, collector visits, where fees went.',
    notes: ['finance.md', 'money-and-unit.md', 'payables.md'],
    match: any(tag('finance'), pre('me/deposits')),
  },
  {
    slug: 'governance',
    title: 'Governance and the board',
    blurb:
      "The general assembly and voting, compound documents, the building representative, emergency guides, decisions, and the board member's own work.",
    notes: ['governance.md', 'board-work.md', 'resident-decisions.md'],
    match: tag('governance'),
  },
  {
    slug: 'market-and-partners',
    title: 'Market and partners',
    blurb:
      'Market listings, shops and group offers; service partners and requests to them.',
    notes: ['partners.md'],
    match: tag('market', 'partners'),
  },
  OTHER,
];

// ---------------------------------------------------------------------------
// manager (the management's and the compound staff's dashboards)
// ---------------------------------------------------------------------------
const FINANCE_LEDGER = pre(
  'staff/finance/gl',
  'staff/finance/ledger',
  'staff/finance/tax',
);
const FINANCE_TREASURY = pre(
  'staff/finance/cash-accounts',
  'staff/finance/cash-flow',
  'staff/finance/cash-movements',
  'staff/finance/cash-transfers',
  'staff/finance/cheques',
  'staff/finance/statement-imports',
  'staff/finance/statement-lines',
  'staff/finance/statement-matches',
  'staff/finance/custody',
  'staff/finance/custody-handins',
  'staff/finance/custody-investigations',
  'staff/finance/gateway',
  'staff/finance/gateway-events',
);
const FINANCE_BUDGET = pre(
  'staff/finance/budgets',
  'staff/finance/budget-lines',
  'staff/finance/budget-settings',
  'staff/finance/budget-transfers',
  'staff/finance/expenses',
  'staff/finance/expense-authorizations',
  'staff/finance/commitments',
  'staff/finance/board-authorizations',
  'staff/finance/spending-reports',
  'finance/spending-reports',
  'staff/finance/variance-settings',
);
const FINANCE_PAYABLES = pre(
  'staff/finance/vendor-invoices',
  'staff/finance/contract-payables',
  'staff/finance/contract-disbursements',
  'staff/finance/vendor-guarantees',
  'maintenance/contract-payments',
);

const MANAGER: Section[] = [
  ACCOUNT_SECTION,
  {
    slug: 'dashboard-and-inbox',
    title: 'Dashboard, inbox and search',
    blurb:
      "The operations dashboard, the inbox and its bulk approval, daily briefs, deputies, search, the staff member's own tasks and certificates.",
    notes: ['operations-dashboard.md', 'inbox-authority-deputy.md'],
    match: any(
      tag('search'),
      (op) => op.tag === 'staff' && !op.path.startsWith('/staff/experience'),
    ),
  },
  {
    slug: 'reports',
    title: 'Reports and exports',
    blurb: 'Report views, exports, schedules and runs, the compound export.',
    notes: ['reports-platform.md'],
    match: tag('reports'),
  },
  {
    slug: 'roles-accounts-audit',
    title: 'Roles, accounts and audit',
    blurb:
      'Roles and permissions, settings and the audit log, accounts (freeze, reactivate, contact), access reviews and dangling accounts, assisted actions for accounts, erasure and legal holds.',
    notes: ['account-checks.md'],
    match: tag('admin', 'accounts', 'assist', 'erasure'),
  },
  {
    slug: 'registrations-and-residents',
    title: 'Registrations and residents',
    blurb:
      'Registration links and requests, identity changes, the resident directory and their occupancies.',
    match: tag('registration', 'residents'),
  },
  {
    slug: 'units-and-households',
    title: 'Units and households',
    blurb:
      'The unit register, imports and exports, households, moves, contracts, documents, proxies, ownership transfers, closed and deceased units.',
    notes: [
      'unit-register.md',
      'unit-and-contracts.md',
      'moving-and-closed-units.md',
      'transfers-closed-units.md',
    ],
    match: tag(
      'units',
      'household',
      'member-permissions',
      'delegations',
      'unit-states',
    ),
  },
  {
    slug: 'domestic-workers',
    title: 'Domestic workers',
    blurb:
      'Reviewing worker registrations, bans, compliance cases and underage reports, card incidents.',
    match: tag('workers'),
  },
  {
    slug: 'finance-billing',
    title: 'Finance: billing and collection',
    blurb:
      'Invoices and batches, payments, refunds, billing and instalment plans, disputes, deposits, clearance certificates, collectors and their visits, late notices.',
    notes: ['finance.md', 'money-and-unit.md'],
    match: (op) =>
      op.tag === 'finance' &&
      !FINANCE_LEDGER(op) &&
      !FINANCE_TREASURY(op) &&
      !FINANCE_BUDGET(op) &&
      !FINANCE_PAYABLES(op) &&
      !op.path.startsWith('/staff/finance/reports'),
  },
  {
    slug: 'finance-treasury',
    title: 'Finance: treasury and cash',
    blurb:
      'Bank and cash accounts, movements and transfers, cheques, statement import and matching, custody, cash-flow forecast, the payment gateway.',
    notes: ['treasury.md', 'cash-flow.md'],
    match: FINANCE_TREASURY,
  },
  {
    slug: 'finance-budget',
    title: 'Finance: budgets and spending',
    blurb:
      'Budgets and their lines, transfers, expenses and authorizations, commitments, spending reports, variance settings.',
    match: FINANCE_BUDGET,
  },
  {
    slug: 'finance-payables',
    title: 'Finance: vendor payables',
    blurb:
      "Vendors' invoices, contract payables and disbursements, guarantees.",
    notes: ['payables.md'],
    match: FINANCE_PAYABLES,
  },
  {
    slug: 'finance-ledger-and-tax',
    title: 'Finance: general ledger and tax',
    blurb:
      'The chart of accounts, journal entries and periods, VAT and withholding tax, tax certificates.',
    notes: ['general-ledger.md', 'taxes.md'],
    match: FINANCE_LEDGER,
  },
  {
    slug: 'finance-reports',
    title: 'Finance: reports',
    blurb:
      'The finance reports: aging, collection, statements and their exports.',
    match: (op) => op.path.startsWith('/staff/finance/reports'),
  },
  {
    slug: 'maintenance-tickets',
    title: 'Maintenance: tickets and dispatch',
    blurb:
      'The ticket queue and its detail, assignment, categories and specialties, SLA settings and reports, KPIs, costs, technicians.',
    notes: ['dispatch-depth.md', 'maintenance-analytics.md'],
    match: (op) =>
      tag('tickets')(op) ||
      (op.tag === 'maintenance' &&
        pre(
          'maintenance/tickets',
          'maintenance/cases',
          'maintenance/categories',
          'maintenance/specialties',
          'maintenance/dispatch-settings',
          'maintenance/sla-report',
          'maintenance/sla-settings',
          'maintenance/kpis',
          'maintenance/ticket-costs',
          'maintenance/quote-suggestions',
          'maintenance/complaints-map',
          'maintenance/work-orders',
          'maintenance/recurrence',
          'maintenance/service-pressure',
          'maintenance/settings',
          'maintenance/economics',
          'maintenance/technicians',
          'maintenance/units',
          'maintenance/documents',
        )(op)),
  },
  {
    slug: 'maintenance-assets-and-plans',
    title: 'Maintenance: assets, inspections and plans',
    blurb:
      'The asset register and imports, areas, checklists, inspections and rounds, maintenance plans, preventive services, capital plans, warranty claims, work permits.',
    match: pre(
      'maintenance/assets',
      'maintenance/asset-types',
      'maintenance/asset-imports',
      'maintenance/areas',
      'maintenance/checklists',
      'maintenance/inspections',
      'maintenance/inspection-rounds',
      'maintenance/inspection-report',
      'maintenance/plans',
      'maintenance/plan-calendar',
      'maintenance/plan-occurrences',
      'maintenance/plan-suggestions',
      'maintenance/preventive-services',
      'maintenance/capital-plans',
      'maintenance/replacement-recommendations',
      'maintenance/warranty-claims',
      'maintenance/work-permits',
      'technician/assets',
      'technician/plans',
      'technician/scan',
    ),
  },
  {
    slug: 'maintenance-stock-and-energy',
    title: 'Maintenance: store, meters and energy',
    blurb:
      'The maintenance store (items, levels, movements), part requests, meters and their readings, consumption, tariffs, saving measures, utility outages.',
    notes: ['maintenance-analytics.md'],
    match: any(
      (op) => /^\/units\/\{unitId\}\/consumption/.test(op.path),
      pre(
        'maintenance/stock',
        'maintenance/stores',
        'maintenance/part-requests',
        'maintenance/energy',
        'maintenance/meters',
        'maintenance/meter-alerts',
        'maintenance/meter-reading-imports',
        'maintenance/outages',
        'technician/meters',
      ),
    ),
  },
  {
    slug: 'readiness-and-compliance',
    title: 'Readiness and compliance',
    blurb:
      'Readiness programs and items, compliance calendar, evidence and occurrences, field safety.',
    notes: ['compliance-safety.md'],
    match: pre(
      'maintenance/readiness',
      'staff/readiness-items',
      'staff/compliance',
    ),
  },
  {
    slug: 'vendors-and-procurement',
    title: 'Vendors, tenders and purchasing',
    blurb:
      'The vendor register and their contractors, tenders and bid opening, purchase requests, purchase orders and their receipts, maintenance contracts.',
    notes: [
      'procurement.md',
      'purchase-orders.md',
      'contractors-tenders.md',
      'guard-vendors.md',
    ],
    match: pre(
      'staff/vendors',
      'staff/tenders',
      'staff/purchase-requests',
      'staff/purchase-orders',
      'maintenance/contracts',
    ),
  },
  {
    slug: 'field-team',
    title: 'Field team',
    blurb:
      "The technicians' roster and attendance, zones, certificates with expiry, instructions, help requests and reinforcement calls.",
    notes: ['field-team.md'],
    match: tag('field-team'),
  },
  {
    slug: 'security-guards',
    title: 'Security: guards, shifts and tasks',
    blurb:
      "The guards' roster, attendance and swaps, tasks, instructions, handovers, found items, the security report, unit entries and inspection requests.",
    notes: ['guard-shifts-tasks.md', 'guard-vendors.md'],
    match: any(
      pre(
        'staff/security/roster',
        'staff/security/swaps',
        'staff/security/tasks',
        'staff/security/instructions',
        'staff/security/handovers',
        'staff/security/handover-items',
        'staff/security/attendance',
        'staff/security/guards',
        'staff/security/posts',
        'staff/security/found-items',
        'staff/security/unit-entries',
        'staff/security/closed-units',
        'staff/security/inspection-requests',
      ),
      (op) => op.tag === 'guard-duty',
    ),
  },
  {
    slug: 'security-incidents-and-patrols',
    title: 'Security: incidents, patrols and lockdown',
    blurb:
      'Incidents and corrective actions, patrol routes, checkpoints and runs, lockdowns, the blocklist, child alerts, the control room, security reports.',
    notes: ['patrols.md', 'security.md'],
    match: any(
      tag('incidents', 'lockdown', 'patrols', 'control-room', 'blocklist'),
      pre('staff/security'),
    ),
  },
  {
    slug: 'security-gate',
    title: 'Security: the gate',
    blurb:
      'Gates and devices, offline bundles, field exceptions, the gate log, service vehicles, alarm devices, parcels, gate settings and reports.',
    notes: ['gate-completion.md', 'offline.md'],
    match: any(
      tag(
        'gate',
        'gate-devices',
        'gates',
        'parcels',
        'gate-calls',
        'gate-requests',
        'children',
        'emergencies',
        'gate-services',
      ),
      pre('staff/gate', 'parcel-settings'),
    ),
  },
  {
    slug: 'vehicles-parking-and-fines',
    title: 'Vehicles, parking, violations and fines',
    blurb:
      'Registered vehicles and settings, parking slots and visitor parking, violations and their payments, vehicle fines, wrong-parking reports.',
    notes: ['gate-card-vehicles.md'],
    match: tag('vehicles', 'parking', 'parking-reports', 'fines', 'violations'),
  },
  {
    slug: 'permits',
    title: 'Permits and inspections',
    blurb:
      'Reviewing unit permits (fit-out, moving, material exit, events), permit settings and inspections, material entries.',
    notes: ['permits.md', 'fit-out.md'],
    match: tag('permits'),
  },
  {
    slug: 'governance',
    title: 'Governance',
    blurb:
      'The board and its terms, elections and polls, publications and approvals, board appeals, handover, unit shares, the representatives, compound documents.',
    notes: ['governance.md', 'board-work.md', 'resident-decisions.md'],
    match: tag('governance'),
  },
  {
    slug: 'management-requests',
    title: 'Requests, appointments and letters',
    blurb:
      'The requests queue, topics and assignees, templates, office hours and appointments, ratings, decision appeals, official letters.',
    notes: ['office-queue.md', 'appeals-and-voice.md'],
    match: tag('management-requests', 'management'),
  },
  {
    slug: 'experience',
    title: 'Resident experience',
    blurb:
      'Experience cases, promises, compensations and their rules, ratings report, signals.',
    notes: ['experience.md'],
    match: pre('staff/experience'),
  },
  {
    slug: 'community',
    title: 'Community',
    blurb:
      'Announcements and templates, events, polls, suggestions, buses, the gallery, places, prayer settings, holidays.',
    notes: ['community-life.md'],
    match: tag('community', 'places'),
  },
  {
    slug: 'facilities-bookings-and-club',
    title: 'Facilities, bookings, club and spaces',
    blurb:
      'Facilities and closures, bookings and suspensions, the club plans and memberships, shared spaces, floor plans, the site map.',
    notes: ['spaces.md', 'booking-extras-charges.md'],
    match: tag('facilities', 'bookings', 'club', 'spaces'),
  },
  {
    slug: 'neighbours',
    title: 'Neighbours',
    blurb:
      'Complaint handling and categories, posts and claims, reports, settings, the welcome template.',
    match: tag('neighbours'),
  },
  {
    slug: 'market-and-partners',
    title: 'Market and partners',
    blurb:
      "Reviewing market listings and shops, group offers, settings; the partner register, requests, complaints, ratings and settings, partners' desk links.",
    notes: ['partners.md'],
    match: tag('market', 'partners'),
  },
  OTHER,
];

// ---------------------------------------------------------------------------
// guard (the gate app)
// ---------------------------------------------------------------------------
const GUARD: Section[] = [
  ACCOUNT_SECTION,
  {
    slug: 'shift-and-gate',
    title: 'Shift and gate operations',
    blurb:
      'Starting and ending a shift, verifying a visitor or resident, entries and exits, who is inside, plate lookup, visitor parking, approval requests, devices, field exceptions, service vehicles, offline bundles.',
    notes: ['gate-completion.md', 'offline.md', 'gate-card-visitors.md'],
    match: any(
      pre(
        'gate/shifts',
        'gate/verify',
        'gate/entries',
        'gate/inside',
        'gate/directory',
        'gate/plate-lookup',
        'gate/visitor-parking',
        'gate/approval-requests',
        'gate/devices',
        'gate/gates',
        'gate/field-exceptions',
        'gate/service-vehicles',
        'gate/offline',
        'gate/vehicle-passages',
        'gate/alarm-devices',
      ),
      tag('gates', 'gate-devices'),
    ),
  },
  {
    slug: 'identity-and-blocklist',
    title: 'Identity checks and blocklist',
    blurb: 'ID lookups and scans, face checks, the blocklist.',
    match: any(
      tag('blocklist'),
      pre('gate/id-lookup', 'gate/id-scans', 'gate/face-checks'),
    ),
  },
  {
    slug: 'guard-duty',
    title: 'My work: tasks, roster, handovers',
    blurb:
      "The guard's work list, tasks, the roster and attendance, swaps, handovers, instructions, found items.",
    notes: ['guard-shifts-tasks.md'],
    match: tag('guard-duty'),
  },
  {
    slug: 'patrols',
    title: 'Patrols',
    blurb:
      'Patrol routes, starting a run, scanning checkpoints (QR, NFC or by hand), completing a run.',
    notes: ['patrols.md'],
    match: tag('patrols'),
  },
  {
    slug: 'incidents-and-emergencies',
    title: 'Incidents, lockdown and emergencies',
    blurb: 'Recording incidents, lockdowns, answering emergency reports.',
    notes: ['security.md'],
    match: tag('incidents', 'lockdown', 'emergencies'),
  },
  {
    slug: 'parcels-calls-and-children',
    title: 'Parcels, calls and children',
    blurb:
      'Receiving and handing over parcels, calls to the unit, children leaving the compound.',
    notes: ['children.md'],
    match: tag('parcels', 'gate-calls', 'children'),
  },
  {
    slug: 'permits-vehicles-and-services',
    title: 'Permits, vehicles and gate services',
    blurb:
      'Unit permits and material entries at the gate, violations, wrong-parking reports, gate services (help requests), places.',
    notes: [
      'permits.md',
      'gate-card-vehicles.md',
      'gate-card-emergency-services.md',
    ],
    match: tag(
      'permits',
      'vehicles',
      'violations',
      'parking-reports',
      'gate-services',
      'places',
      'spaces',
    ),
  },
  OTHER,
];

// ---------------------------------------------------------------------------
// technician (the field app)
// ---------------------------------------------------------------------------
const TECHNICIAN: Section[] = [
  ACCOUNT_SECTION,
  {
    slug: 'tickets',
    title: 'My tickets',
    blurb:
      'The tickets assigned to the technician: taking, visiting, checklist, quotes, parts, completion, incidents and SOS.',
    notes: ['dispatch-depth.md', 'field-team.md'],
    match: any(pre('technician/tickets'), tag('tickets')),
  },
  {
    slug: 'assets-inspections-and-meters',
    title: 'Assets, inspections, plans and meters',
    blurb:
      "Scanning an asset tag and reading its card, the asset register and its areas, checklists and plans (read), inspections, meter readings, the store's items, part requests, upcoming plans.",
    match: any(
      pre(
        'technician/assets',
        'technician/inspections',
        'technician/meters',
        'technician/part-requests',
        'technician/plans',
        'technician/scan',
        'technician/stock',
        'technician/stats',
      ),
      pre(
        'maintenance/areas',
        'maintenance/asset-types',
        'maintenance/assets',
        'maintenance/checklists',
        'maintenance/documents',
        'maintenance/plan-calendar',
        'maintenance/plan-suggestions',
        'maintenance/plans',
      ),
      tag('search'),
    ),
  },
  {
    slug: 'purchases',
    title: 'Purchase requests and vendors',
    blurb:
      'A part or a service the store lacks (purchase requests), the vendor register to pick from, and confirming a service on the purchase order that followed.',
    notes: ['procurement.md', 'purchase-orders.md'],
    match: pre(
      'staff/purchase-requests',
      'staff/vendors',
      'staff/purchase-orders',
    ),
  },
  {
    slug: 'field-team',
    title: 'Field team: roster, availability and help',
    blurb:
      "Availability and location consent, the technician's roster and attendance, instructions, help requests, reinforcement calls.",
    notes: ['field-team.md'],
    match: tag('field-team', 'technician'),
  },
  {
    slug: 'compound-reference',
    title: 'Compound reference: map, floor plans, holidays',
    blurb: "The site map, floor plans and the compound's holidays, read-only.",
    notes: ['spaces.md'],
    match: tag('spaces'),
  },
  OTHER,
];

// ---------------------------------------------------------------------------
// contractor
// ---------------------------------------------------------------------------
const CONTRACTOR: Section[] = [
  ACCOUNT_SECTION,
  {
    slug: 'portal',
    title: 'Contractor portal: dispatches, contracts, invoices',
    blurb:
      'The vendor profile, the dispatches (tickets) offered to the vendor, contracts, the purchase orders sent to it, invoices to submit.',
    notes: ['contractors-tenders.md', 'purchase-orders.md'],
    match: pre(
      'contractor/vendor',
      'contractor/dispatches',
      'contractor/contracts',
      'contractor/purchase-orders',
      'contractor/invoices',
    ),
  },
  {
    slug: 'tenders',
    title: 'Tenders and bids',
    blurb:
      'Tenders the vendor is invited to, sending and withdrawing a bid, bid documents; the company bid link.',
    notes: ['contractors-tenders.md', 'procurement.md'],
    match: any(pre('contractor/tenders', 'public/tender-bids')),
  },
  {
    slug: 'tickets',
    title: 'Tickets the contractor took',
    blurb:
      'The technician routes a contractor uses on the tickets of its vendor.',
    notes: ['dispatch-depth.md'],
    match: any(
      pre('technician'),
      tag('tickets', 'maintenance', 'emergencies', 'incidents'),
    ),
  },
  OTHER,
];

// ---------------------------------------------------------------------------
// partner (the desk opened from a link)
// ---------------------------------------------------------------------------
const PARTNER: Section[] = [
  {
    slug: 'desk',
    title: "The partner's desk",
    blurb:
      'A partner opens its desk from a link (no sign-in) and accepts, declines, proposes another window, marks done or cancels a request.',
    notes: ['partners.md'],
    match: pre('public/partner-desk'),
  },
  OTHER,
];

// ---------------------------------------------------------------------------
// platform
// ---------------------------------------------------------------------------
const PLATFORM: Section[] = [
  {
    slug: 'auth',
    title: 'Platform sign-in',
    blurb:
      'Email and password login, refresh, logout, changing the password, step-up codes for sensitive actions.',
    match: any(pre('platform/auth', 'platform/step-up')),
  },
  {
    slug: 'tenants',
    title: 'Compounds (tenants)',
    blurb:
      "Creating, listing and suspending compounds, their managers, a compound's online-payment account.",
    notes: ['reports-platform.md'],
    match: pre('platform/tenants'),
  },
  {
    slug: 'audit',
    title: 'Audit and security events',
    blurb: "The platform owner's audit log and the security events.",
    match: pre('platform/audit', 'platform/security-events'),
  },
  OTHER,
];

// ---------------------------------------------------------------------------
// public (no sign-in)
// ---------------------------------------------------------------------------
const PUBLIC: Section[] = [
  {
    slug: 'auth',
    title: 'Sign-in',
    blurb:
      'Request a login code, verify it, pick an account, refresh, sign out.',
    match: pre('auth'),
  },
  {
    slug: 'registration-and-invites',
    title: 'Registration and invites',
    blurb:
      'Self-registration, the status link of a registration, accepting a household or proxy invite.',
    match: pre(
      'registrations',
      'public/registrations',
      'invites',
      'proxy-invites',
    ),
  },
  {
    slug: 'visitor-and-pickup-pages',
    title: 'Visitor and pickup pages',
    blurb:
      "A visitor's pass opened from the host's link, a child's pickup code.",
    match: pre('public/visitor-passes', 'public/child-pickups'),
  },
  {
    slug: 'verify-documents',
    title: 'Verifying documents',
    blurb:
      'Check a receipt, an official letter, a clearance certificate or a works completion certificate by its code.',
    match: pre(
      'public/receipts',
      'public/letters',
      'public/clearances',
      'public/works-certificates',
    ),
  },
  {
    slug: 'tender-bids',
    title: 'Tender bid links',
    blurb:
      'A company opens a tender from its bid link, sends or withdraws a bid, uploads its documents.',
    notes: ['contractors-tenders.md'],
    match: pre('public/tender-bids'),
  },
  {
    slug: 'partner-desk',
    title: 'Partner desk links',
    blurb: 'A partner opens its desk from a link and answers the requests.',
    notes: ['partners.md'],
    match: pre('public/partner-desk'),
  },
  {
    slug: 'security-and-privacy',
    title: 'Security and privacy links',
    blurb: '"Not me" from an alert email, assisted data export download.',
    match: pre('public/not-me', 'public/data-exports'),
  },
  {
    slug: 'health',
    title: 'Health',
    blurb: 'Readiness and the root route.',
    match: (op) => op.path === '/health' || op.path === '' || op.path === '/',
  },
  OTHER,
];

export const SECTIONS: Record<Audience, Section[]> = {
  resident: RESIDENT,
  manager: MANAGER,
  guard: GUARD,
  technician: TECHNICIAN,
  contractor: CONTRACTOR,
  partner: PARTNER,
  platform: PLATFORM,
  public: PUBLIC,
};

export function sectionFor(audience: Audience, op: OpFacts): Section {
  const list = SECTIONS[audience];
  return list.find((s) => s.match(op)) ?? list[list.length - 1];
}

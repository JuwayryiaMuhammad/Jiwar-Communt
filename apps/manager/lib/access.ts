/**
 * Who this dashboard is for: managers, and any account whose role holds a
 * maintenance permission (a maintenance supervisor dispatches from here) or
 * handles requests to the management (ADR 0039), publishes to the community
 * or handles its suggestions (ADR 0040), handles complaints between
 * units and the boards (ADR 0042), or sets up the facilities, works the
 * bookings or keeps the club's memberships (ADR 0044), works vehicles,
 * parking, fines and parking reports (ADR 0045), keeps the units'
 * billing plans, invoices or payments (ADR 0046), watches the
 * emergencies or works the gate service requests (ADR 0047), reads
 * the finance reports (ADR 0048), decides the units' permits (ADR 0049),
 * or keeps the guards' roster, tasks, instructions, daily report or found
 * items (ADR 0050), raises matters for the board or keeps the budget and
 * its expenses, or sits on the owners' board (its derived `governance.board`,
 * ADR 0055), or keeps the compound's service partners (ADR 0060).
 * Closing parking reports admits nobody since every
 * guard does it from the app (ADR 0050).
 * Decided from `GET /me`, by the BFF at sign-in and by the shell on every
 * load; the API still checks each call.
 */
export const ENTRY_PERMISSIONS = [
  'tickets.dispatch',
  'maintenance.manage',
  'requests.handle',
  'requests.manage',
  'community.publish',
  'community.suggestions',
  'neighbours.handle',
  'facilities.manage',
  'bookings.handle',
  'club.billing',
  'vehicles.manage',
  'fines.issue',
  'fines.billing',
  'finance.billing',
  'finance.invoice',
  'finance.payments',
  'emergencies.manage',
  'emergencies.respond',
  'gate_services.handle',
  'finance.reports',
  'permits.manage',
  'guard_roster.manage',
  'guard_tasks.manage',
  'guard_instructions.manage',
  'guard_reports.read',
  'found_items.manage',
  'patrols.manage',
  'incidents.manage',
  'blocklist.manage',
  'violations.manage',
  // The gate offline's devices and flags (ADR 0057).
  'gate_devices.manage',
  'violations.issue',
  'lockdown.end',
  'governance.approvals',
  'finance.budget',
  'governance.board',
  // The compound's service partners, their requests and complaints (ADR 0060).
  'partners.manage',
] as const;

export function mayEnter(me: { type?: unknown; permissions?: unknown } | null | undefined): boolean {
  if (!me) return false;
  if (me.type === 'manager') return true;
  const held = Array.isArray(me.permissions) ? (me.permissions as unknown[]) : [];
  return ENTRY_PERMISSIONS.some((p) => held.includes(p));
}

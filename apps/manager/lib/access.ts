/**
 * Who this dashboard is for: managers, and any account whose role holds a
 * maintenance permission (a maintenance supervisor dispatches from here) or
 * handles requests to the management (ADR 0039), publishes to the community
 * or handles its suggestions (ADR 0040), handles complaints between
 * units and the boards (ADR 0042), or sets up the facilities, works the
 * bookings or keeps the club's memberships (ADR 0044), works vehicles,
 * parking, fines and parking reports (ADR 0045), keeps the units'
 * billing plans, invoices or payments (ADR 0046), watches the
 * emergencies or works the gate service requests (ADR 0047), or reads
 * the finance reports (ADR 0048), or decides the units' permits (ADR 0049).
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
  'parking_reports.handle',
  'finance.billing',
  'finance.invoice',
  'finance.payments',
  'emergencies.manage',
  'emergencies.respond',
  'gate_services.handle',
  'finance.reports',
  'permits.manage',
] as const;

export function mayEnter(me: { type?: unknown; permissions?: unknown } | null | undefined): boolean {
  if (!me) return false;
  if (me.type === 'manager') return true;
  const held = Array.isArray(me.permissions) ? (me.permissions as unknown[]) : [];
  return ENTRY_PERMISSIONS.some((p) => held.includes(p));
}

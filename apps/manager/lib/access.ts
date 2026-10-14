/**
 * Who this dashboard is for: managers, and any account whose role holds a
 * maintenance permission (a maintenance supervisor dispatches from here) or
 * handles requests to the management (ADR 0039), publishes to the community
 * or handles its suggestions (ADR 0040), handles complaints between
 * units and the boards (ADR 0042), or sets up the facilities, works the
 * bookings or keeps the club's memberships (ADR 0044).
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
] as const;

export function mayEnter(me: { type?: unknown; permissions?: unknown } | null | undefined): boolean {
  if (!me) return false;
  if (me.type === 'manager') return true;
  const held = Array.isArray(me.permissions) ? (me.permissions as unknown[]) : [];
  return ENTRY_PERMISSIONS.some((p) => held.includes(p));
}

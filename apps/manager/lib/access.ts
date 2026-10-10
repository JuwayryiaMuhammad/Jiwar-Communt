/**
 * Who this dashboard is for: managers, and any account whose role holds a
 * maintenance permission (a maintenance supervisor dispatches from here).
 * Decided from `GET /me`, by the BFF at sign-in and by the shell on every
 * load; the API still checks each call.
 */
export const ENTRY_PERMISSIONS = ['tickets.dispatch', 'maintenance.manage'] as const;

export function mayEnter(me: { type?: unknown; permissions?: unknown } | null | undefined): boolean {
  if (!me) return false;
  if (me.type === 'manager') return true;
  const held = Array.isArray(me.permissions) ? (me.permissions as unknown[]) : [];
  return ENTRY_PERMISSIONS.some((p) => held.includes(p));
}

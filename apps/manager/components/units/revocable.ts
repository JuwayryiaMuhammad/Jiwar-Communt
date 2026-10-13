/** The permissions a primary may give a household member (ADR 0021). */
export const MEMBER_PERMISSIONS = ['visitors_invite', 'bookings', 'tickets', 'finance', 'unit_security', 'polls_vote'] as const;

/**
 * What the revoke dialog offers for a member. The API tells a manager who
 * reads residents which permissions the member holds (`grantedPermissions`):
 * only those are offered, in the catalog's order, and none when they hold
 * none. Without that (`held` undefined: the role does not read residents)
 * every permission is offered, and one the member does not hold is refused
 * by the API.
 */
export function revocable(held: readonly string[] | undefined): { known: boolean; options: readonly string[] } {
  if (held === undefined) return { known: false, options: MEMBER_PERMISSIONS };
  return { known: true, options: MEMBER_PERMISSIONS.filter((p) => held.includes(p)) };
}

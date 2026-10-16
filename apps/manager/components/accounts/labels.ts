/** Why an account cannot be erased yet (the backend's DELETION_BLOCKERS). */
export const BLOCKER_TEXT: Record<string, string> = {
  primary_resident: 'Primary resident of a unit: name another primary first',
  active_staff_role: 'Still an active staff or manager account: deactivate it first',
  legal_hold: 'On legal hold',
  open_worker_obligations:
    'Registered a domestic worker whose wage is not settled: end the registration, then close its wage obligation from the worker’s page',
};

/** What a consent code means, for the person and for the manager acting for them. */
export const CONSENT_TEXT: Record<string, { title: string; body: string }> = {
  ticket_phone_share: {
    title: 'Share phone with the technician',
    body: 'The technician working on their ticket sees their phone number while the work is open.',
  },
};

export const NOTIFICATION_CATEGORY_TEXT: Record<string, string> = {
  maintenance: 'Maintenance',
  gate_visitors: 'Gate and visitors',
  parcels: 'Parcels',
  household: 'Household',
  account_security: 'Account and security',
  management: 'Requests to the management',
  community: 'Community: important announcements, cancelled events, suggestions',
  neighbours: 'Neighbours: complaints between units, lost and found, lending, the welcome',
  bookings: 'Bookings of the facilities and the club',
  safety: 'Emergencies and gate services',
  permits: 'Permits: works and contractors, moves, material exits, events',
  governance: 'The owners’ board: its polls, elections and results',
};

/** Personal fields an erasure blanks, as the scope lists them. */
export function fieldLabel(field: string): string {
  const text = field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Why an account cannot be erased yet (the backend's DELETION_BLOCKERS). */
export const BLOCKER_TEXT: Record<string, string> = {
  primary_resident: 'Primary resident of a unit: name another primary first',
  active_staff_role: 'Still an active staff or manager account: deactivate it first',
  legal_hold: 'On legal hold',
  open_worker_obligations:
    'Registered a domestic worker whose wage is not settled: end the registration, then close its wage obligation from the worker’s page',
  deposit_held: 'The management still holds a deposit of theirs: settle it from the unit’s papers first',
};

/** What a consent code means, for the person and for the manager acting for them. */
export const CONSENT_TEXT: Record<string, { title: string; body: string }> = {
  ticket_phone_share: {
    title: 'Share phone with the technician',
    body: 'The technician working on their ticket sees their phone number while the work is open.',
  },
  // One per category of service (ADR 0060).
  partner_share_gas_water: {
    title: 'Share a request’s details with gas and water partners',
    body: 'A partner they ask sees the unit’s code, their first name, the time, the note and the lines of that one request.',
  },
  partner_share_pharmacy: {
    title: 'Share a request’s details with the pharmacy partners',
    body: 'A partner they ask sees the unit’s code, their first name, the time, the note and the lines of that one request.',
  },
  partner_share_grocery: {
    title: 'Share a request’s details with groceries partners',
    body: 'A partner they ask sees the unit’s code, their first name, the time, the note and the lines of that one request.',
  },
  partner_share_home_services: {
    title: 'Share a request’s details with home services partners',
    body: 'A partner they ask sees the unit’s code, their first name, the time, the note and the lines of that one request.',
  },
  partner_share_laundry: {
    title: 'Share a request’s details with laundry and carpets partners',
    body: 'A partner they ask sees the unit’s code, their first name, the time, the note and the lines of that one request.',
  },
  partner_share_gardening: {
    title: 'Share a request’s details with gardening partners',
    body: 'A partner they ask sees the unit’s code, their first name, the time, the note and the lines of that one request.',
  },
  partner_share_beauty_at_home: {
    title: 'Share a request’s details with barber and salon at home partners',
    body: 'A partner they ask sees the unit’s code, their first name, the time, the note and the lines of that one request.',
  },
  partner_share_repair: {
    title: 'Share a request’s details with repairs partners',
    body: 'A partner they ask sees the unit’s code, their first name, the time, the note and the lines of that one request.',
  },
  partner_share_pets: {
    title: 'Share a request’s details with pets partners',
    body: 'A partner they ask sees the unit’s code, their first name, the time, the note and the lines of that one request.',
  },
  partner_share_events: {
    title: 'Share a request’s details with event setup partners',
    body: 'A partner they ask sees the unit’s code, their first name, the time, the note and the lines of that one request.',
  },
  partner_share_moving_storage: {
    title: 'Share a request’s details with moving and storage partners',
    body: 'A partner they ask sees the unit’s code, their first name, the time, the note and the lines of that one request.',
  },
  partner_share_car_services: {
    title: 'Share a request’s details with car services partners',
    body: 'A partner they ask sees the unit’s code, their first name, the time, the note and the lines of that one request.',
  },
  partner_share_elderly_care: {
    title: 'Share a request’s details with elderly care partners',
    body: 'A partner they ask sees the unit’s code, their first name, the time, the note and the lines of that one request.',
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
  partners: 'Requests to the compound’s service partners',
  utilities: 'Water, electricity and gas cut off in their building',
};

/** Personal fields an erasure blanks, as the scope lists them. */
export function fieldLabel(field: string): string {
  const text = field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

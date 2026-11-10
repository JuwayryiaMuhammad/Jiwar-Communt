/** Closed units' inspection requests (ADR 0063): app/(dashboard)/security/inspection-requests. */
export default {
  title: 'Inspection requests',
  description: 'Closed units their owners ask the guards to visit. Schedule one as an inspection task.',
  show: 'Show',
  cancelled: 'Cancelled.',
  empty: 'No request here',
  emptyHint: 'An owner asks from the app while the unit is closed.',
  'col.unit': 'Unit',
  'col.day': 'Preferred day',
  'col.asked': 'Asked',
  schedule: 'Schedule',
  cancelTitle: 'Cancel the request',
  cancelDescription: 'The owner sees the reason. A scheduled one is cancelled with its task.',
} as const;

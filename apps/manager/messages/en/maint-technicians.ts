/** Maintenance's technicians (ADR 0033): components/maintenance/technicians. */
export default {
  technician: 'Technician',
  thisTechnician: 'this technician',
  specialtiesSaved: "{name}'s specialties are saved.",
  specialtiesTitle: 'Specialties of {name}',
  specialtiesDescription:
    'Auto-dispatch offers a ticket only to technicians with a specialty its category needs. None ticked clears them all.',
  noSpecialties: 'The compound has no specialties yet.',
  retired: '{name} (no longer in use)',
  availabilitySaved: '{name} is now {state, select, available {available} other {unavailable}}.',
  empty: 'No technician yet',
  emptyHint: 'Add a staff account with the technician role on the Staff page.',
  'col.technician': 'Technician',
  'col.availability': 'Availability',
  'col.specialties': 'Specialties',
  'col.open': 'Open tickets',
  'col.workload': 'Workload',
  workloadHint: 'Open tickets weighted by status and priority: what auto-dispatch balances.',
  since: 'Since {when}',
  specialties: 'Specialties',
  setUnavailable: 'Set unavailable',
  setAvailable: 'Set available',
  unavailableTitle: 'Set {name} unavailable?',
  unavailableDescription:
    'Auto-dispatch stops offering them tickets. The tickets they already have stay with them until you reassign them.',
} as const;

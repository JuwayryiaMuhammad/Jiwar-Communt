/** Maintenance setup's specialties (ADR 0033): components/maintenance-setup/specialties. */
export default {
  saved: '{name} is saved.',
  added: '{name} is added.',
  editTitle: 'Edit {name}',
  newTitle: 'New specialty',
  newDescription: 'A skill a technician has and a category needs, e.g. plumbing. Auto-dispatch matches the two.',
  saveAndRetire: 'Save and retire',
  addSpecialty: 'Add specialty',
  inUse: 'In use. Unticked retires it: it counts for no category and no technician, so auto-dispatch stops matching on it',
  newSpecialty: 'New specialty',
  empty: 'No specialty yet',
  emptyHint: 'Add the skills your technicians have, then give them to technicians (Maintenance, Technicians) and to categories.',
  'col.specialty': 'Specialty',
  'col.code': 'Code',
  retired: 'Retired',
} as const;

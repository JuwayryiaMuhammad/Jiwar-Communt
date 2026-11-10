/** Technicians’ work permits (ADR 0067): app/(dashboard)/work-permits. */
export default {
  title: 'Work permits',
  description: 'Hot work, height, live electrical, confined spaces and pool chemicals: the work starts only with a permit in force.',
  approved: 'Approved; the technician is told.',
  rejected: 'Rejected; the technician is told.',
  revoked: 'Revoked; the technician is told to stop that work.',
  empty: 'No permit',
  'col.hazard': 'Hazard',
  'col.ticket': 'Ticket',
  'col.precautions': 'Precautions',
  'col.asked': 'Asked',
  'col.expires': 'Expires',
  'col.status': 'Status',
  openTicket: 'Open the ticket',
  rejectTitle: 'Reject the permit',
  revokeAction: 'Revoke',
  revokeTitle: 'Revoke the permit',
} as const;

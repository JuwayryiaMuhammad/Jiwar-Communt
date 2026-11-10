/** Complaints against partners (ADR 0060): app/(dashboard)/partners/complaints (the list and one complaint). */
export default {
  title: 'Partner complaints',
  description:
    'What residents complained of about a partner, and the compensation they asked. Nothing is paid through Jiwar: a credit note is issued in Finance.',
  shown: 'Complaints shown',
  'view.toDecide': 'To decide',
  'view.decided': 'Decided',
  emptyToDecide: 'Nothing to decide',
  empty: 'No complaint',
  'col.complaint': 'Complaint',
  'col.partner': 'Partner',
  'col.asks': 'Asks',
  'col.decision': 'Decision',
  'col.made': 'Made',
  // One complaint.
  complaint: 'Complaint',
  openConversation: 'Open the conversation',
  decide: 'Decide',
  request: 'Request',
  notDecided: 'Not decided yet',
  // The decision dialog.
  'decide.title': 'Decide this complaint',
  'decide.description': 'Once. A credit note is issued in Finance by its own page: nothing is paid here.',
  'decide.done': 'Decided. The resident was told.',
  outcome: 'Outcome',
  arrangement: 'What the management arranges',
} as const;

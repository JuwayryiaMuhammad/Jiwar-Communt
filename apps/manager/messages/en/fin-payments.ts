/** Payments (ADR 0046): app/(dashboard)/finance/payments. */
export default {
  title: 'Payments',
  description: 'Every payment pays the oldest invoices due first. Money beyond what a unit owes is its credit, applied to its next invoices.',
  record: 'Record a payment',
  channel: 'Channel',
  office: 'At the office',
  online: 'Online',
  method: 'Method',
  any: 'Any',
  paidFrom: 'Paid from',
  paidTo: 'to',
  empty: 'No payment matches',
  receipt: 'Receipt',
  paidOn: 'Paid on',
  reversed: 'Reversed',
  credit: 'Credit {amount}',
  recorded: 'Recorded',
} as const;

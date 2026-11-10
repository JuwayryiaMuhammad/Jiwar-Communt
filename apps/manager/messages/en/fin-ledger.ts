/** The compound's ledger (ADR 0048): app/(dashboard)/finance/ledger. */
export default {
  title: 'Ledger',
  description: 'Every invoice, credit note, payment and refund of the period, and their reversals, oldest first.',
  exportCsv: 'Export CSV',
  any: 'Any',
  empty: 'Nothing in this period',
  day: 'Day',
  number: 'Number',
  related: 'Related',
  how: 'How',
  debit: 'Debit',
  credit: 'Credit',
  moved: 'Moved',
} as const;

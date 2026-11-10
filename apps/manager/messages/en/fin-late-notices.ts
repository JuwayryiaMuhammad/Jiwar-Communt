/** Formal late-payment notices (ADR 0058): app/(dashboard)/finance/late-notices. */
export default {
  title: 'Late notices',
  description: 'Formal notices of late payment, the compound’s record: who got each, and the proof they did and read it.',
  empty: 'No notice yet',
  notice: 'Notice',
  owed: 'Owed',
  due: 'Due',
  issued: 'Issued',
  proofs: 'Proofs',
  proofLine: '{all} delivered · {emailed} emailed · {read} read',
  'cure.title': 'Cure period',
  'cure.label': 'Days after the due date',
  'cure.hint': 'An invoice still owed this many days after its due date, not disputed and not in a plan, gets one formal notice.',
  'cure.invalid': 'A whole number from {min} to {max}.',
  'cure.saved': 'Cure period saved.',
} as const;

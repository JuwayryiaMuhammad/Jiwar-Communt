/** Closing months of the general ledger (ADR 0092): app/(dashboard)/finance/gl/periods. */
export default {
  title: 'Closing months',
  description: 'A closed month takes no entry: a correction is a reversing entry in an open month.',
  months: 'The ledger’s months',
  monthsHint: 'Newest first, from the first entry’s month.',
  month: 'Month',
  closed: 'Closed',
  reopened: 'Reopened',
  closeThrough: 'Close through it',
  reopen: 'Reopen',
  closeTitle: 'Close through {month}?',
  closeDescription: 'It and every open month before it. No entry is then dated in them.',
  closeConfirm: 'Close',
  closeDone: 'Closed.',
  reopenTitle: 'Reopen {month}',
  reopenDescription: 'Entries may then be dated in it again. Recorded with the reason.',
  reopenDone: 'Reopened.',
} as const;

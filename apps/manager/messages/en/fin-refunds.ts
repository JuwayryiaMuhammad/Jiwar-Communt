/** Refunds of units' credit (ADR 0048): app/(dashboard)/finance/refunds. */
export default {
  title: 'Refunds',
  description: 'Credit paid back to units. To refund one, open its statement and choose “Refund credit”.',
  empty: 'No refund yet',
  refund: 'Refund',
  by: 'By',
  reference: 'Reference',
  refundedOn: 'Paid back on',
  recordedBy: 'Recorded by',
  reversed: 'Reversed',
  reverse: 'Reverse',
  reversedToast: 'Refund {number} reversed: the money is the unit’s credit again.',
  reverseTitle: 'Reverse refund {number}?',
  reverseDescription: 'A new record undoes it; nothing is edited. The money is the unit’s credit again and pays what it owes.',
} as const;

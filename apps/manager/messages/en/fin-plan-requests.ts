/** Plan requests (ADR 0069): app/(dashboard)/finance/plan-requests. */
export default {
  title: 'Plan requests',
  description: 'Payment plans residents asked for on invoices they owe.',
  'status.pending': 'Waiting',
  'status.accepted': 'Accepted',
  'status.declined': 'Declined',
  'status.withdrawn': 'Withdrawn',
  'status.lapsed': 'Lapsed',
  empty: 'None',
  'col.invoice': 'Invoice',
  'col.months': 'Months asked',
  'col.asked': 'Asked',
  accept: 'Accept',
  decline: 'Decline',
  // Accepting.
  accepted: '{invoice} is now a plan of {n, plural, one {# instalment} other {# instalments}}.',
  acceptTitle: 'Accept the plan on {invoice}',
  acceptDescription:
    'Asked over {months, plural, one {# month} other {# months}}. The instalments must add up to what the invoice owes now, as when you split it yourself.',
  owedNow: 'Owed now: {amount}',
  rowDue: 'Instalment {n}, due',
  egp: 'EGP',
  // Declining.
  declined: 'Declined: the resident is told why, by its code.',
  declineTitle: 'Decline the plan on {invoice}',
  why: 'Why',
  // The terms.
  saved: 'Saved: from the next request and notice on.',
  terms: 'Terms for residents',
  maxMonths: 'The most months a resident may ask for',
  maxMonthsHint: '2 to 24.',
  offerFrom: 'Offer a plan from, EGP',
  offerFromHint: 'An invoice that still owes at least this is offered a plan with its due-soon notice. Empty: never.',
  duesNotice: 'Tell a unit when its next month’s dues are far above the months before',
} as const;

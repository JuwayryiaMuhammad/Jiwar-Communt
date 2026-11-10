/** A contract's advances, retention and guarantees (ADR 0089): app/(dashboard)/finance/payables/contracts. */
export default {
  title: 'Advances, retentions and guarantees',
  description:
    'An advance is set off against the contract’s later invoices; a retention held of each payout is released at its end. Nobody approves what they asked for.',
  waiting: 'Waiting for a decision or a payout',
  waitingEmpty: 'Nothing waiting',
  request: 'Request',
  itsContract: 'Its contract',
  contractId: 'Contract id',
  approve: 'Approve',
  turnDown: 'Turn down',
  payToday: 'Pay today',
  approved: '{number} is approved.',
  paid: '{number} is paid as {payout}.',
  rejected: '{number} is turned down.',
  rejectTitle: 'Turn down {number}?',
  // The contract's money.
  moneyTitle: 'The contract’s money',
  retentionNone: 'none',
  summary:
    'Retention {pct}: {held} held, {released} released, {open} open. Advances: {advPaid} paid, {advSetOff} set off, {advOpen} open. Invoices: {toPay} to pay, {paid} paid.',
  askFor: 'Ask for',
  advance: 'An advance',
  release: 'The retention’s release (after its end)',
  egp: 'EGP',
  ask: 'Ask',
  asked: 'Asked as {number}; the approvers were told.',
  noDisbursement: 'No advance or release',
  noGuarantee: 'No guarantee',
  guarantee: 'Guarantee',
  expires: 'Expires',
} as const;

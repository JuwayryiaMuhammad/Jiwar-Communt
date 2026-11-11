/** Tax paid to the tax authority (ADR 0093): components/finance/tax-pay-dialog. */
export default {
  dueVat: 'Still due: {amount}. It leaves a treasury account against VAT payable.',
  dueWithholding: 'Still due: {amount}. It leaves a treasury account against withholding tax payable.',
  amount: 'Amount, EGP',
  paidOn: 'Paid on',
  method: 'Method',
  reference: 'The tax authority’s receipt or the transfer’s reference',
  pay: 'Pay',
  done: 'Recorded as {number}.',
} as const;

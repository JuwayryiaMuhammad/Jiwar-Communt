/** The order and match settings (ADR 0094): app/(dashboard)/purchase-orders/settings. */
export default {
  title: 'Order and match settings',
  description:
    'How far an invoice may differ from its purchase order and what was received before its approval is blocked, and from what amount an order is required. A change applies from the next match; nothing is reposted.',
  ordersLink: 'Purchase orders',
  payablesLink: 'Payables',
  toleranceTitle: 'Tolerances of the three-way match',
  priceTitle: 'Price',
  pricePct: 'Price tolerance (%)',
  priceHint: 'How far above the order’s the unit price on an invoice may be. A lower price never blocks.',
  quantityPct: 'Quantity tolerance (%)',
  quantityHint: 'How far above the quantity ordered, and above what was received, an invoice may bill; also how much over the order a receipt may accept.',
  amount: 'Amount tolerance (EGP)',
  amountHint: 'How much money a line’s price may vary by, and how large a line outside the order may be, before the invoice is blocked.',
  requiredTitle: 'When an order is required',
  poRequiredAbove: 'An order is required above (EGP)',
  poRequiredHint:
    'An invoice above this amount that names no contract must name a purchase order. Leave it empty to never require one; zero requires one for every invoice.',
  saved: 'Saved. It applies from the next match.',
  needsWrite: 'Changing these needs the permission to approve payables.',
} as const;

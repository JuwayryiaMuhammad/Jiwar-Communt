/** Club membership requests (ADR 0070): app/(dashboard)/club/requests. */
export default {
  title: 'Club requests',
  description: "Plans residents asked for. Each owes its price through the unit's invoice; once paid, the membership starts or is extended on its own.",
  'status.requested': 'Waiting for payment',
  'status.paid': 'Paid',
  'status.cancelled': 'Called off',
  empty: 'No request here.',
  'col.unit': 'Unit',
  'col.price': 'Price',
  'col.status': 'Status',
  'col.asked': 'Asked',
  'col.paid': 'Paid',
} as const;

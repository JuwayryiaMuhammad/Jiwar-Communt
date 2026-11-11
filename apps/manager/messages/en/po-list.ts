/** Purchase orders (ADR 0094): app/(dashboard)/purchase-orders. */
export default {
  title: 'Purchase orders',
  description:
    'What the compound orders from its vendors: approved by someone other than who raised it, received in parts, then invoiced and matched to what arrived.',
  raise: 'Raise an order',
  settingsLink: 'Order and match settings',
  view: 'View',
  'view.waiting': 'Waiting for approval',
  'view.all': 'All',
  status: 'Status',
  anyStatus: 'Any status',
  vendor: 'Vendor',
  anyVendor: 'Every vendor',
  empty: 'No purchase order',
  emptyWaiting: 'No order or revision waits for a decision',
  'col.order': 'Order',
  'col.vendor': 'Vendor',
  'col.total': 'Total',
  'col.status': 'Status',
  'col.delivery': 'Delivery',
  'col.raised': 'Raised',
} as const;

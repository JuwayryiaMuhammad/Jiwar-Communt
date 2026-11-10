/** The partners' pages (ADR 0060): words for the codes and the helpers' sentences (components/partners/logic.ts). */
export default {
  // A partner's category.
  'category.gas_water': 'Gas & water',
  'category.pharmacy': 'Pharmacy',
  'category.grocery': 'Grocery',
  'category.home_services': 'Home services',
  'category.laundry': 'Laundry & carpets',
  'category.gardening': 'Gardening',
  'category.beauty_at_home': 'Barber & salon at home',
  'category.repair': 'Repairs',
  'category.pets': 'Pets',
  'category.events': 'Event setup',
  'category.moving_storage': 'Moving & storage',
  'category.car_services': 'Car services',
  'category.elderly_care': 'Elderly care',
  // How a price line is counted.
  'unit.fixed': 'Fixed',
  'unit.per_visit': 'Per visit',
  'unit.visit_fee': 'Visit fee',
  'unit.per_hour': 'Per hour',
  'unit.per_item': 'Per item',
  'unit.per_kg': 'Per kg',
  'unit.per_sqm': 'Per m²',
  // A request's status.
  'status.pending': 'Waiting for the partner',
  'status.proposed': 'Another time proposed',
  'status.accepted': 'Accepted',
  'status.declined': 'Declined',
  'status.cancelled': 'Cancelled',
  'status.expired': 'Expired',
  'status.done': 'Done',
  'status.partner_no_show': 'Partner did not come',
  'status.lapsed': 'Lapsed',
  // How a complaint is decided.
  'outcome.upheld': 'Upheld',
  'outcome.not_upheld': 'Not upheld',
  'compensation.none': 'Nothing',
  'compensation.redo': 'The partner does it again',
  'compensation.partner_refund': 'The partner refunds',
  'compensation.credit_note': 'A credit note (issued in Finance)',
  // Sentences.
  ratingNone: 'No ratings',
} as const;

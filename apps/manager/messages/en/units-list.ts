/** Units (ADR 0072): app/(dashboard)/units — the register, the units under review, the buildings. */
export default {
  title: 'Units',
  description: 'Apartments, villas and shops in the compound.',
  'tab.all': 'All units',
  'tab.review': 'Under review',
  'tab.buildings': 'Buildings',
  import: 'Import',
  newUnit: 'New unit',
  // A new unit.
  added: 'Unit {code} added.',
  code: 'Code',
  codeHint: 'As written on the door, e.g. A-101.',
  addUnit: 'Add unit',
  // The register.
  searchPlaceholder: 'Part of the code',
  any: 'Any',
  csv: 'CSV',
  empty: 'No units match',
  emptyHint: 'Add the compound’s units so residents can be assigned to them.',
  'col.added': 'Added',
  // Under review.
  reviewEmpty: 'No unit is under review',
  reviewEmptyHint: 'A unit is flagged when its primary resident leaves, is frozen or dies, or a separation is reported.',
  'col.occupants': 'Active occupants',
  'col.flagged': 'Flagged',
} as const;

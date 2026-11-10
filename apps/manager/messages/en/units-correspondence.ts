/** A unit's correspondence (ADR 0080): app/(dashboard)/units/[id]/correspondence. */
export default {
  title: 'Correspondence',
  description: 'Everything the unit’s people and the management wrote each other, newest first. Opening this page is recorded in the audit trail.',
  everything: 'Everything',
  'col.when': 'When',
  'col.what': 'What',
  'col.reference': 'Reference',
  fromUnit: 'From the unit',
  toUnit: 'To the unit',
} as const;

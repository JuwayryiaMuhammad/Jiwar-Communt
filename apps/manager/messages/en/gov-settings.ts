/** How long the board has for each kind of matter (ADR 0055): app/(dashboard)/governance/settings. */
export default {
  title: 'Board settings',
  description:
    'Days the board has to decide each kind of matter; past them, the board and the management are told once. Thresholds are shown to the board with each request; the major contract’s always binds, a waiver’s and a payment plan’s when you make them binding.',
  saved: 'Saved. Matters already raised keep their deadlines.',
  typeBoardAppeal: 'Appeal to the board',
  'hint.major_contract': 'The manager’s limit: an expense above it needs a contract the board approved.',
  'hint.waiver_above_limit': 'When binding: a dispute’s credit above it needs a waiver the board approved (ADR 0073).',
  'hint.payment_plan_above_limit': 'When binding: a payment plan above it needs a plan the board approved (ADR 0073).',
  'col.matter': 'Matter',
  'col.days': 'Days to decide',
  'col.threshold': 'Threshold (EGP)',
  'col.binding': 'Binding',
  daysAria: 'Days to decide: {matter}',
  thresholdAria: 'Threshold: {matter}',
  none: 'None',
  aboveItBoardDecides: 'Above it, the board decides',
  always: 'Always',
} as const;

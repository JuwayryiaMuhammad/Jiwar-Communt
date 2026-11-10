/** The audit log: app/(dashboard)/audit. */
export default {
  title: 'Audit log',
  description: 'Every change in the compound, append-only. Entries name people by id and never hold personal values.',
  action: 'Action',
  actionHint: 'Exact, e.g. resident.created',
  targetType: 'Target type',
  targetTypeHint: 'e.g. account, unit',
  reset: 'Reset',
  emptyFiltered: 'No entry matches these filters',
  empty: 'Nothing recorded yet',
  when: 'When',
  by: 'By',
  target: 'Target',
  changes: 'Changes',
} as const;

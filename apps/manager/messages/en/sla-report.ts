/** The SLA report (ADR 0076): app/(dashboard)/sla-report. */
export default {
  title: 'SLA report',
  description:
    'The clocks that ended met or breached over the period, by category, priority and clock. A clock stopped by the SLA being turned off is no verdict.',
  exportCsv: 'Export CSV',
  from: 'From',
  to: 'To',
  metBreached: '{met} met · {breached} breached',
  empty: 'No clock ended in this period',
  'col.category': 'Category',
  'col.priority': 'Priority',
  'col.clock': 'Clock',
  'col.met': 'Met',
  'col.breached': 'Breached',
  'col.rate': 'Met share',
} as const;

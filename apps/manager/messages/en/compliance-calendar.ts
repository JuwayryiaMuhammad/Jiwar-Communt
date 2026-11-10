/** The compliance calendar (ADR 0087): app/(dashboard)/compliance/calendar. */
export default {
  title: 'Compliance calendar',
  description: 'What falls due, and the vendors’ papers that expire, day by day.',
  none: 'Nothing falls due',
  'col.day': 'Day',
  'col.what': 'What',
  'col.kind': 'Kind',
  'col.state': 'State',
  vendorPaper: '{vendor} · {kind} paper',
  truncated: 'More than 1000 entries: ask for fewer days.',
} as const;

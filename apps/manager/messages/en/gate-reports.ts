/** The gate log search and the gate traffic report (ADR 0056, 0079): app/(dashboard)/gate/log-search, gate/traffic. */
export default {
  exportCsv: 'Export CSV',
  everyGate: 'Every gate',
  'col.gate': 'Gate',
  in: 'In',
  out: 'Out',
  // Log search.
  'search.title': 'Gate log search',
  'search.description':
    'Who came in and out, by day, unit, or a visitor’s full name exactly as written. Names are kept 30 days. Every search is recorded, without the name.',
  anyUnit: 'Any unit',
  visitorName: 'Visitor’s full name',
  truncated: 'Only the newest 200 entries are shown: narrow the days or export them.',
  'search.empty': 'No entry matches',
  'col.when': 'When',
  'col.way': 'Way',
  'col.who': 'Who',
  'col.how': 'How',
  methodUnconfirmed: '{method} · unconfirmed',
  // Traffic.
  'traffic.title': 'Gate traffic',
  'traffic.description':
    'Who came in, day by day and gate by gate: visitors by how they came, service vehicles by kind, resident vehicles in and out. 31 days at most.',
  visitors: 'Visitors',
  visitorsHint: '{pass} by pass · {request} asked at the gate · {exception} by exception',
  serviceVehicles: 'Service vehicles',
  serviceHint:
    '{tanker, plural, one {# tanker} other {# tankers}} · {waste} waste · {delivery, plural, one {# delivery} other {# deliveries}}',
  residentVehicles: 'Resident vehicles',
  residentHint: '{out} out',
  'traffic.empty': 'No gate in this period',
  'col.day': 'Day',
  'col.byPass': 'By pass',
  'col.askedAtGate': 'Asked at the gate',
  'col.byException': 'By exception',
  'col.residentsIn': 'Residents in',
  'col.residentsOut': 'Residents out',
} as const;

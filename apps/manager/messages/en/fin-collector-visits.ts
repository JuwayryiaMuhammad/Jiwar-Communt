/** Collector visits (ADR 0069): app/(dashboard)/finance/collector-visits. */
export default {
  title: 'Collector visits',
  description: 'Cash taken at the units by field collectors, on the residents’ request.',
  'filter.open': 'Open',
  'filter.cancelled': 'Called off',
  none: 'None',
  'col.window': 'Window',
  'col.expected': 'Expected',
  'col.why': 'Why',
  reassign: 'Reassign',
  assign: 'Assign',
  callOff: 'Call off',
  // Assigning.
  assignTitle: 'Collector for {unit}',
  assigned: 'Assigned: the collector and the resident are told.',
  collector: 'Collector',
  collectorHint: 'Staff whose role holds collector visits.',
  choose: 'Choose…',
  // Calling one off.
  callOffTitle: 'Call off the visit to {unit}',
  calledOff: 'Called off.',
  keepIt: 'Keep it',
  // The margin.
  marginTitle: 'Collector’s margin',
  marginSaved: 'Margin saved.',
  marginLabel: 'Above what a unit owes, EGP',
  marginHint:
    'A round sum may go a little over; more than this is refused, so a mistyped figure never makes a large credit. 0 to 1000.',
} as const;

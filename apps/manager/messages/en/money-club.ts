/** The club's shared words (ADR 0044): components/club (its rules and the people picker). */
export default {
  'duration.monthly': 'Monthly',
  'duration.quarterly': 'Quarterly',
  'duration.annual': 'Annual',
  'duration.custom': 'Custom',
  durationDays: '{n, plural, one {# day} other {# days}}',
  // When a payment was made (paidOnProblem).
  'paidOn.pickDay': 'Pick a day.',
  'paidOn.future': 'Not in the future.',
  'paidOn.tooOld': 'At most 90 days ago.',
  // The people picker.
  'people.none': 'Nobody lives in this unit now.',
  'people.erased': 'Erased',
  'people.minor': 'Minor',
  'people.occupancy': 'Occupant',
  'people.member': 'Household member',
} as const;

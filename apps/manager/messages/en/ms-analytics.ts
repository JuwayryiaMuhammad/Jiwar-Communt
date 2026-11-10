/** Maintenance setup's analytics numbers and service pressure (ADR 0079, 0081): components/maintenance-setup/analytics-settings and service-pressure. */
export default {
  analytics: 'Analytics',
  'field.recurrenceMinTickets': 'Repeat faults that suggest planned work (2–20)',
  'field.recurrenceWindowDays': 'Counted over (days, 7–366)',
  'field.caseMinTickets': 'Residents’ reports that open a community case (2–20)',
  'field.caseWindowDays': 'Counted over (days, 1–180)',
  analyticsSaved: 'The analytics settings are saved.',
  pressure: 'Service pressure',
  pressureHint:
    'When the open tickets (new, or in a technician’s hands) reach this many for each available technician, the maintenance supervisors and the managers are told: once a rise, and at most once an hour however often it comes and goes. Leave it empty for no alert.',
  underPressure: 'Under pressure',
  withinCapacity: 'Within capacity',
  counts: '{open} open · {available} available',
  since: ' · since {when}',
  threshold: 'Open tickets per available technician (1–100)',
  saveThreshold: 'Save threshold',
  alertOff: 'The service-pressure alert is off.',
  thresholdSaved: 'The threshold is saved.',
} as const;

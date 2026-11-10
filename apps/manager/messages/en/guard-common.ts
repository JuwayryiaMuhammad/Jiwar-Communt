/**
 * The guards' shared words (ADR 0050, 0052, 0053): the helpers of
 * components/security and components/patrols, and their pickers.
 */
export default {
  erased: 'An erased account',
  // A weekly window (`22:00–06:00`) ending before it starts runs into the next day.
  overnight: '{window} (overnight)',
  minutes: '{m} min',
  hours: '{h} h',
  hoursMinutes: '{h} h {m} min',
  // A patrol route's schedule.
  unscheduled: 'Unscheduled',
  everyDay: 'Every day',
  patrolSchedule: '{days} at {times}',
  // Lockdowns and the blocklist (ADR 0053).
  everyGate: 'Every gate',
  aGate: 'A gate',
  lockdownBanner: 'Lockdown in force: {gates}',
  purgedPerson: 'A person (purged)',
  // The pickers.
  'picker.post': 'Select a post…',
  'picker.loadingPosts': 'Loading posts…',
  'picker.gates': 'Gates',
  'picker.zones': 'Zones',
  'picker.guard': 'Select a guard…',
  'picker.loadingGuards': 'Loading guards…',
} as const;

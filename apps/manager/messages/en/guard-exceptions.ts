/** The gate's field exceptions and settings (ADR 0056): components/security/exceptions-logic. */
export default {
  'kind.worker_outside_hours': 'Worker outside hours',
  'kind.visitor_without_pass': 'Visitor without a pass',
  'kind.unregistered_vehicle': 'Unregistered vehicle',
  purgedVehicle: 'A vehicle (purged)',
  aWorker: 'A worker',
  purgedVisitor: 'A visitor (purged)',
  // The gate's settings, with their bounds.
  'setting.exceptionAnswerMinutes': 'Minutes to answer a field exception',
  'setting.exceptionEntryMinutes': 'Minutes an approved exception lets its entry in',
  'setting.visitExpectedMinutes': 'A visit’s expected minutes, when its pass says none',
  'setting.geofenceExitMinutes': 'Minutes outside a patrol’s area before it is flagged',
  'setting.audioMaxSeconds': 'Longest sound recording, in seconds',
  'setting.videoMaxSeconds': 'Longest video recording, in seconds',
  'setting.audioMaxMb': 'Largest sound recording, in MB',
  'setting.videoMaxMb': 'Largest video recording, in MB',
  'setting.offlineSyncAlertMinutes': 'Minutes a gate device on shift may go unseen before you are told',
  'setting.callRingSeconds': 'Seconds a call from the gate rings before it is missed',
  'setting.callMaxSeconds': 'Seconds an answered call from the gate lasts at most',
  'setting.gateBusyNormalFrom': 'Entries in 15 minutes from which a gate reads normal',
  'setting.gateBusyBusyFrom': 'Entries in 15 minutes from which a gate reads busy (above normal)',
  'setting.closedUnitRoundDays': 'Days between a closed unit’s rounds, after it closed or was last inspected',
} as const;

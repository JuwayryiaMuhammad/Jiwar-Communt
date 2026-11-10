/** Maintenance setup's SLA (ADR 0034, 0076): components/maintenance-setup/sla, sla-escalation and sla-targets-dialog. */
export default {
  turnedOn: 'The SLA is on. Clocks start for the open tickets now.',
  turnedOff: 'The SLA is off. The running clocks have stopped.',
  measuring: 'Measuring the SLA',
  on: 'On',
  off: 'Off',
  measuredBody: 'Response and resolution times are measured against each category’s targets below. On since {when}.',
  notMeasuredBody: 'No ticket has a due time, nothing is overdue, and residents cannot escalate. The targets below are kept for when you turn it on.',
  turnOff: 'Turn off',
  turnOn: 'Turn on',
  targetsByCategory: 'Targets by category',
  targetsHint: 'Response / resolution, per priority. A change retargets the clocks still running.',
  stopTitle: 'Stop measuring the SLA?',
  startTitle: 'Start measuring the SLA?',
  stopBody:
    'Every running clock stops now. Open tickets lose their due times, nothing is overdue any more, and residents can no longer escalate. Turning it on again starts fresh clocks; the time in between is never counted.',
  startBody:
    'Clocks start now for every open ticket, against its category’s targets. Nothing is backdated: a ticket opened last week is measured from this moment. Residents will see due times and may escalate a ticket that becomes overdue.',
  stopConfirm: 'Turn off and stop the clocks',
  startConfirm: 'Turn on and start the clocks',
  escalationSaved: 'The escalation levels are saved.',
  escalationLevels: 'Escalation levels',
  escalationHint:
    'At this share of its target (50–95 %), a running clock is at risk: its technician and the maintenance supervisors are told once. At the target itself, the breach tells the managers too. Leave a priority empty for no warning.',
  priorityPercent: '{priority} (%)',
  saveLevels: 'Save levels',
  targetsTitle: 'SLA targets: {name}',
  targetsDescription:
    'In minutes. Response: from opening to the first visit proposal or the start of the work. Resolution: until the technician reports the work done, without the time spent waiting for the resident or for parts.',
  targetsSaved: 'SLA targets of {name} are saved.',
  responseLabel: '{priority}: response',
  resolutionLabel: '{priority}: resolution',
  responseHint: '5 to 10080. {read}',
  resolutionHint: '15 to 43200. {read}',
  atLeastResponse: 'At least the response target.',
  saveTargets: 'Save targets',
} as const;

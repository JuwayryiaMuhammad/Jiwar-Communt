/** The security events and the platform audit log: app/(dashboard)/security-events, app/(dashboard)/audit. */
export default {
  // Shared filters and columns.
  'filter.compound': 'Compound',
  'filter.allCompounds': 'All compounds',
  'filter.reset': 'Reset',
  'col.when': 'When',
  'col.compound': 'Compound',
  // Security events.
  'events.title': 'Security events',
  'events.description':
    'Sign-ins, verification codes and sessions across every compound. Identifiers are stored as hashes, never as emails or phones.',
  'events.filter': 'Event',
  'events.all': 'All events',
  'events.emptyMatch': 'No event matches these filters',
  'events.empty': 'No security events yet',
  'events.col.event': 'Event',
  'events.col.subject': 'Subject',
  'events.col.ip': 'IP',
  'events.platform': 'Platform',
  'subject.account': 'account {id}',
  'subject.admin': 'admin {id}',
  'subject.hash': 'id# {id}',
  // The platform audit log.
  'audit.title': 'Audit log',
  'audit.description':
    'Every platform action, append-only. Entries can’t be edited or deleted, and they never hold personal data.',
  'audit.filter': 'Action',
  'audit.all': 'All actions',
  'audit.emptyMatch': 'No entry matches these filters',
  'audit.empty': 'No platform actions yet',
  'audit.col.action': 'Action',
  'audit.col.changes': 'Changes',
} as const;

/** A board meeting's kinds, states and limits (ADR 0075); the migration's CHECKs repeat them. */
export const MEETING_KINDS = ['regular', 'extraordinary'] as const;
export type MeetingKind = (typeof MEETING_KINDS)[number];

export const MEETING_STATUSES = ['scheduled', 'held', 'cancelled'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const AGENDA_ITEM_KINDS = [
  'approval_request',
  'board_appeal',
  'agenda_proposal',
  'other',
] as const;
export type AgendaItemKind = (typeof AGENDA_ITEM_KINDS)[number];

export const ACTION_STATUSES = ['open', 'done', 'cancelled'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const MEETING_LIMITS = {
  title: 200,
  location: 200,
  agendaItems: 30,
  agendaTitle: 200,
  actionTitle: 300,
  doneNote: 1000,
  /** A meeting is scheduled at most this far back (recorded after the fact) or ahead. */
  backDays: 30,
  aheadDays: 366,
  /** An action's due day: today to a year ahead. */
  dueAheadDays: 366,
} as const;

/** The board's quorum among `seated` seats: more than half (ADR 0055's count). */
export const quorumOf = (seated: number) => Math.floor(seated / 2) + 1;

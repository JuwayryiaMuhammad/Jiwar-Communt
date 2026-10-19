import {
  BOARD_APPEAL_KINDS,
  type BoardAppealKind,
} from '../../core/board-matters/board-matters';

export { BOARD_APPEAL_KINDS, type BoardAppealKind };

/** A staff decision is taken to the board within this many days of it. */
export const APPEAL_WINDOW_DAYS = 15;

export const APPEAL_LIMITS = { grounds: 2000, attachments: 3 } as const;

export const APPEAL_STATUSES = [
  'pending',
  'upheld',
  'overturned',
  'withdrawn',
] as const;
export type AppealStatus = (typeof APPEAL_STATUSES)[number];

export const APPEAL_EFFECTS = ['applied', 'follow_up', 'none'] as const;
export type AppealEffect = (typeof APPEAL_EFFECTS)[number];

/** The number as shown: BA-0001. */
export const appealReference = (n: number) =>
  `BA-${String(n).padStart(4, '0')}`;

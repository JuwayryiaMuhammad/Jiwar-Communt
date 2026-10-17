import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import { addDays } from '../../core/common/slots/day-slots';
import {
  BOARD_KINDS,
  boardOf,
  expiresAt,
  isClaimable,
  isLive,
  parseDay,
  postState,
  stateWhere,
} from './post-rules';

const NOW = new Date('2026-10-20T10:00:00.000Z');
const at = (iso: string) => new Date(iso);
const repo = join(__dirname, '../../..');
const migration = readFileSync(
  join(repo, 'prisma/migrations/20261020090300_neighbour_boards/migration.sql'),
  'utf8',
).replace(/\s+/g, ' ');
const dashboards = readFileSync(
  join(repo, 'packages/api/src/reasons.ts'),
  'utf8',
);
const quoted = (codes: readonly string[]) =>
  codes.map((c) => `'${c}'`).join(', ');

describe('board rules (ADR 0042)', () => {
  it('lost and found are one board, lending the other', () => {
    expect(BOARD_KINDS.lost_found.map(boardOf)).toEqual([
      'lost_found',
      'lost_found',
    ]);
    expect(BOARD_KINDS.lending.map(boardOf)).toEqual(['lending', 'lending']);
  });

  it('a post is open until its day, expired from it on, closed whatever the day', () => {
    const open = { status: 'open' as const };
    expect(
      postState({ ...open, expiresAt: at('2026-10-20T10:00:00.001Z') }, NOW),
    ).toBe('open');
    expect(postState({ ...open, expiresAt: NOW }, NOW)).toBe('expired');
    expect(
      postState({ ...open, expiresAt: at('2026-10-01T00:00:00Z') }, NOW),
    ).toBe('expired');
    expect(
      postState(
        { status: 'closed', expiresAt: at('2027-01-01T00:00:00Z') },
        NOW,
      ),
    ).toBe('closed');
    expect(isLive({ ...open, expiresAt: NOW }, NOW)).toBe(false);
  });

  it('the list asks the same question as the post', () => {
    expect(stateWhere('open', NOW)).toEqual({
      status: 'open',
      expiresAt: { gt: NOW },
    });
    expect(stateWhere('expired', NOW)).toEqual({
      status: 'open',
      expiresAt: { lte: NOW },
    });
    expect(stateWhere('closed', NOW)).toEqual({ status: 'closed' });
  });

  it('each board has its own days, taken when the post is written', () => {
    const days = { lostFoundExpiryDays: 30, lendingExpiryDays: 14 };
    expect(expiresAt('found', NOW, days)).toEqual(
      at('2026-11-19T10:00:00.000Z'),
    );
    expect(expiresAt('lost', NOW, days)).toEqual(
      at('2026-11-19T10:00:00.000Z'),
    );
    expect(expiresAt('lend', NOW, days)).toEqual(
      at('2026-11-03T10:00:00.000Z'),
    );
    expect(expiresAt('borrow', NOW, days)).toEqual(
      at('2026-11-03T10:00:00.000Z'),
    );
  });

  it('only a found item is claimed', () => {
    expect(
      (['lost', 'found', 'lend', 'borrow'] as const).filter(isClaimable),
    ).toEqual(['found']);
  });

  it('a day is a real calendar day, the compound’s today or before', () => {
    const cairo = (text: string, now = NOW) =>
      parseDay(text, now, 'Africa/Cairo');
    expect(cairo('2026-10-19')).toEqual(at('2026-10-19T00:00:00.000Z'));
    expect(cairo('2026-10-20')).toEqual(at('2026-10-20T00:00:00.000Z'));
    expect(cairo('2026-10-21')).toBeNull();
    expect(cairo('2026-02-30')).toBeNull();
    expect(cairo('19/10/2026')).toBeNull();
    expect(cairo('2026-10-19T00:00:00Z')).toBeNull();
  });

  it.each([
    // 2026-10-17 in Cairo (UTC+3), whatever the UTC date.
    ['00:30', '2026-10-16T21:30:00.000Z', '2026-10-17'],
    ['02:59', '2026-10-16T23:59:00.000Z', '2026-10-17'],
    ['23:50', '2026-10-17T20:50:00.000Z', '2026-10-17'],
    // Across 2026-10-29 (the clocks go back at 24:00 UTC+3).
    ['23:30, before', '2026-10-29T20:30:00.000Z', '2026-10-29'],
    ['23:30, again', '2026-10-29T21:30:00.000Z', '2026-10-29'],
    ['00:30 after', '2026-10-29T22:30:00.000Z', '2026-10-30'],
  ])('%s in Cairo: today is %s, tomorrow is refused', (_, iso, today) => {
    const now = at(iso);
    expect(parseDay(today, now, 'Africa/Cairo')).toEqual(
      at(`${today}T00:00:00.000Z`),
    );
    expect(parseDay(addDays(today, 1), now, 'Africa/Cairo')).toBeNull();
  });

  it('the reasons a post closes and a claim is declined are one list in three places: the service, the dashboards and the CHECK', () => {
    expect(REASON_CODES.neighbourPostClose).toEqual([
      'resolved',
      'no_longer_needed',
    ]);
    expect(REASON_CODES.neighbourPostRemove).toEqual([
      'inappropriate',
      'duplicate',
      'not_allowed',
    ]);
    expect(REASON_CODES.neighbourPostSystemClose).toEqual([
      'handed_over',
      'author_left',
      'author_erased',
    ]);
    expect(migration).toContain(
      `"close_reason" IN (${quoted([
        ...REASON_CODES.neighbourPostClose,
        ...REASON_CODES.neighbourPostRemove,
        ...REASON_CODES.neighbourPostSystemClose,
      ])})`,
    );
    expect(REASON_CODES.neighbourClaimDecline).toEqual([
      'not_the_owner',
      'insufficient_proof',
    ]);
    expect(migration).toContain(
      `"decline_reason" IN (${quoted([
        ...REASON_CODES.neighbourClaimDecline,
        ...REASON_CODES.neighbourClaimSystemDecline,
      ])})`,
    );
    for (const list of [
      'neighbourPostRemove',
      'neighbourClaimDecline',
    ] as const)
      expect(dashboards).toContain(`${list}: [${quoted(REASON_CODES[list])}]`);
  });
});

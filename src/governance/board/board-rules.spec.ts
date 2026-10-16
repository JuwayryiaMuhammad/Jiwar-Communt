import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import { checkAppointment } from './board.service';
import { doubledOffice, termStatus } from './board-rules';

const read = (path: string) =>
  readFileSync(join(__dirname, '../../..', path), 'utf8');
const board = read(
  'prisma/migrations/20261029090100_board/migration.sql',
).replace(/\s+/g, ' ');
const mirror = read('packages/api/src/reasons.ts');
const quoted = (list: readonly string[]) =>
  list.map((c) => `'${c}'`).join(', ');

describe('the board’s lists (ADR 0051)', () => {
  it('a seat’s end reasons are the manager’s and the system’s, in its CHECK and the mirror', () => {
    expect(board).toContain(
      `IN (${quoted([
        ...REASON_CODES.boardMemberEnd,
        ...REASON_CODES.boardMemberSystemEnd,
      ])})`,
    );
    for (const list of ['boardMemberEnd', 'boardMemberSystemEnd'] as const)
      expect(mirror).toContain(`${list}: [${quoted(REASON_CODES[list])}]`);
  });
});

describe('the board’s rules (ADR 0051)', () => {
  const at = new Date('2026-11-01T10:00:00Z');

  it('a term is current until its end, then lapsed; ended once a board took over', () => {
    const endsAt = new Date('2027-11-01T10:00:00Z');
    expect(termStatus({ endedAt: null, endsAt }, at)).toBe('current');
    expect(termStatus({ endedAt: null, endsAt }, endsAt)).toBe('lapsed');
    expect(termStatus({ endedAt: at, endsAt }, at)).toBe('ended');
  });

  it('one chair, one secretary, one treasurer; members as many as seats', () => {
    expect(doubledOffice(['chair', 'member', 'member', 'secretary'])).toBe(
      null,
    );
    expect(doubledOffice(['chair', 'treasurer', 'treasurer'])).toBe(
      'treasurer',
    );
  });

  it('an appointment of 3 to `seats` members, each once', () => {
    const m = (accountId: string, role: 'chair' | 'member' = 'member') => ({
      accountId,
      role,
    });
    const endsAt = new Date('2027-11-01T10:00:00Z');
    expect(
      checkAppointment({ seats: 5, endsAt, members: [m('a'), m('b'), m('c')] }),
    ).toEqual([]);
    expect(
      checkAppointment({ seats: 2, endsAt, members: [m('a'), m('b')] }).map(
        (f) => [f.field, f.code],
      ),
    ).toEqual([
      ['seats', 'BOARD_SIZE'],
      ['members', 'BOARD_SIZE'],
    ]);
    expect(
      checkAppointment({
        seats: 3,
        endsAt,
        members: [m('a'), m('b'), m('c'), m('d')],
      }).map((f) => f.field),
    ).toEqual(['members']);
    expect(
      checkAppointment({
        seats: 3,
        endsAt,
        members: [m('a', 'chair'), m('b', 'chair'), m('a')],
      }).map((f) => [f.field, f.code]),
    ).toEqual([
      ['members.2.accountId', 'DUPLICATE_VALUE'],
      ['members', 'DUPLICATE_VALUE'],
    ]);
  });
});

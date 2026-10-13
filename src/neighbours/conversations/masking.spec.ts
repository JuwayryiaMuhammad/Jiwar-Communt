import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import {
  agreed,
  masked,
  namesRevealed,
  otherOf,
  otherSide,
  sideOf,
} from './masking';

const AT = new Date('2026-10-20T10:00:00.000Z');
const parties = { authorId: 'a', responderId: 'r' };
const other = {
  building: 'B2',
  fullName: 'Mona Adel Hassan',
  status: 'active',
};
const repo = join(__dirname, '../../..');
const migration = readFileSync(
  join(
    repo,
    'prisma/migrations/20261020090400_neighbour_conversations/migration.sql',
  ),
  'utf8',
).replace(/\s+/g, ' ');
const dashboards = readFileSync(
  join(repo, 'packages/api/src/reasons.ts'),
  'utf8',
);
const quoted = (codes: readonly string[]) =>
  codes.map((c) => `'${c}'`).join(', ');

describe('masking (ADR 0042)', () => {
  it('a conversation has two sides and nobody else is on one', () => {
    expect(sideOf(parties, 'a')).toBe('author');
    expect(sideOf(parties, 'r')).toBe('responder');
    expect(sideOf(parties, 'x')).toBeNull();
    expect(otherSide('author')).toBe('responder');
    expect(otherOf(parties, 'author')).toBe('r');
    expect(otherOf(parties, 'responder')).toBe('a');
  });

  it('names show only when BOTH agreed', () => {
    const none = { authorRevealAt: null, responderRevealAt: null };
    const one = { authorRevealAt: AT, responderRevealAt: null };
    const theOther = { authorRevealAt: null, responderRevealAt: AT };
    const both = { authorRevealAt: AT, responderRevealAt: AT };
    expect([none, one, theOther, both].map(namesRevealed)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(agreed(one, 'author')).toBe(true);
    expect(agreed(one, 'responder')).toBe(false);
    for (const c of [none, one, theOther])
      expect(masked(c, other)).toEqual({ building: 'B2', firstName: null });
    expect(masked(both, other)).toEqual({ building: 'B2', firstName: 'Mona' });
  });

  it('what is shown is a building and a first name: never the rest of the name', () => {
    const both = { authorRevealAt: AT, responderRevealAt: AT };
    const shown = masked(both, other);
    expect(Object.keys(shown).sort()).toEqual(['building', 'firstName']);
    expect(JSON.stringify(shown)).not.toContain('Adel');
    expect(JSON.stringify(shown)).not.toContain('Hassan');
  });

  it('a unit that names no building shows none, and an erased account no name', () => {
    const both = { authorRevealAt: AT, responderRevealAt: AT };
    expect(masked(both, { ...other, building: null })).toEqual({
      building: null,
      firstName: 'Mona',
    });
    expect(
      masked(both, { building: 'B2', fullName: null, status: 'erased' }),
    ).toEqual({ building: 'B2', firstName: null });
  });

  it('the reasons to report, the outcomes and the ends are one list in the service, the dashboards and the CHECKs', () => {
    expect(REASON_CODES.neighbourConversationReport).toEqual([
      'harassment',
      'spam',
      'scam',
      'inappropriate',
      'other',
    ]);
    expect(migration).toContain(
      `"reason_code" IN (${quoted(REASON_CODES.neighbourConversationReport)})`,
    );
    expect(REASON_CODES.neighbourReportOutcome).toEqual([
      'no_action',
      'warned',
      'post_removed',
    ]);
    expect(migration).toContain(
      `"outcome" IN (${quoted(REASON_CODES.neighbourReportOutcome)})`,
    );
    expect(dashboards).toContain(
      `neighbourReportOutcome: [${quoted(REASON_CODES.neighbourReportOutcome)}]`,
    );
    expect(migration).toContain(
      `"close_reason" IN (${quoted(REASON_CODES.neighbourConversationSystemClose)})`,
    );
  });
});

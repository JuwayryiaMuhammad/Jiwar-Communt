import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APPROVAL_TYPES } from '../core/board-matters/board-matters';
import { REASON_CODES } from '../core/common/reasons';
import { SETTING_TYPES } from './approvals/approval-rules';
import {
  HANDOVER_LIMITS,
  HANDOVER_STATUSES,
} from './handovers/handovers.service';
import {
  ACTION_STATUSES,
  AGENDA_ITEM_KINDS,
  MEETING_KINDS,
  MEETING_LIMITS,
  MEETING_STATUSES,
  quorumOf,
} from './meetings/meeting-rules';
import {
  POLL_WEIGHTINGS,
  scaledWeight,
  UNIT_SHARE_LIMITS,
  unscaledWeight,
} from './polls/poll-rules';

const migration = (name: string) =>
  readFileSync(
    join(__dirname, `../../prisma/migrations/${name}/migration.sql`),
    'utf8',
  ).replace(/\s+/g, ' ');
const quoted = (list: readonly string[]) =>
  list.map((v) => `'${v}'`).join(', ');

describe('the board’s work: its lists are its CHECKs’ (ADR 0075)', () => {
  const weighted = migration('20270216090000_governance_weighted_polls');

  it('a poll’s weightings and a unit’s share', () => {
    expect(weighted).toContain(`"weighting" IN (${quoted(POLL_WEIGHTINGS)})`);
    expect(weighted).toContain(
      `"share" > ${UNIT_SHARE_LIMITS.min} AND "share" <= ${UNIT_SHARE_LIMITS.max}`,
    );
  });
});

describe('board meetings: their lists are their CHECKs’ (ADR 0075)', () => {
  const sql = migration('20270216090200_board_meetings');

  it('a meeting’s kinds, states and cancel codes', () => {
    expect(sql).toContain(`"kind" IN (${quoted(MEETING_KINDS)})`);
    expect(sql).toContain(`"status" IN (${quoted(MEETING_STATUSES)})`);
    expect(sql).toContain(
      `"cancel_reason" IN (${quoted(REASON_CODES.boardMeetingCancel)})`,
    );
    expect(sql).toContain(
      `char_length("title") BETWEEN 1 AND ${MEETING_LIMITS.title}`,
    );
  });

  it('an agenda item’s kinds and an action item’s states and codes', () => {
    expect(sql).toContain(`"kind" IN (${quoted(AGENDA_ITEM_KINDS)})`);
    expect(sql).toContain(
      `"position" BETWEEN 1 AND ${MEETING_LIMITS.agendaItems}`,
    );
    expect(sql).toContain(`"status" IN (${quoted(ACTION_STATUSES)})`);
    expect(sql).toContain(
      `"cancel_reason" IN (${quoted(REASON_CODES.boardActionCancel)})`,
    );
    expect(sql).toContain(
      `char_length("title") BETWEEN 1 AND ${MEETING_LIMITS.actionTitle}`,
    );
  });

  it('the quorum is more than half of the seats', () => {
    expect([1, 2, 3, 4, 5, 6].map(quorumOf)).toEqual([1, 2, 2, 3, 3, 4]);
  });
});

describe('handovers: their lists are their CHECKs’ (ADR 0075)', () => {
  const sql = migration('20270216090300_governance_handovers');

  it('the approval types and the settings, with the override (dated after ADR 0082’s widening)', () => {
    // ADR 0089 recreated both CHECKs later with `budget_transfer`, and
    // ADR 0086 last with `capital_plan`, the override kept: the latest
    // recreation holds every type.
    const types = migration('20270611090400_reports_checks');
    expect(types).toContain(`"type" IN (${quoted(APPROVAL_TYPES)})`);
    expect(types).toContain(`"type" IN (${quoted(SETTING_TYPES)})`);
  });

  it('a manager’s handover: its states and the notes’ length', () => {
    expect(sql).toContain(`"status" IN (${quoted(HANDOVER_STATUSES)})`);
    expect(sql).toContain(
      `char_length("notes") BETWEEN 1 AND ${HANDOVER_LIMITS.notes}`,
    );
  });
});

describe('weights as whole ten-thousandths (ADR 0075)', () => {
  it('scales four decimals exactly, and back', () => {
    expect(scaledWeight('12.5')).toBe(125_000);
    expect(scaledWeight('0.0001')).toBe(1);
    expect(scaledWeight('100.0000')).toBe(1_000_000);
    expect(scaledWeight(null)).toBe(0);
    expect(unscaledWeight(125_000)).toBe('12.5000');
    expect(unscaledWeight(1)).toBe('0.0001');
    expect(unscaledWeight(0)).toBe('0.0000');
    // 0.1 + 0.2 in floating point is not 0.3; in ten-thousandths it is.
    expect(unscaledWeight(scaledWeight('0.1') + scaledWeight('0.2'))).toBe(
      '0.3000',
    );
  });
});

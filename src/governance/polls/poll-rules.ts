import type { GovernancePollKind } from '@prisma/client';

export const POLL_LIMITS = {
  title: 200,
  body: 4000,
  optionLabel: 200,
  minOptions: 2,
  maxOptions: 10,
  quorum: { min: 1, max: 100 },
  threshold: { min: 50, max: 100 },
} as const;

/**
 * How a poll counts a unit (ADR 0075): one unit, one vote, or by the
 * unit's ownership share. The migration's CHECK repeats the list.
 */
export const POLL_WEIGHTINGS = ['unit', 'share'] as const;
export type PollWeighting = (typeof POLL_WEIGHTINGS)[number];

/** A unit's share: a percentage above 0, at most 100, four decimals. */
export const UNIT_SHARE_LIMITS = { min: 0, max: 100, decimals: 4 } as const;

/**
 * A weight (a decimal string with up to four decimals, as PostgreSQL
 * returns NUMERIC) as a whole number of ten-thousandths, so a weighted
 * tally is exact: a compound's total stays far below 2^53.
 */
export function scaledWeight(value: string | null | undefined): number {
  if (!value) return 0;
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 10_000 + Number(fraction.padEnd(4, '0').slice(0, 4));
}

/** Ten-thousandths back to a decimal string with four decimals. */
export function unscaledWeight(scaled: number): string {
  const whole = Math.floor(scaled / 10_000);
  return `${whole}.${String(scaled % 10_000).padStart(4, '0')}`;
}

/** A yes/no poll's options, in order. */
export const YES_NO = ['yes', 'no', 'abstain'] as const;

export type PollResult = 'passed' | 'failed' | 'no_quorum' | 'tied';

export interface Tally {
  kind: GovernancePollKind;
  /** Units in the electorate; on a poll weighted by share, their weight. */
  electorate: number;
  /** Units that voted; on a poll weighted by share, their weight. */
  turnout: number;
  quorumPct: number;
  thresholdPct: number;
  /** Votes (or their weight) per option, with its key on a yes/no poll. */
  options: { id: string; key: string | null; votes: number }[];
}

/**
 * A poll's result (ADR 0051), from its counts alone:
 *
 * - quorum: at least `quorumPct` of the electorate's units voted (an
 *   abstention counts towards it); an empty electorate never meets it;
 * - yes/no: `yes` reaches `thresholdPct` of yes + no, and beats no (a tie
 *   fails); abstentions are left out of the share;
 * - one of several: the option strictly first, with `thresholdPct` of the
 *   votes, wins; a tie at the top is `tied`.
 *
 * A poll weighted by share passes its weights (scaled to whole numbers)
 * for the units and the votes: the same rules, by share (ADR 0075).
 */
export function pollResult(t: Tally): {
  result: PollResult;
  winningOptionId: string | null;
} {
  if (t.electorate === 0 || t.turnout * 100 < t.quorumPct * t.electorate)
    return { result: 'no_quorum', winningOptionId: null };
  if (t.kind === 'yes_no') {
    const of = (key: string) =>
      t.options.find((o) => o.key === key)?.votes ?? 0;
    const yes = of('yes');
    const no = of('no');
    const passed = yes > no && yes * 100 >= t.thresholdPct * (yes + no);
    return { result: passed ? 'passed' : 'failed', winningOptionId: null };
  }
  const ranked = [...t.options].sort((a, b) => b.votes - a.votes);
  const [top, next] = ranked;
  if (!top || top.votes === 0)
    return { result: 'failed', winningOptionId: null };
  if (next && next.votes === top.votes)
    return { result: 'tied', winningOptionId: null };
  return top.votes * 100 >= t.thresholdPct * t.turnout
    ? { result: 'passed', winningOptionId: top.id }
    : { result: 'failed', winningOptionId: null };
}

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

/** A yes/no poll's options, in order. */
export const YES_NO = ['yes', 'no', 'abstain'] as const;

export type PollResult = 'passed' | 'failed' | 'no_quorum' | 'tied';

export interface Tally {
  kind: GovernancePollKind;
  electorate: number;
  /** Units that voted. */
  turnout: number;
  quorumPct: number;
  thresholdPct: number;
  /** Votes per option, with its key on a yes/no poll. */
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

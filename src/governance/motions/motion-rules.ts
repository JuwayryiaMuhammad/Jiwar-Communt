// ============================================================================
// How a motion of the board is counted (ADR 0055)
// ============================================================================
//
// Pure: the service reads the seats, the chair and the votes under its
// locks and asks these.
//
// - n is the motion's board's members seated now, less those recused from
//   it (an appeal's); only their votes count.
// - The quorum is a majority of them: ⌊n/2⌋ + 1 votes cast.
// - For more than against carries, against more than for fails; a tie is
//   the chair's vote, and fails with no chair or a chair who did not vote.
// - It closes by itself once the votes cast reach the quorum and the
//   result is the same whatever the remaining seats vote (every one for,
//   every one against: more votes for only ever help it carry).

export type Choice = 'for' | 'against';
export type CountResult = 'carried' | 'failed';

export interface Count {
  /** The seats that count: seated now, not recused. */
  seats: readonly string[];
  /** The chair's seat now, or null (may be recused: then not among `seats`). */
  chair: string | null;
  /** Votes by seat (votes of seats not in `seats` are ignored). */
  votes: ReadonlyMap<string, Choice>;
}

export interface Tally {
  n: number;
  quorum: number;
  cast: number;
  for: number;
  against: number;
}

export const quorumOf = (n: number) => Math.floor(n / 2) + 1;

export function tally(c: Count): Tally {
  let yes = 0;
  let no = 0;
  for (const seat of c.seats) {
    const v = c.votes.get(seat);
    if (v === 'for') yes++;
    else if (v === 'against') no++;
  }
  return {
    n: c.seats.length,
    quorum: quorumOf(c.seats.length),
    cast: yes + no,
    for: yes,
    against: no,
  };
}

/** The result of the votes as they stand, a tie to the chair's vote. */
export function resultOf(
  yes: number,
  no: number,
  chairVote: Choice | undefined,
): CountResult {
  if (yes > no) return 'carried';
  if (no > yes) return 'failed';
  return chairVote === 'for' ? 'carried' : 'failed';
}

/** The chair's vote, when the chair's seat counts. */
function chairVoteOf(c: Count): Choice | undefined {
  return c.chair && c.seats.includes(c.chair)
    ? c.votes.get(c.chair)
    : undefined;
}

/**
 * The result once nothing the remaining seats vote can change it and the
 * quorum is met; null while it may still change (or lacks the quorum).
 */
export function decided(c: Count): CountResult | null {
  const t = tally(c);
  if (t.cast < t.quorum) return null;
  const remaining = c.seats.filter((s) => !c.votes.has(s));
  const chairCounts = c.chair !== null && c.seats.includes(c.chair);
  const chairNow = chairVoteOf(c);
  const chairPending = chairCounts && chairNow === undefined;
  const r = remaining.length;
  const allFor = resultOf(
    t.for + r,
    t.against,
    chairPending ? 'for' : chairNow,
  );
  const allAgainst = resultOf(
    t.for,
    t.against + r,
    chairPending ? 'against' : chairNow,
  );
  return allFor === allAgainst ? allFor : null;
}

/**
 * The result of a close after the matter's deadline: the votes cast as
 * they stand, with the quorum; null without it.
 */
export function closedAsItStands(c: Count): CountResult | null {
  const t = tally(c);
  if (t.cast < t.quorum) return null;
  return resultOf(t.for, t.against, chairVoteOf(c));
}

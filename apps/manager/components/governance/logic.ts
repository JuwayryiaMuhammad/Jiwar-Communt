// The dashboard's side of governance (ADR 0051): pure helpers, tested.

export const ROLE_TEXT: Record<string, string> = {
  chair: 'Chair',
  secretary: 'Secretary',
  treasurer: 'Treasurer',
  member: 'Member',
};

export const RESULT_TEXT: Record<string, string> = {
  passed: 'Passed',
  failed: 'Not passed',
  no_quorum: 'No quorum',
  tied: 'Tied',
};

export const PHASE_TEXT: Record<string, string> = {
  upcoming: 'Nominations not open yet',
  nominating: 'Nominations open',
  nominations_closed: 'Nominations closed',
  voting: 'Voting',
  closed: 'To certify',
  certified: 'Certified',
  cancelled: 'Cancelled',
};

export const OUTCOME_TEXT: Record<string, string> = {
  elected: 'Elected',
  tied: 'Tied',
  not_elected: 'Not elected',
  ineligible: 'Owns no unit now: seat left vacant',
};

/** The words in English when written, else in Arabic. */
export function inEither(en: string | null | undefined, ar: string | null | undefined): string {
  return en || ar || '—';
}

/** An option as shown: a yes/no poll's by its key, a choice poll's by its label. */
export function optionText(o: { key: string | null; labelEn: string | null; labelAr: string | null }): string {
  if (o.key === 'yes') return 'Yes';
  if (o.key === 'no') return 'No';
  if (o.key === 'abstain') return 'Abstain';
  return inEither(o.labelEn, o.labelAr);
}

/** "12 of 40 units (30 %)", or the electorate alone before anyone voted. */
export function turnoutText(turnout: number | null, electorate: number | null): string {
  if (electorate === null) return 'Not open yet';
  if (turnout === null) return `${electorate} units`;
  const pct = electorate ? Math.round((turnout * 100) / electorate) : 0;
  return `${turnout} of ${electorate} units (${pct} %)`;
}

/** A vote's share of all votes, rounded to a tenth. */
export function share(votes: number, of: number): string {
  if (!of) return '0 %';
  return `${Math.round((votes * 1000) / of) / 10} %`;
}

/** What a board appointment's members say before it is sent: problems as words. */
export function appointmentProblems(seats: number, members: { accountId: string; role: string }[]): string[] {
  const out: string[] = [];
  if (seats < 3 || seats > 15) out.push('A board has 3 to 15 seats.');
  if (members.length < 3) out.push('Appoint at least 3 owners.');
  if (members.length > seats) out.push('More members than seats.');
  const ids = members.map((m) => m.accountId);
  if (new Set(ids).size !== ids.length) out.push('An owner is listed twice.');
  for (const office of ['chair', 'secretary', 'treasurer'])
    if (members.filter((m) => m.role === office).length > 1) out.push(`One ${office} at most.`);
  return out;
}

/** Whether a tie's choice fills exactly the seats left, from the tied. */
export function tieChoiceComplete(chosen: readonly string[], tied: readonly string[], remaining: number): boolean {
  return chosen.length === remaining && new Set(chosen).size === chosen.length && chosen.every((c) => tied.includes(c));
}

/** Seats a tie leaves: the election's seats less those elected outright. */
export function seatsLeft(seats: number, candidates: readonly { outcome: string | null }[]): number {
  return seats - candidates.filter((c) => c.outcome === 'elected').length;
}

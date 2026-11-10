// The dashboard's side of governance (ADR 0051): pure helpers, tested. The
// words come from the gov-codes catalog through the `t` a caller hands in.
import type { Locale, Translate } from '@jiwar/i18n/core';
import type codes from '../../messages/en/gov-codes.ts';

export type GovT = Translate<typeof codes>;

/** The groups of codes the gov-codes catalog names as `<group>.<code>`. */
export type CodeGroup =
  | 'role'
  | 'result'
  | 'phase'
  | 'outcome'
  | 'approvalType'
  | 'approvalStatus'
  | 'appealKind'
  | 'appealStatus'
  | 'effect'
  | 'motionOutcome'
  | 'motionStatus'
  | 'category'
  | 'repAction'
  | 'repStatus'
  | 'repEnd'
  | 'agendaStatus'
  | 'meetingKind'
  | 'agendaKind';

/** A code's words in its group; a code the catalog lacks shows as itself. */
export function codeText(t: GovT, group: CodeGroup, code: string | null | undefined): string {
  if (!code) return '—';
  const key = `${group}.${code}` as keyof typeof codes & string;
  const text = t(key);
  return text === key ? code : text;
}

/** The words in the page's language when written, else in the other. */
export function inLocale(locale: Locale, en: string | null | undefined, ar: string | null | undefined): string {
  return (locale === 'ar' ? ar || en : en || ar) || '—';
}

/** An option as shown: a yes/no poll's by its key, a choice poll's by its label. */
export function optionText(
  t: GovT,
  locale: Locale,
  o: { key: string | null; labelEn: string | null; labelAr: string | null },
): string {
  if (o.key === 'yes') return t('option.yes');
  if (o.key === 'no') return t('option.no');
  if (o.key === 'abstain') return t('option.abstain');
  return inLocale(locale, o.labelEn, o.labelAr);
}

/** "12 of 40 units (30 %)", or the electorate alone before anyone voted. */
export function turnoutText(t: GovT, turnout: number | null, electorate: number | null): string {
  if (electorate === null) return t('turnout.notOpen');
  if (turnout === null) return t('turnout.units', { electorate });
  const pct = electorate ? Math.round((turnout * 100) / electorate) : 0;
  return t('turnout.of', { turnout, electorate, pct });
}

/** A vote's share of all votes, rounded to a tenth. */
export function share(votes: number, of: number): string {
  if (!of) return '0 %';
  return `${Math.round((votes * 1000) / of) / 10} %`;
}

/** What a board appointment's members say before it is sent: problems as words. */
export function appointmentProblems(t: GovT, seats: number, members: { accountId: string; role: string }[]): string[] {
  const out: string[] = [];
  if (seats < 3 || seats > 15) out.push(t('problem.seats'));
  if (members.length < 3) out.push(t('problem.min'));
  if (members.length > seats) out.push(t('problem.tooMany'));
  const ids = members.map((m) => m.accountId);
  if (new Set(ids).size !== ids.length) out.push(t('problem.twice'));
  for (const office of ['chair', 'secretary', 'treasurer'])
    if (members.filter((m) => m.role === office).length > 1) out.push(t('problem.office', { office }));
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

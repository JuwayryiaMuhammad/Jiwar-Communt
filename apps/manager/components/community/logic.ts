/**
 * What the community screens decide without the network (ADR 0040): how an
 * audience reads, whether a text is ready in its languages, which actions a
 * state takes, how a poll's counts are shown. Plain TypeScript with no
 * imports, so the tests run it as is.
 */

export type Occupancy = 'everyone' | 'owners' | 'tenants';
export interface AudienceLike {
  buildings: string[] | null;
  occupancy: Occupancy;
}

const WHO: Record<Occupancy, string> = { everyone: 'Everyone', owners: 'Owners only', tenants: 'Tenants only' };

/** "Owners only · buildings A, B" or "Everyone · whole compound". */
export function audienceText(a: AudienceLike): string {
  const where = a.buildings?.length ? `building${a.buildings.length === 1 ? '' : 's'} ${a.buildings.join(', ')}` : 'whole compound';
  return `${WHO[a.occupancy]} · ${where}`;
}

/** What the API takes: no buildings picked means the whole compound. */
export function audienceBody(occupancy: Occupancy, buildings: readonly string[]): { occupancy: Occupancy; buildings?: string[] } {
  return buildings.length ? { occupancy, buildings: [...buildings] } : { occupancy };
}

/**
 * Whether texts written in two languages can be sent: each language is whole
 * or absent, and at least one is there. `fields` are the texts of one
 * language, e.g. its title and its body.
 */
export function languagesReady(en: readonly string[], ar: readonly string[]): boolean {
  const state = (texts: readonly string[]) => {
    const filled = texts.filter((t) => t.trim() !== '').length;
    return filled === 0 ? 'absent' : filled === texts.length ? 'whole' : 'broken';
  };
  const [e, a] = [state(en), state(ar)];
  return e !== 'broken' && a !== 'broken' && (e === 'whole' || a === 'whole');
}

/** A blank field is sent as null: "this language is not written". */
export const textOrNull = (value: string): string | null => value.trim() || null;

/** `datetime-local` holds local wall time; the API takes an instant. */
export const toIso = (local: string): string | null => (local ? new Date(local).toISOString() : null);

/** An instant as `datetime-local` wants it: local wall time, to the minute. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type AnnouncementStatus = 'draft' | 'scheduled' | 'published' | 'expired' | 'ended' | 'archived';

/** What an announcement takes in each state (the API decides the same). */
export function announcementActions(status: AnnouncementStatus): { edit: boolean; publish: boolean; audience: boolean; archive: boolean } {
  const ahead = status === 'draft' || status === 'scheduled';
  return { edit: status !== 'archived', publish: ahead, audience: ahead, archive: status !== 'archived' };
}

export type PollStatus = 'scheduled' | 'open' | 'closed' | 'cancelled';

/** What a poll takes in each state. Once open only its closing time changes. */
export function pollActions(status: PollStatus, finalized: boolean): { edit: boolean; reschedule: boolean; close: boolean; cancel: boolean } {
  return {
    edit: status === 'scheduled',
    reschedule: status === 'open',
    // Past its time and not swept yet: closing it now writes the counts.
    close: status === 'open' || (status === 'closed' && !finalized),
    cancel: status === 'scheduled' || status === 'open',
  };
}

export type ResultsHidden = 'not_open' | 'not_voted' | 'few_votes' | 'cancelled' | null;

/** Why a poll's counts are not shown, in words; null when they are. */
export function hiddenText(hidden: ResultsHidden): string | null {
  switch (hidden) {
    case 'few_votes':
      return 'Fewer than 5 votes so far. Counts are shown from the fifth unit on, so that no count can tell who chose what.';
    case 'not_open':
      return 'Voting has not opened yet.';
    case 'cancelled':
      return 'The poll was cancelled: its ballots were destroyed and nothing was counted.';
    case 'not_voted':
      return 'Shown once the unit has voted.';
    default:
      return null;
  }
}

/** A share as a whole percentage; 0 when there is nothing to share. */
export function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

export type SuggestionStatus = 'received' | 'under_review' | 'planned' | 'done' | 'declined';

const NEXT: Record<SuggestionStatus, SuggestionStatus[]> = {
  received: ['under_review', 'planned', 'done', 'declined'],
  under_review: ['planned', 'done', 'declined'],
  planned: ['done', 'declined'],
  done: [],
  declined: [],
};

/** The steps forward a suggestion may take; `done` and `declined` are final. */
export const nextStatuses = (status: SuggestionStatus): SuggestionStatus[] => NEXT[status];

/** Declining is answered: the resident is told why. */
export const needsResponse = (status: SuggestionStatus): boolean => status === 'declined';

/** A poll's options as the builder holds them: at least two, each with the labels the question's languages need. */
export function optionsReady(options: readonly { labelEn: string; labelAr: string }[], hasEn: boolean, hasAr: boolean): boolean {
  if (options.length < 2 || options.length > 10) return false;
  return options.every((o) => (o.labelEn.trim() !== '') === hasEn && (o.labelAr.trim() !== '') === hasAr);
}

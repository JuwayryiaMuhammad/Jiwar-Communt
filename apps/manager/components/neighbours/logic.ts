/**
 * What the neighbours screens decide without the network (ADR 0042): which
 * filters a view of the complaints inbox sends, which actions a complaint's
 * status allows, which thread may be written in, what the desk may do to a
 * post, what a handover sends, and the setup forms' own checks. Plain
 * TypeScript with no imports, so the tests run it as is. The API decides
 * again on every call.
 */

// ---------------------------------------------------------------------------
// Complaints: the inbox
// ---------------------------------------------------------------------------

export const VIEWS = ['open', 'submitted', 'under_review', 'notice_sent', 'mediation', 'closed', 'all'] as const;
export type View = (typeof VIEWS)[number];

export const VIEW_TEXT: Record<View, string> = {
  open: 'Open',
  submitted: 'Submitted',
  under_review: 'Under review',
  notice_sent: 'Notice sent',
  mediation: 'Mediation',
  closed: 'Closed',
  all: 'All',
};

export interface Picked {
  categoryId: string;
  /** The unit complained about, or '' for any. */
  targetUnitId: string;
  /** Who complained, or '' for anyone. */
  authorId: string;
}

export interface InboxFilters {
  status: 'submitted' | 'under_review' | 'notice_sent' | 'mediation' | '';
  open: 'true' | 'false' | '';
  categoryId: string;
  targetUnitId: string;
  authorId: string;
}

/**
 * The query of a view. "Open" is neither resolved nor dismissed, "Closed" is
 * only those; a status view asks for that one status; "All" asks for
 * nothing. The category, the unit and the author narrow any of them.
 */
export function filtersFor(view: View, picked: Picked): InboxFilters {
  const byStatus = view === 'submitted' || view === 'under_review' || view === 'notice_sent' || view === 'mediation';
  return {
    status: byStatus ? view : '',
    open: view === 'open' ? 'true' : view === 'closed' ? 'false' : '',
    categoryId: picked.categoryId,
    targetUnitId: picked.targetUnitId,
    authorId: picked.authorId,
  };
}

export function emptyText(view: View): string {
  switch (view) {
    case 'open':
      return 'No complaint is open';
    case 'submitted':
      return 'No complaint is waiting to be taken';
    case 'under_review':
      return 'No complaint is under review';
    case 'notice_sent':
      return 'No complaint is waiting on a unit’s answer';
    case 'mediation':
      return 'No complaint is in mediation';
    case 'closed':
      return 'No complaint was resolved or dismissed';
    default:
      return 'No complaint matches';
  }
}

// ---------------------------------------------------------------------------
// Complaints: one complaint
// ---------------------------------------------------------------------------

const OPEN_STATUSES = ['submitted', 'under_review', 'notice_sent', 'mediation'];

/** The backend's complaint-rules.ts ALLOWED_FROM, for the staff's actions. */
const ALLOWED_FROM = {
  review: ['submitted'],
  notice: ['under_review', 'mediation'],
  mediate: ['under_review', 'notice_sent'],
  resolve: ['under_review', 'notice_sent', 'mediation'],
  dismiss: OPEN_STATUSES,
  message: OPEN_STATUSES,
  target_message: OPEN_STATUSES,
} as const;

const allows = (action: keyof typeof ALLOWED_FROM, status: string) => (ALLOWED_FROM[action] as readonly string[]).includes(status);

/**
 * What staff may do to a complaint, for showing and hiding buttons. A
 * complaint has one notice: "Send notice" is offered only while there is
 * none, and the unit's thread opens with it, never before.
 */
export function actionsFor(status: string, hasNotice: boolean) {
  return {
    review: allows('review', status),
    notice: allows('notice', status) && !hasNotice,
    mediate: allows('mediate', status),
    resolve: allows('resolve', status),
    dismiss: allows('dismiss', status),
    /** A message to the complainant. */
    message: allows('message', status),
    /** A message to the unit complained about. */
    unitMessage: allows('target_message', status) && hasNotice,
    /** A staff note is possible on a closed complaint too. */
    note: true,
  };
}

export const THREADS = ['complainant', 'target', 'internal'] as const;
export type Thread = (typeof THREADS)[number];

/** Whether a thread takes a message now, and what to say when it does not. */
export function threadState(thread: Thread, status: string, hasNotice: boolean): { write: boolean; why: string | null } {
  const may = actionsFor(status, hasNotice);
  if (thread === 'internal') return { write: true, why: null };
  if (thread === 'complainant') {
    return may.message ? { write: true, why: null } : { write: false, why: 'The complaint is closed: nothing more is written to the complainant.' };
  }
  if (!hasNotice) {
    return {
      write: false,
      why: 'The unit has not been told anything yet. Its thread opens when the notice is sent.',
    };
  }
  return may.unitMessage ? { write: true, why: null } : { write: false, why: 'The complaint is closed: nothing more is written to the unit.' };
}

/** "B-4 · Building B", or the code alone. */
export function unitText(unit: { code: string; building?: string | null } | null | undefined): string {
  if (!unit) return '—';
  return unit.building ? `${unit.code} · ${unit.building}` : unit.code;
}

// ---------------------------------------------------------------------------
// The boards
// ---------------------------------------------------------------------------

export const BOARDS = ['lost_found', 'lending'] as const;
export type Board = (typeof BOARDS)[number];
export const POST_STATES = ['open', 'expired', 'closed'] as const;
export type PostState = (typeof POST_STATES)[number];

export const KIND_TEXT: Record<string, string> = {
  lost: 'Lost',
  found: 'Found',
  lend: 'Can lend',
  borrow: 'Wants to borrow',
};

export function boardEmptyText(board: Board, state: PostState): string {
  const what = board === 'lost_found' ? 'lost or found item' : 'lending post';
  if (state === 'open') return `No ${what} is on the board`;
  if (state === 'expired') return `No ${what} has passed its day`;
  return `No ${what} was closed`;
}

/**
 * What the desk may do to a post (the backend's post-rules.ts and the
 * claims service). Only a found item is held at the office: it alone is
 * claimed and handed over, and an item nobody came for in time may still
 * be. Any post that was not closed may be taken down. The lending board is
 * read and taken down from, nothing else.
 */
export function postActionsFor(post: { kind: string; state: string }) {
  const live = post.state !== 'closed';
  const found = post.kind === 'found';
  return {
    remove: live,
    /** Claims are listed, whatever became of them. */
    claims: found,
    decide: found && live,
    handOver: found && live,
  };
}

/** A post's first words, for a table row. */
export function excerpt(text: string | null | undefined, max = 80): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isAccountId = (value: string): boolean => UUID.test(value.trim());

export type HandoverTo = { claimId: string } | { accountId: string };

/**
 * What a handover sends: the claim, or the resident who came without one.
 * Never both (the API refuses the pair), and null while the account id is
 * not one.
 */
export function handoverBody(to: HandoverTo): { claimId: string } | { recipientAccountId: string } | null {
  if ('claimId' in to) return to.claimId ? { claimId: to.claimId } : null;
  const id = to.accountId.trim();
  return isAccountId(id) ? { recipientAccountId: id.toLowerCase() } : null;
}

/** A staff post: lost or found, a few words, and a day that is not in the future. */
export function postProblems(form: { body: string; place: string; occurredOn: string }, today: string): Record<string, string> {
  const problems: Record<string, string> = {};
  if (form.body.trim() === '') problems.body = 'Required.';
  else if (form.body.trim().length > 500) problems.body = 'At most 500 characters.';
  if (form.place.trim().length > 120) problems.place = 'At most 120 characters.';
  if (form.occurredOn !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.occurredOn)) problems.occurredOn = 'A day, as YYYY-MM-DD.';
    else if (form.occurredOn > today) problems.occurredOn = 'Not in the future.';
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Reported conversations
// ---------------------------------------------------------------------------

/**
 * A reported conversation is read only while its case is open. Closed, it is
 * sealed again: by its status, or by the API's own answer when someone else
 * closed it meanwhile. That answer is a state, not an error.
 */
export function isSealed(status: string, errorCode?: string | null): boolean {
  return status === 'closed' || errorCode === 'NEIGHBOUR_REPORT_CLOSED';
}

export const SEALED_TEXT = 'This case is closed. The conversation is sealed again.';

export const SIDE_TEXT: Record<string, string> = { author: 'Post author', responder: 'Responder' };

// ---------------------------------------------------------------------------
// Setup: limits
// ---------------------------------------------------------------------------

export const LIMIT_FIELDS = ['maxOpenComplaints', 'lostFoundExpiryDays', 'lendingExpiryDays', 'maxOpenPosts', 'maxNewConversationsPerDay'] as const;
export type LimitField = (typeof LIMIT_FIELDS)[number];

/** The backend's settings/defaults.ts ranges. */
export const LIMIT_RANGES: Record<LimitField, { min: number; max: number }> = {
  maxOpenComplaints: { min: 1, max: 50 },
  lostFoundExpiryDays: { min: 1, max: 180 },
  lendingExpiryDays: { min: 1, max: 90 },
  maxOpenPosts: { min: 1, max: 50 },
  maxNewConversationsPerDay: { min: 1, max: 100 },
};

export function validLimit(field: LimitField, value: string): boolean {
  if (!/^\d+$/.test(value.trim())) return false;
  const n = Number(value);
  return n >= LIMIT_RANGES[field].min && n <= LIMIT_RANGES[field].max;
}

/** Only what changed is sent. */
export function limitChanges(form: Record<LimitField, string>, saved: Record<LimitField, number>): Partial<Record<LimitField, number>> {
  const changes: Partial<Record<LimitField, number>> = {};
  for (const field of LIMIT_FIELDS) if (Number(form[field]) !== saved[field]) changes[field] = Number(form[field]);
  return changes;
}

// ---------------------------------------------------------------------------
// Setup: the welcome
// ---------------------------------------------------------------------------

export const WELCOME_TEXTS = ['rulesEn', 'officeHoursEn', 'emergencyEn', 'rulesAr', 'officeHoursAr', 'emergencyAr'] as const;
export type WelcomeText = (typeof WELCOME_TEXTS)[number];
export type WelcomeForm = Record<WelcomeText, string>;

/** The backend's WELCOME_FIELDS. */
export const WELCOME_MAX: Record<WelcomeText, number> = {
  rulesEn: 4000,
  officeHoursEn: 1000,
  emergencyEn: 1000,
  rulesAr: 4000,
  officeHoursAr: 1000,
  emergencyAr: 1000,
};

const LANGUAGES: Record<'En' | 'Ar', readonly WelcomeText[]> = {
  En: ['rulesEn', 'officeHoursEn', 'emergencyEn'],
  Ar: ['rulesAr', 'officeHoursAr', 'emergencyAr'],
};

export function toWelcomeForm(saved: Partial<Record<WelcomeText, string | null>>): WelcomeForm {
  return Object.fromEntries(WELCOME_TEXTS.map((k) => [k, saved[k] ?? ''])) as WelcomeForm;
}

/**
 * What is wrong with the six texts, by field: a language is filled in
 * completely or left empty, and each text has its length. Every text empty
 * is allowed: an empty welcome, which greets nobody.
 */
export function welcomeProblems(form: WelcomeForm): Partial<Record<WelcomeText, string>> {
  const problems: Partial<Record<WelcomeText, string>> = {};
  for (const fields of Object.values(LANGUAGES)) {
    const some = fields.some((k) => form[k].trim() !== '');
    for (const k of fields) {
      const text = form[k].trim();
      if (text.length > WELCOME_MAX[k]) problems[k] = `At most ${WELCOME_MAX[k]} characters.`;
      else if (some && text === '') problems[k] = 'Required: a language is filled in completely or left empty.';
    }
  }
  return problems;
}

export const welcomeHasText = (form: WelcomeForm): boolean => WELCOME_TEXTS.some((k) => form[k].trim() !== '');

/** The six texts as the API takes them: trimmed, and null for an empty one. */
export function welcomeBody(form: WelcomeForm): Record<WelcomeText, string | null> {
  return Object.fromEntries(WELCOME_TEXTS.map((k) => [k, form[k].trim() || null])) as Record<WelcomeText, string | null>;
}

/** What "Clear" sends: every text null. */
export const CLEARED_WELCOME: Record<WelcomeText, null> = {
  rulesEn: null,
  officeHoursEn: null,
  emergencyEn: null,
  rulesAr: null,
  officeHoursAr: null,
  emergencyAr: null,
};

export function sameWelcome(form: WelcomeForm, saved: Partial<Record<WelcomeText, string | null>>): boolean {
  return WELCOME_TEXTS.every((k) => (form[k].trim() || null) === (saved[k] ?? null));
}

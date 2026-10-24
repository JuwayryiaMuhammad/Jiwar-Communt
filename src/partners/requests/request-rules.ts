// ============================================================================
// A request's rules (ADR 0060)
// ============================================================================
//
// One table of who may move a request from which status, and when, read by
// every writer under the request's row lock on the database's clock. Pure:
// the services, the sweeps and the unit spec say the same.

export const PARTNER_REQUEST_STATUSES = [
  'pending',
  'proposed',
  'accepted',
  'declined',
  'cancelled',
  'expired',
  'done',
  'partner_no_show',
  'lapsed',
] as const;
export type PartnerRequestStatus = (typeof PARTNER_REQUEST_STATUSES)[number];

/** Open: the partner may still act, the resident may still cancel. */
export const LIVE: readonly PartnerRequestStatus[] = [
  'pending',
  'proposed',
  'accepted',
];

export type RequestAction =
  | 'accept'
  | 'decline'
  | 'propose'
  | 'accept_proposal'
  | 'decline_proposal'
  | 'resident_cancel'
  | 'partner_cancel'
  | 'resident_done'
  | 'partner_done'
  | 'no_show'
  | 'expire'
  | 'lapse'
  | 'system_cancel';

/** The status each action leaves the request in. */
export const RESULT: Record<RequestAction, PartnerRequestStatus> = {
  accept: 'accepted',
  decline: 'declined',
  propose: 'proposed',
  accept_proposal: 'accepted',
  decline_proposal: 'cancelled',
  resident_cancel: 'cancelled',
  partner_cancel: 'cancelled',
  resident_done: 'done',
  partner_done: 'done',
  no_show: 'partner_no_show',
  expire: 'expired',
  lapse: 'lapsed',
  system_cancel: 'cancelled',
};

const FROM: Record<RequestAction, readonly PartnerRequestStatus[]> = {
  accept: ['pending'],
  decline: ['pending', 'proposed'],
  propose: ['pending'],
  accept_proposal: ['proposed'],
  decline_proposal: ['proposed'],
  resident_cancel: ['pending', 'proposed', 'accepted'],
  partner_cancel: ['accepted'],
  resident_done: ['accepted'],
  partner_done: ['accepted'],
  no_show: ['accepted'],
  expire: ['pending', 'proposed'],
  lapse: ['accepted'],
  // The partner suspended, the requester gone (ADR 0060).
  system_cancel: ['pending', 'proposed', 'accepted'],
};

/** An accepted request nobody closed lapses this long after its window. */
export const LAPSE_AFTER_MS = 7 * 86_400_000;

/** What the rules read of a request. */
export interface RequestTimes {
  status: PartnerRequestStatus;
  askedStartsAt: Date;
  proposedStartsAt: Date | null;
  agreedStartsAt: Date | null;
  agreedEndsAt: Date | null;
}

export type Verdict =
  | { ok: true }
  | { ok: false; reason: 'status' | 'window_passed' | 'too_early' };

/**
 * When the request's window starts for an action on a request not yet
 * accepted: the window proposed while one is, else the one asked.
 */
export const startOf = (r: RequestTimes): Date =>
  r.status === 'proposed' && r.proposedStartsAt
    ? r.proposedStartsAt
    : r.askedStartsAt;

/**
 * Whether `action` may move the request now:
 * - the partner accepts or proposes before the window asked starts;
 * - the resident accepts a proposal before the proposed window starts;
 * - the partner cancels an accepted request before its window ends;
 * - either side marks done once the window started;
 * - the resident says the partner did not come once the window ended;
 * - the system expires a request nobody accepted once its window started,
 *   and lapses an accepted one a week after its window ended.
 * A decline and the resident's cancel are taken any time from their
 * statuses.
 */
export function decide(
  action: RequestAction,
  r: RequestTimes,
  now: Date,
): Verdict {
  if (!FROM[action].includes(r.status)) return { ok: false, reason: 'status' };
  const t = now.getTime();
  switch (action) {
    case 'accept':
    case 'propose':
    case 'accept_proposal':
      return t < startOf(r).getTime()
        ? { ok: true }
        : { ok: false, reason: 'window_passed' };
    case 'partner_cancel':
      return t < r.agreedEndsAt!.getTime()
        ? { ok: true }
        : { ok: false, reason: 'window_passed' };
    case 'resident_done':
    case 'partner_done':
      return t >= r.agreedStartsAt!.getTime()
        ? { ok: true }
        : { ok: false, reason: 'too_early' };
    case 'no_show':
      return t >= r.agreedEndsAt!.getTime()
        ? { ok: true }
        : { ok: false, reason: 'too_early' };
    case 'expire':
      return t >= startOf(r).getTime()
        ? { ok: true }
        : { ok: false, reason: 'too_early' };
    case 'lapse':
      return t >= r.agreedEndsAt!.getTime() + LAPSE_AFTER_MS
        ? { ok: true }
        : { ok: false, reason: 'too_early' };
    default:
      return { ok: true };
  }
}

/** A window a resident asks or a partner proposes. */
export const WINDOW = {
  /** It starts at least this many minutes from now. */
  minLeadMinutes: 15,
  /** It starts within this many days. */
  maxDaysAhead: 14,
  minMinutes: 30,
  maxMinutes: 480,
} as const;

export type WindowProblem =
  | { field: 'start'; problem: 'too_soon' | 'too_far' }
  | { field: 'end'; problem: 'length' };

/** What is wrong with a window asked or proposed now. */
export function windowProblems(
  startsAt: Date,
  endsAt: Date,
  now: Date,
): WindowProblem[] {
  const problems: WindowProblem[] = [];
  const lead = startsAt.getTime() - now.getTime();
  if (lead < WINDOW.minLeadMinutes * 60_000)
    problems.push({ field: 'start', problem: 'too_soon' });
  else if (lead > WINDOW.maxDaysAhead * 86_400_000)
    problems.push({ field: 'start', problem: 'too_far' });
  const minutes = (endsAt.getTime() - startsAt.getTime()) / 60_000;
  if (minutes < WINDOW.minMinutes || minutes > WINDOW.maxMinutes)
    problems.push({ field: 'end', problem: 'length' });
  return problems;
}

/** `SR-000123`: how a request's number is shown. */
export const requestNumber = (n: number): string =>
  `SR-${String(n).padStart(6, '0')}`;

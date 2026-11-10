/**
 * The inbox stores a kind and its params, never text (ADR 0027): the words
 * of each kind of the backend catalog (src/core/notifications/kinds.ts) are
 * in the notify-kinds catalogs, filled here in the reader's language. An
 * unknown kind still reads as something. No React and no `@/` alias, so the
 * tests run it with node as is.
 */
import { createFormat, formatMessage, intlLocale, type Locale } from '@jiwar/i18n/core';
import codesAr from '../../../packages/ui/src/messages/ar/codes.ts';
import codesEn from '../../../packages/ui/src/messages/en/codes.ts';
import kindsAr from '../messages/ar/notify-kinds.ts';
import wordsAr from '../messages/ar/notify-words.ts';
import kindsEn from '../messages/en/notify-kinds.ts';
import wordsEn from '../messages/en/notify-words.ts';

export interface NotificationLike {
  kind: string;
  params: Record<string, string | number>;
  targetType: string | null;
  targetId: string | null;
}

type P = NotificationLike['params'];
type Words = Readonly<Record<string, string>>;

const KINDS: Record<Locale, Words> = { en: kindsEn, ar: kindsAr };
const WORDS: Record<Locale, Words> = { en: wordsEn, ar: wordsAr };
const CODES: Record<Locale, Words> = { en: codesEn, ar: codesAr };

/** Params that carry a code: they reach the sentence in words (`{reason}`, `{aReason}`, `{aReasonCap}`). */
const CODE_PARAMS = [
  'requestKind',
  'reason',
  'action',
  'categoryKey',
  'category',
  'emergencyType',
  'serviceKind',
  'kind',
  'type',
  'permitKind',
  'result',
  'helpKind',
  'certificateKind',
  'taskKind',
  'eventKind',
  'severity',
  'incidentType',
  'violationKind',
  'priority',
  'status',
  'holdReason',
  'clock',
  'carrier',
  'topicKey',
  'complianceKind',
  'hazard',
  'signal',
  'caseKind',
  'compensationKind',
] as const;
/** Codes a sentence selects on: kept as codes, their words as `{decisionLabel}`… */
const SELECTED_CODES = ['decision', 'outcome', 'source'] as const;
/** Instants, shown as "10 Oct, 15:55". */
const INSTANTS = ['at', 'expiresAt', 'effectiveAt', 'bidsDueAt'] as const;
/** Params a sentence may lack: `hasUnitCode` and the like say whether they came. */
const OPTIONAL = ['unitCode', 'holdReason', 'workerName', 'at', 'expiresAt', 'until', 'area'] as const;

const DATE_TIME: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' };

function humanize(value: string): string {
  return value.replace(/[._]/g, ' ');
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A code in words, inside a sentence: the shared code words, lower-cased in
 * English ("water leak"); an unknown code humanized.
 */
function codeWords(value: string | number, locale: Locale): string {
  const code = String(value);
  const shared = Object.prototype.hasOwnProperty.call(CODES[locale], code) ? CODES[locale][code] : undefined;
  if (!shared) return humanize(code);
  // An acronym ("SOS", "CCTV") keeps its capitals.
  return locale === 'en' && !/^[A-Z]{2}/.test(shared) ? shared.charAt(0).toLowerCase() + shared.slice(1) : shared;
}

/** "a major contract", "an annual budget"; Arabic has no indefinite article. */
function withArticle(words: string, locale: Locale): string {
  if (locale !== 'en') return words;
  return `${/^[aeiou]/i.test(words) ? 'an' : 'a'} ${words}`;
}

function word(locale: Locale, group: string, value: string | number | undefined): string {
  const words = WORDS[locale];
  const key = `${group}.${String(value)}`;
  return Object.prototype.hasOwnProperty.call(words, key) ? words[key]! : words[`${group}.other`]!;
}

function valid(value: string | number | undefined): Date | null {
  if (value === undefined) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The params as the catalogs read them (see messages/en/notify-kinds.ts). */
function messageParams(p: P, locale: Locale): Record<string, string> {
  const fmt = createFormat(locale);
  const out: Record<string, string> = {};
  // Numbers as the API sent them: a parcel's number is not grouped; a count
  // in a plural is formatted by the message itself.
  for (const [name, value] of Object.entries(p)) out[name] = String(value);
  for (const name of CODE_PARAMS) {
    const value = p[name];
    if (value === undefined || value === '') continue;
    const words = codeWords(value, locale);
    const a = withArticle(words, locale);
    out[name] = words;
    out[`a${cap(name)}`] = a;
    out[`a${cap(name)}Cap`] = cap(a);
  }
  for (const name of SELECTED_CODES) {
    const value = p[name];
    if (value !== undefined && value !== '') out[`${name}Label`] = codeWords(value, locale);
  }
  for (const name of INSTANTS) {
    const d = valid(p[name]);
    out[name] = d ? fmt.custom(d, DATE_TIME) : '';
  }
  // A visit's window: "12 Oct, 10:00–12:00".
  const start = valid(p.startsAt);
  const end = valid(p.endsAt);
  out.window = start ? `${fmt.custom(start, DATE_TIME)}${end ? `–${fmt.time(end)}` : ''}` : '';
  out.blockers = new Intl.ListFormat(intlLocale(locale), { type: 'unit', style: 'short' }).format(
    String(p.blockers ?? '')
      .split(',')
      .filter(Boolean)
      .map((code) => codeWords(code, locale)),
  );
  out.device = word(locale, 'device', p.deviceType);
  out.post = word(locale, 'post', p.postKind);
  out.exception = word(locale, 'exception', p.exceptionKind);
  for (const name of OPTIONAL) out[`has${cap(name)}`] = out[name] ? 'yes' : 'no';
  return out;
}

/**
 * A notification's sentence in the reader's language. The locale defaults to
 * English for the callers not yet converted.
 */
export function notificationText(n: NotificationLike, locale: Locale = 'en'): string {
  const template = Object.prototype.hasOwnProperty.call(KINDS[locale], n.kind) ? KINDS[locale][n.kind] : undefined;
  if (!template) return cap(humanize(n.kind));
  return formatMessage(locale, template, messageParams(n.params, locale));
}

/**
 * Where a notification leads in this dashboard, or null. `can` is the
 * reader's permissions: a link is offered only where the page would open.
 */
export function notificationHref(n: NotificationLike, can: (permission: string) => boolean): string | null {
  // A part request is the store's to answer, on its queue (ADR 0065).
  if (n.kind === 'part_request.created') return can('stock.manage') ? '/stock/part-requests' : null;
  if (n.targetType === 'ticket' && n.targetId) return can('tickets.dispatch') ? `/maintenance/${n.targetId}` : null;
  // The asset register (ADR 0064).
  if (n.targetType === 'asset' && n.targetId) return can('assets.read') ? `/assets/${n.targetId}` : null;
  // Maintenance analytics and cases (ADR 0081).
  if (n.targetType === 'maintenance_case' && n.targetId) return can('tickets.dispatch') ? `/cases/${n.targetId}` : null;
  if (n.targetType === 'plan_suggestion') return can('assets.manage') ? '/recurrence' : null;
  if (n.targetType === 'stock_item' && n.targetId) return can('stock.manage') ? `/stock/${n.targetId}` : null;
  if (n.targetType === 'maintenance_contract' && n.targetId) return can('assets.manage') ? `/contracts/${n.targetId}` : null;
  // Vendors and purchase requests (ADR 0077).
  if (n.targetType === 'vendor' && n.targetId) return can('vendors.manage') ? `/vendors/${n.targetId}` : null;
  if (n.targetType === 'purchase_request' && n.targetId)
    return can('purchases.approve') || can('purchases.request') ? `/purchases/${n.targetId}` : null;
  // Compliance (ADR 0087).
  if (n.targetType === 'compliance_item' && n.targetId) return can('compliance.manage') ? `/compliance/${n.targetId}` : null;
  // Tenders (ADR 0088); a vendor's offer is the contractor's app's.
  if (n.targetType === 'tender' && n.targetId)
    return can('tenders.manage') || can('tenders.open') ? `/tenders/${n.targetId}` : null;
  // Payables (ADR 0089).
  if (n.targetType === 'vendor_invoice' && n.targetId)
    return can('finance.payables') || can('finance.payables_approve') ? `/finance/payables/${n.targetId}` : null;
  if (n.targetType === 'contract_disbursement' || n.targetType === 'vendor_guarantee')
    return can('finance.payables') || can('finance.payables_approve') ? '/finance/payables/contracts' : null;
  // The general ledger (ADR 0092).
  if (n.targetType === 'gl_manual_entry') return can('finance.ledger_write') ? '/finance/gl/entries' : null;
  // Energy (ADR 0066).
  if (n.targetType === 'meter' && n.targetId) return can('energy.read') ? `/meters/${n.targetId}` : null;
  // Readiness (ADR 0067): the program, for who keeps readiness.
  if (n.targetType === 'readiness_program' && n.targetId) return can('readiness.manage') ? `/readiness/${n.targetId}` : null;
  // Money and the unit (ADR 0069): the finance staff's queues.
  if (n.targetType === 'plan_request') return can('finance.invoice') ? '/finance/plan-requests' : null;
  if (n.targetType === 'collector_visit') return can('finance.payments') ? '/finance/collector-visits' : null;
  // Community (ADR 0071): the market's review, and the gallery.
  if (n.targetType === 'market_listing') return can('market.handle') ? '/market' : null;
  if (n.targetType === 'gallery_photo') return can('content.manage') ? '/daily-life' : null;
  // The staff inbox and deputies (ADR 0073).
  if (n.targetType === 'inbox_item') return can('inbox.read') ? '/inbox' : null;
  if (n.targetType === 'account_deputy') return '/deputies';
  // The operations dashboard (ADR 0079).
  if (n.targetType === 'staff_brief') return can('dashboard.read') ? '/briefs' : null;
  if (n.targetType === 'service_pressure') return can('tickets.dispatch') ? '/maintenance' : null;
  // Experience and recovery (ADR 0082).
  if (n.targetType === 'experience_case' && n.targetId)
    return can('experience.manage') ? `/experience/cases/${n.targetId}` : null;
  if (n.targetType === 'experience_compensation')
    return can('experience.compensate') ? '/experience/compensations' : null;
  // The reports platform (ADR 0086): the run's file, the compound's export.
  if (n.targetType === 'report_run') return '/reports/runs';
  if (n.targetType === 'compound_export') return can('compound.export') ? '/compound-export' : null;
  // Cash flow (ADR 0091).
  if (n.targetType === 'cash_flow') return can('finance.cashflow') ? '/finance/cash-flow' : null;
  if (n.targetType === 'maintenance_plan' && n.targetId) return can('assets.read') ? `/maintenance-plans/${n.targetId}` : null;
  if (n.targetType === 'inspection' && n.targetId) return can('inspections.manage') ? `/inspections/${n.targetId}` : null;
  if (n.targetType === 'asset_replacement_recommendation') return can('assets.manage') ? '/replacement-recommendations' : null;
  if (n.targetType === 'parcel' && n.targetId) return can('parcels.manage') ? `/parcels?parcel=${n.targetId}` : null;
  if (n.targetType === 'management_request' && n.targetId)
    return can('requests.handle') ? `/management-requests/${n.targetId}` : null;
  if (n.targetType === 'community_announcement' && n.targetId)
    return can('community.publish') ? `/announcements/${n.targetId}` : null;
  if (n.targetType === 'community_event' && n.targetId) return can('community.publish') ? `/events/${n.targetId}` : null;
  if (n.targetType === 'community_suggestion' && n.targetId)
    return can('community.suggestions') ? `/suggestions/${n.targetId}` : null;
  // Neighbours (ADR 0042). A notice, a conversation and the welcome are the
  // residents' own: nothing in this dashboard opens them.
  if (n.targetType === 'neighbour_complaint' && n.targetId) return can('neighbours.handle') ? `/complaints/${n.targetId}` : null;
  if (n.targetType === 'neighbour_post' && n.targetId) return can('neighbours.handle') ? `/lost-found/${n.targetId}` : null;
  if (n.targetType === 'neighbour_report' && n.targetId)
    return can('neighbours.handle') ? `/conversation-reports/${n.targetId}` : null;
  if (n.targetType === 'emergency')
    return can('emergencies.manage') || can('emergencies.respond') ? '/emergencies' : null;
  if (n.targetType === 'gate_service_request') return can('gate_services.handle') ? '/gate-services' : null;
  if (n.targetType === 'unit_permit' && n.targetId) return can('permits.manage') ? `/permits/${n.targetId}` : null;
  // Partners (ADR 0060): a request to relay, to its page for whoever keeps the partners.
  if (n.targetType === 'partner_request' && n.targetId)
    return can('partners.manage') ? `/partners/requests/${n.targetId}` : null;
  if (n.targetType === 'partner_complaint' && n.targetId)
    return can('partners.manage') ? `/partners/complaints/${n.targetId}` : null;
  if (n.targetType === 'partner' && n.targetId) return can('partners.manage') ? `/partners/${n.targetId}` : null;
  // Decision appeals (ADR 0059): to the appeal, for whoever decides them.
  if (n.targetType === 'decision_appeal' && n.targetId)
    return can('appeals.decide') ? `/appeals/${n.targetId}` : null;
  // Guard shifts and tasks (ADR 0050): the keepers' pages. A task, an
  // instruction or a swap to answer is a guard's, in the app.
  // The field team (ADR 0078): a technician's slot, call or instruction.
  if (n.kind === 'technician_shift.absent' || n.kind.startsWith('technician_instruction.'))
    return can('field_team.manage') ? '/field-team' : null;
  if (n.targetType === 'technician_help_request') return can('field_team.manage') ? '/field-team' : null;
  // ADR 0090: a certificate, a reinforcement; a dangling account, a review.
  if (n.targetType === 'staff_certificate') return can('field_team.manage') ? '/field-team?tab=certificates' : null;
  if (n.targetType === 'reinforcement_suggestion' || n.targetType === 'reinforcement_call')
    return can('field_team.manage') ? '/field-team?tab=reinforcement' : null;
  if (n.targetType === 'dangling_account' || n.targetType === 'access_review')
    return can('accounts.manage') ? '/access-checks' : null;
  if (n.targetType === 'guard_roster_slot') return can('guard_roster.manage') ? '/security/roster' : null;
  if (n.targetType === 'guard_shift_swap') return can('guard_roster.manage') ? '/security/swaps' : null;
  if (n.targetType === 'guard_task') return can('guard_tasks.manage') ? '/security/tasks' : null;
  if (n.targetType === 'guard_instruction') return can('guard_instructions.manage') ? '/security/instructions' : null;
  if (n.targetType === 'governance_election' && n.targetId)
    return can('governance.manage') ? `/governance/elections/${n.targetId}` : null;
  if (n.targetType === 'governance_poll' && n.targetId)
    return can('governance.manage') ? `/governance/polls/${n.targetId}` : null;
  // Board matters (ADR 0055): a member to the board's page, the management to its own.
  if (n.targetType === 'governance_approval' && n.targetId) {
    if (can('governance.board')) return `/board/approvals/${n.targetId}`;
    return can('governance.approvals') ? `/governance/approvals/${n.targetId}` : null;
  }
  if (n.targetType === 'board_motion') {
    if (!can('governance.board')) return null;
    if (n.params.matter === 'appeal') return '/board/appeals';
    return n.params.matter === 'representative' ? '/board/representatives' : '/board/approvals';
  }
  // The board's work (ADR 0075): a meeting, an action item's meeting, the handovers, the reports.
  if (n.targetType === 'board_meeting' && n.targetId)
    return can('governance.board') || can('governance.manage') ? `/board/meetings/${n.targetId}` : null;
  if (n.targetType === 'board_meeting_action')
    return can('governance.board') || can('governance.manage') ? '/board/meetings' : null;
  if (n.targetType === 'manager_handover') return can('governance.board') || can('governance.manage') ? '/board/handover' : null;
  if (n.targetType === 'board_report') return can('governance.board') || can('governance.manage') ? '/board/reports' : null;
  // The owners' voice (ADR 0059): a proposal or a decision's objections, to the board's page.
  if (n.targetType === 'governance_agenda_proposal' && n.targetId)
    return can('governance.board') ? `/board/agenda/${n.targetId}` : null;
  if (n.targetType === 'board_publication' && n.kind === 'governance_objection.lodged' && n.targetId)
    return can('governance.board') ? `/board/objections/${n.targetId}` : null;
  if (n.targetType === 'governance_board_appeal' && n.targetId) {
    if (can('governance.board')) return `/board/appeals/${n.targetId}`;
    return can('governance.manage') ? `/governance/board-appeals/${n.targetId}` : null;
  }
  // Patrols (ADR 0052): a run's page for whoever reads the runs.
  if (n.targetType === 'patrol_run') return can('patrols.manage') || can('guard_reports.read') ? '/security/patrols/runs' : null;
  // Security (ADR 0053): each keeper's page.
  if (n.targetType === 'gate_lockdown') return can('lockdown.end') ? '/security/lockdowns' : null;
  if (n.targetType === 'blocklist_entry' && n.targetId)
    return can('blocklist.manage') ? `/security/blocklist?entry=${n.targetId}` : null;
  if (n.targetType === 'incident' && n.targetId)
    return can('incidents.manage') ? `/security/incidents?incident=${n.targetId}` : null;
  if (n.targetType === 'unit_violation' && n.targetId)
    return can('violations.manage') || can('violations.issue') || can('fines.billing') ? `/violations?violation=${n.targetId}` : null;
  // The gate offline (ADR 0057): a device, or an uploaded batch's flags.
  if (n.targetType === 'gate_device' && n.targetId)
    return can('gate_devices.manage') ? `/security/gate-devices?device=${n.targetId}` : null;
  if (n.targetType === 'gate_offline_batch' && n.targetId)
    return can('gate_devices.manage') ? `/security/offline-flags?batch=${n.targetId}` : null;
  // The control room's channel (ADR 0068).
  if (n.targetType === 'control_room_event' && n.targetId)
    return can('control_room.watch') ? `/security/control-room?event=${n.targetId}` : null;
  // A field exception to answer (ADR 0056), for the on-duty management.
  if (n.targetType === 'gate_field_exception' && n.targetId)
    return can('gate_exceptions.decide') ? `/security/field-exceptions?exception=${n.targetId}` : null;
  // Children (ADR 0054): an unauthorized pickup's alert, for the keepers.
  if (n.targetType === 'child_pickup' && n.targetId)
    return can('guard_roster.manage') ? `/security/child-alerts?open=${n.targetId}` : null;
  if (n.kind === 'account.deletion_queued') return can('accounts.erase') ? '/deletions' : null;
  if (n.kind === 'account.new_device_login') return '/account';
  if (n.targetType === 'worker_engagement') return can('workers.review') ? '/workers?tab=all' : null;
  return null;
}

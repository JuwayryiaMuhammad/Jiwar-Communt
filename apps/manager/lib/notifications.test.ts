import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notificationHref, notificationText } from './notifications.ts';

const n = (kind: string, params: Record<string, string | number>, targetType: string | null = null, targetId: string | null = null) => ({
  kind,
  params,
  targetType,
  targetId,
});

test('a kind reads as a sentence built from its params', () => {
  assert.equal(notificationText(n('ticket.sla_breached', { ticketNumber: 'MT-000041', clock: 'resolution' })), 'Ticket MT-000041 passed its resolution target');
  assert.equal(
    notificationText(n('ticket.emergency', { ticketNumber: 'MT-000007', categoryKey: 'water_leak', unitCode: 'A-12' })),
    'Emergency: Ticket MT-000007 · water leak · unit A-12',
  );
  assert.equal(
    notificationText(n('parcel.held_long', { parcelNumber: 3, carrier: 'egypt_post', days: 14, unitCode: 'B-2' })),
    'Parcel 3 (egypt post) has waited 14 days for unit B-2',
  );
});

test('an optional param that is absent leaves no gap', () => {
  assert.equal(notificationText(n('ticket.declined', { ticketNumber: 'MT-000003' })), 'Ticket MT-000003 was declined by its technician and is back in the queue');
});

test('a number inside a sentence keeps its letters, and a device is named in words', () => {
  assert.equal(notificationText(n('ticket.message', { ticketNumber: 'MT-000005', unitCode: 'A-301' })), 'New message on ticket MT-000005 · unit A-301');
  assert.match(notificationText(n('account.new_device_login', { deviceType: 'desktop_web', at: '2026-10-10T15:55:56.365Z' })), /^Your account was signed in to from a new computer browser, 10 Oct/);
  assert.equal(notificationText(n('account.new_device_login', { deviceType: 'unknown', at: 'x' })), 'Your account was signed in to from a new device');
});

test('blocker codes are listed in words', () => {
  assert.equal(
    notificationText(n('account.deletion_queued', { blockers: 'primary_resident,legal_hold' })),
    'A deletion request is waiting for management: primary resident, legal hold',
  );
});

test('an unknown kind still reads as something', () => {
  assert.equal(notificationText(n('future.new_kind', { x: 1 })), 'Future new kind');
});

test('a link is offered only where the reader may open the page', () => {
  const ticket = n('ticket.declined', { ticketNumber: 'MT-000003' }, 'ticket', 'abc');
  assert.equal(notificationHref(ticket, () => true), '/maintenance/abc');
  assert.equal(notificationHref(ticket, () => false), null);
  assert.equal(notificationHref(n('parcel.unclaimable', {}, 'parcel', 'p1'), (p) => p === 'parcels.manage'), '/parcels?parcel=p1');
  assert.equal(notificationHref(n('account.new_device_login', {}, 'known_device', 'd1'), () => false), '/account');
  assert.equal(notificationHref(n('account.deletion_requested', {}, 'account_deletion_request', 'r1'), () => true), null);
});

test('a community notice says what happened and leads to its page only for whoever may open it', () => {
  const important = n('community_announcement.important', {}, 'community_announcement', 'a-1');
  assert.equal(notificationText(important), 'An important announcement was published');
  assert.equal(notificationHref(important, (p) => p === 'community.publish'), '/announcements/a-1');
  assert.equal(notificationHref(important, () => false), null);
  const moved = n('community_suggestion.status_changed', { status: 'under_review', topicKey: 'events_activities' }, 'community_suggestion', 's-1');
  assert.equal(notificationText(moved), 'Your suggestion about events activities is now under review');
  assert.equal(notificationHref(moved, (p) => p === 'community.suggestions'), '/suggestions/s-1');
  assert.equal(notificationHref(moved, (p) => p === 'community.publish'), null);
  const cancelled = n('community_event.cancelled', {}, 'community_event', 'e-1');
  assert.equal(notificationHref(cancelled, (p) => p === 'community.publish'), '/events/e-1');
});

test('a request to the management is named by its number and topic, and leads to its page for a handler', () => {
  const escalated = n('management_request.escalated', { requestNumber: 'MR-000012', topicKey: 'billing_fees' }, 'management_request', 'r-1');
  assert.equal(notificationText(escalated), 'Request MR-000012 (billing fees) is overdue: nobody has responded');
  assert.equal(
    notificationText(n('management_appointment.requested', { requestNumber: 'MR-000003', topicKey: 'general' })),
    'Request MR-000003 (general): the resident picked an appointment slot',
  );
  assert.equal(notificationHref(escalated, (p) => p === 'requests.handle'), '/management-requests/r-1');
  assert.equal(notificationHref(escalated, (p) => p === 'tickets.dispatch'), null);
});

const NEIGHBOUR_KINDS = [
  'neighbour_complaint.submitted',
  'neighbour_complaint.author_replied',
  'neighbour_complaint.withdrawn',
  'neighbour_complaint.under_review',
  'neighbour_complaint.in_mediation',
  'neighbour_complaint.resolved',
  'neighbour_complaint.dismissed',
  'neighbour_complaint.replied',
  'neighbour_complaint.notice_sent',
  'neighbour_notice.unit_replied',
  'neighbour_notice.received',
  'neighbour_notice.replied',
  'neighbour_item.claimed',
  'neighbour_item.handed_over',
  'neighbour_claim.declined',
  'neighbour_post.removed',
  'neighbour_conversation.started',
  'neighbour_conversation.message',
  'neighbour_conversation.reveal_requested',
  'neighbour_conversation.names_revealed',
  'neighbour_conversation.reported',
  'neighbour_report.closed',
  'neighbours.welcome',
];

test('every neighbours kind has its own sentence, never the fallback', () => {
  const params = { complaintNumber: 'NC-000123', categoryKey: 'loud_noise', postKind: 'found' };
  const texts = NEIGHBOUR_KINDS.map((kind) => {
    const text = notificationText(n(kind, params));
    const fallback = kind.replace(/[._]/g, ' ').replace(/^./, (c) => c.toUpperCase());
    assert.notEqual(text, fallback, kind);
    assert.doesNotMatch(text, /undefined/, kind);
    return text;
  });
  assert.equal(new Set(texts).size, NEIGHBOUR_KINDS.length);
});

test('a complaint is named by its number and category, a post by its kind', () => {
  const submitted = n('neighbour_complaint.submitted', { complaintNumber: 'NC-000123', categoryKey: 'loud_noise' }, 'neighbour_complaint', 'c-1');
  assert.equal(notificationText(submitted), 'Complaint NC-000123 (loud noise) is new');
  assert.equal(
    notificationText(n('neighbour_notice.unit_replied', { complaintNumber: 'NC-000007', categoryKey: 'parking' })),
    'Complaint NC-000007 (parking): the unit answered its notice',
  );
  assert.equal(notificationText(n('neighbour_item.claimed', { postKind: 'found' })), 'A resident claimed a found item at the desk');
  assert.equal(notificationText(n('neighbour_post.removed', { postKind: 'borrow' })), 'Your request to borrow was removed from its board by the management');
  assert.equal(notificationText(n('neighbour_post.removed', {})), 'Your post was removed from its board by the management');
  assert.equal(notificationText(n('neighbour_notice.received', { categoryKey: 'loud_noise' })), 'The management sent your unit a notice about loud noise');
});

test('a neighbours notice leads to its page for a handler, and nowhere for what is the residents’ own', () => {
  const handler = (p: string) => p === 'neighbours.handle';
  const complaint = n('neighbour_notice.unit_replied', { complaintNumber: 'NC-000007', categoryKey: 'parking' }, 'neighbour_complaint', 'c-1');
  assert.equal(notificationHref(complaint, handler), '/complaints/c-1');
  assert.equal(notificationHref(complaint, (p) => p === 'requests.handle'), null);
  assert.equal(notificationHref(n('neighbour_item.claimed', { postKind: 'found' }, 'neighbour_post', 'p-1'), handler), '/lost-found/p-1');
  assert.equal(notificationHref(n('neighbour_item.claimed', { postKind: 'found' }, 'neighbour_post', 'p-1'), () => false), null);
  assert.equal(notificationHref(n('neighbour_conversation.reported', {}, 'neighbour_report', 'r-1'), handler), '/conversation-reports/r-1');
  assert.equal(notificationHref(n('neighbour_conversation.reported', {}, 'neighbour_report', 'r-1'), () => false), null);
  for (const [kind, target] of [
    ['neighbour_notice.received', 'neighbour_notice'],
    ['neighbour_conversation.message', 'neighbour_conversation'],
    ['neighbour_report.closed', 'neighbour_conversation'],
    ['neighbours.welcome', 'neighbour_welcome'],
  ] as const) {
    assert.equal(notificationHref(n(kind, {}, target, 'x-1'), () => true), null, kind);
  }
});

test('an emergency or a gate service says the kind, never a name, and leads to its queue (ADR 0047)', () => {
  const late = n('emergency.escalated', { emergencyType: 'medical' }, 'emergency', 'e-1');
  assert.equal(notificationText(late), 'Nobody has answered a medical emergency');
  assert.equal(notificationHref(late, (p) => p === 'emergencies.manage'), '/emergencies');
  assert.equal(notificationHref(late, () => false), null);
  const asked = n('gate_service.requested', { serviceKind: 'escort' }, 'gate_service_request', 'g-1');
  assert.equal(notificationText(asked), 'A resident asked security for escort');
  assert.equal(notificationHref(asked, (p) => p === 'gate_services.handle'), '/gate-services');
});

test('a permit to decide says its kind, never a name, and leads to the permit for whoever decides (ADR 0049)', () => {
  const asked = n('unit_permit.requested', { permitKind: 'material_exit' }, 'unit_permit', 'p-1');
  assert.equal(notificationText(asked), 'A unit asked for a permit: material exit');
  assert.equal(notificationHref(asked, (p) => p === 'permits.manage'), '/permits/p-1');
  assert.equal(notificationHref(asked, () => false), null);
});

test('the guards’ duty says codes only, and leads a keeper to its page (ADR 0050)', () => {
  const absent = { kind: 'guard_shift.absent_unmanned', params: {}, targetType: 'guard_roster_slot', targetId: 's1' };
  assert.equal(notificationText(absent), 'A guard did not start their shift and nobody is on duty there');
  assert.equal(notificationHref(absent, (p) => p === 'guard_roster.manage'), '/security/roster');
  assert.equal(notificationHref(absent, () => false), null);
  const swap = { kind: 'guard_swap.accepted', params: {}, targetType: 'guard_shift_swap', targetId: 'w1' };
  assert.equal(notificationHref(swap, (p) => p === 'guard_roster.manage'), '/security/swaps');
  const task = { kind: 'guard_task.assigned', params: { taskKind: 'custom' }, targetType: 'guard_task', targetId: 't1' };
  assert.equal(notificationText(task), 'A custom task for you');
});

test('an election to certify says whether the board has a tie to resolve, and leads to it for the manager (ADR 0051)', () => {
  const tied = n('governance_election.awaiting_certification', { tied: 'yes' }, 'governance_election', 'e-1');
  assert.equal(notificationText(tied), 'An election closed with a tie: record the board’s choice and certify it');
  assert.equal(notificationHref(tied, (p) => p === 'governance.manage'), '/governance/elections/e-1');
  assert.equal(notificationHref(tied, () => false), null);
  const plain = n('governance_election.awaiting_certification', { tied: 'no' }, 'governance_election', 'e-1');
  assert.equal(notificationText(plain), 'An election closed: certify its result');
});

test('a patrol run’s notice leads to the runs, for whoever reads them (ADR 0052)', () => {
  const missed = { kind: 'patrol.missed', targetType: 'patrol_run', targetId: 'r1', params: {} };
  assert.equal(notificationHref(missed, (p) => p === 'patrols.manage'), '/security/patrols/runs');
  assert.equal(notificationHref(missed, (p) => p === 'guard_reports.read'), '/security/patrols/runs');
  assert.equal(notificationHref(missed, () => false), null);
});

test('the security notices of ADR 0053 say what happened by code, and lead to the keeper’s page', () => {
  assert.equal(notificationText(n('gate_lockdown.started', { scope: 'all' })), 'Every gate is locked down');
  assert.equal(notificationText(n('incident.reported', { severity: 'high', incidentType: 'near_miss' })), 'A high near miss incident was reported');
  assert.equal(
    notificationText(n('blocklist.ban_matched', { source: 'visitor_pass' })),
    'A banned plate or person was refused at the gate (visitor pass)',
  );
  const lockdown = n('gate_lockdown.started', { scope: 'gate' }, 'gate_lockdown', 'l-1');
  assert.equal(notificationHref(lockdown, (p) => p === 'lockdown.end'), '/security/lockdowns');
  assert.equal(notificationHref(lockdown, () => false), null);
  assert.equal(notificationHref(n('incident.assigned', {}, 'incident', 'i-1'), (p) => p === 'incidents.manage'), '/security/incidents?incident=i-1');
  assert.equal(notificationHref(n('blocklist.watch_matched', { source: 'verify' }, 'blocklist_entry', 'b-1'), (p) => p === 'blocklist.manage'), '/security/blocklist?entry=b-1');
  assert.equal(notificationHref(n('violation.issued', { violationKind: 'noise' }, 'unit_violation', 'v-1'), (p) => p === 'fines.billing'), '/violations?violation=v-1');
  assert.equal(notificationHref(n('violation.issued', { violationKind: 'noise' }, 'unit_violation', 'v-1'), () => false), null);
});

test('an unauthorized child pickup reads as a code and leads to the keepers’ alert (ADR 0054)', () => {
  const alert = { kind: 'child.unauthorized_pickup', targetType: 'child_pickup', targetId: 'p1', params: {} };
  assert.equal(notificationText(alert), 'Someone not allowed tried to collect a child at the gate');
  assert.equal(notificationHref(alert, (p) => p === 'guard_roster.manage'), '/security/child-alerts?open=p1');
  assert.equal(notificationHref(alert, () => false), null);
});

const BOARD_KINDS = [
  'governance_approval.raised',
  'governance_approval.decided',
  'governance_approval.overdue',
  'governance_approval.implemented',
  'governance_approval.withdrawn',
  'governance_motion.proposed',
  'governance_appeal.lodged',
  'governance_appeal.decided',
  'governance_appeal.overdue',
];

test('every board matters kind has its own sentence from codes only (ADR 0055)', () => {
  const params = { type: 'major_contract', decision: 'approved', matter: 'approval', kind: 'vehicle_fine', outcome: 'overturned' };
  const texts = BOARD_KINDS.map((kind) => {
    const text = notificationText(n(kind, params));
    assert.notEqual(text, kind.replace(/[._]/g, ' ').replace(/^./, (c) => c.toUpperCase()), kind);
    assert.doesNotMatch(text, /undefined/, kind);
    return text;
  });
  assert.equal(new Set(texts).size, BOARD_KINDS.length);
  assert.equal(notificationText(n('governance_approval.raised', { type: 'major_contract' })), 'A major contract request awaits the board’s decision');
  assert.equal(notificationText(n('governance_approval.decided', { type: 'annual_budget', decision: 'rejected' })), 'The board rejected an annual budget request');
});

test('a board matter opens the board’s page for a member, the management’s for staff', () => {
  const approval = n('governance_approval.decided', {}, 'governance_approval', 'r1');
  assert.equal(notificationHref(approval, (p) => p === 'governance.board'), '/board/approvals/r1');
  assert.equal(notificationHref(approval, (p) => p === 'governance.approvals'), '/governance/approvals/r1');
  assert.equal(notificationHref(approval, () => false), null);
  const appeal = n('governance_appeal.overdue', {}, 'governance_board_appeal', 'a1');
  assert.equal(notificationHref(appeal, (p) => p === 'governance.board'), '/board/appeals/a1');
  assert.equal(notificationHref(appeal, (p) => p === 'governance.manage'), '/governance/board-appeals/a1');
  assert.equal(notificationHref(n('governance_motion.proposed', { matter: 'appeal' }, 'board_motion', 'm1'), () => true), '/board/appeals');
  assert.equal(notificationHref(n('governance_motion.proposed', { matter: 'approval' }, 'board_motion', 'm1'), () => false), null);
});

test('a field exception to answer, and a patrol out of its area, read as codes and lead to their pages (ADR 0056)', () => {
  const asked = n('gate_exception.requested', { exceptionKind: 'visitor_without_pass', unitCode: 'B7', gateName: 'North gate' }, 'gate_field_exception', 'x-1');
  assert.equal(notificationText(asked), 'A guard at North gate asks to let a visitor without a pass in for unit B7');
  assert.equal(notificationHref(asked, (p) => p === 'gate_exceptions.decide'), '/security/field-exceptions?exception=x-1');
  assert.equal(notificationHref(asked, () => false), null);
  const exit = n('patrol.geofence_exit', { minutes: 3 }, 'patrol_run', 'r-1');
  assert.equal(notificationText(exit), 'A guard on patrol was outside the route’s area for 3 minutes or more');
  assert.equal(notificationHref(exit, (p) => p === 'patrols.manage'), '/security/patrols/runs');
});

test('the gate offline (ADR 0057): its kinds read as sentences and lead to its pages', () => {
  assert.equal(notificationText(n('gate_device.sync_overdue', { minutes: 15 })), 'A gate device on shift has not been seen for 15 minutes');
  assert.equal(notificationText(n('gate_offline.security_conflict', { flags: 2 })), 'A gate device synced 2 security conflict(s) from offline');
  assert.equal(notificationText(n('gate_device.upload_rejected', { reason: 'signature' })), 'A gate device’s offline upload was refused (signature)');
  assert.equal(
    notificationText(n('blocklist.ban_matched', { source: 'offline_sync' })),
    'A banned plate was let in while the gate was offline',
  );
  const manages = (p: string) => p === 'gate_devices.manage';
  assert.equal(notificationHref(n('gate_device.enrolled', {}, 'gate_device', 'd1'), manages), '/security/gate-devices?device=d1');
  assert.equal(notificationHref(n('gate_offline.conflicts', { flags: 1 }, 'gate_offline_batch', 'b1'), manages), '/security/offline-flags?batch=b1');
  assert.equal(notificationHref(n('gate_offline.conflicts', { flags: 1 }, 'gate_offline_batch', 'b1'), () => false), null);
});

test('a request to relay says the category, never a name, and leads its keeper to it (ADR 0060)', () => {
  const relay = n('partner_request.awaiting_relay', { category: 'home_services' }, 'partner_request', 'r-1');
  assert.equal(notificationText(relay), 'A resident asked a partner without a desk link: home services');
  assert.equal(notificationHref(relay, (p) => p === 'partners.manage'), '/partners/requests/r-1');
  assert.equal(notificationHref(relay, () => false), null);
});

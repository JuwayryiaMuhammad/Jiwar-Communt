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

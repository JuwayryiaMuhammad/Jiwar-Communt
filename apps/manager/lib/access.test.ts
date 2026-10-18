import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mayEnter } from './access.ts';

test('a manager enters whatever the role holds', () => {
  assert.equal(mayEnter({ type: 'manager', permissions: [] }), true);
});

test('a staff role with a maintenance permission enters', () => {
  assert.equal(mayEnter({ type: 'staff', permissions: ['tickets.dispatch'] }), true);
  assert.equal(mayEnter({ type: 'staff', permissions: ['gate.operate', 'maintenance.manage'] }), true);
});

test('a staff role that handles requests to the management enters', () => {
  assert.equal(mayEnter({ type: 'staff', permissions: ['requests.handle'] }), true);
  assert.equal(mayEnter({ type: 'staff', permissions: ['gate.operate', 'requests.manage'] }), true);
});

test('a staff role that publishes to the community or handles its suggestions enters', () => {
  assert.equal(mayEnter({ type: 'staff', permissions: ['community.publish'] }), true);
  assert.equal(mayEnter({ type: 'staff', permissions: ['gate.operate', 'community.suggestions'] }), true);
});

test('a staff role that handles complaints between units and the boards enters', () => {
  assert.equal(mayEnter({ type: 'staff', permissions: ['neighbours.handle'] }), true);
  assert.equal(mayEnter({ type: 'staff', permissions: ['gate.operate', 'neighbours.handle'] }), true);
});

test('a staff role that sets up facilities, works bookings or keeps the club enters: the accountant too', () => {
  assert.equal(mayEnter({ type: 'staff', permissions: ['facilities.manage'] }), true);
  assert.equal(mayEnter({ type: 'staff', permissions: ['gate.operate', 'bookings.handle'] }), true);
  assert.equal(mayEnter({ type: 'staff', permissions: ['club.billing'] }), true);
  // Vehicles, parking, fines and parking reports (ADR 0045).
  for (const p of ['vehicles.manage', 'fines.issue', 'fines.billing'])
    assert.equal(mayEnter({ type: 'staff', permissions: ['gate.operate', p] }), true);
});

test('a staff role that keeps billing plans, invoices or payments enters: a cashier with payments alone too', () => {
  assert.equal(mayEnter({ type: 'staff', permissions: ['finance.billing'] }), true);
  assert.equal(mayEnter({ type: 'staff', permissions: ['finance.invoice'] }), true);
  assert.equal(mayEnter({ type: 'staff', permissions: ['finance.payments'] }), true);
});

test('a staff role that only reads the finance reports enters', () => {
  assert.equal(mayEnter({ type: 'staff', permissions: ['finance.reports'] }), true);
});

test('a staff role that only decides the permits enters', () => {
  assert.equal(mayEnter({ type: 'staff', permissions: ['permits.manage'] }), true);
});

test('a guard, a technician and a resident do not', () => {
  assert.equal(mayEnter({ type: 'staff', permissions: ['gate.operate', 'parcels.handle'] }), false);
  assert.equal(mayEnter({ type: 'staff', permissions: ['tickets.work'] }), false);
  assert.equal(mayEnter({ type: 'resident', permissions: ['tickets.create', 'requests.create', 'units.read'] }), false);
  assert.equal(mayEnter({ type: 'resident', permissions: ['community.read', 'suggestions.create'] }), false);
  assert.equal(mayEnter({ type: 'resident', permissions: ['neighbours.complain', 'neighbours.board'] }), false);
  assert.equal(mayEnter({ type: 'resident', permissions: ['facilities.book'] }), false);
});

test('a staff role that watches emergencies or works gate services enters (ADR 0047)', () => {
  for (const p of ['emergencies.manage', 'emergencies.respond', 'gate_services.handle'])
    assert.equal(mayEnter({ type: 'staff', permissions: ['gate.operate', p] }), true);
  // A guard alone works from the app, inside a shift.
  assert.equal(mayEnter({ type: 'staff', permissions: ['gate.operate', 'parcels.handle'] }), false);
});

test('an answer without permissions admits nobody but a manager', () => {
  assert.equal(mayEnter(null), false);
  assert.equal(mayEnter(undefined), false);
  assert.equal(mayEnter({}), false);
  assert.equal(mayEnter({ type: 'staff' }), false);
  assert.equal(mayEnter({ type: 'staff', permissions: 'tickets.dispatch' }), false);
});

test('the guards’ keepers enter; a guard who closes parking reports does not (ADR 0050)', () => {
  for (const p of ['guard_roster.manage', 'guard_tasks.manage', 'guard_instructions.manage', 'guard_reports.read', 'found_items.manage'])
    assert.equal(mayEnter({ type: 'staff', permissions: [p] }), true);
  // The default guard role: the parking reports are closed from the app.
  assert.equal(mayEnter({ type: 'staff', permissions: ['gate.operate', 'parcels.handle', 'parking_reports.handle'] }), false);
  // The default security supervisor role.
  assert.equal(
    mayEnter({
      type: 'staff',
      permissions: ['guard_roster.manage', 'guard_tasks.manage', 'guard_instructions.manage', 'guard_reports.read'],
    }),
    true,
  );
});

test('the patrols’ keepers enter; a guard walking a route does not (ADR 0052)', () => {
  assert.equal(mayEnter({ type: 'staff', permissions: ['patrols.manage'] }), true);
  assert.equal(mayEnter({ type: 'staff', permissions: ['gate.operate', 'parcels.handle', 'parking_reports.handle'] }), false);
});

test('the security keepers enter; a guard on shift does not (ADR 0053)', () => {
  for (const p of ['incidents.manage', 'blocklist.manage', 'violations.manage', 'violations.issue', 'lockdown.end'])
    assert.equal(mayEnter({ type: 'staff', permissions: [p] }), true);
  assert.equal(mayEnter({ type: 'staff', permissions: ['gate.operate', 'parcels.handle', 'parking_reports.handle'] }), false);
});

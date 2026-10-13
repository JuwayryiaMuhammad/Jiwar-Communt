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

test('a guard, a technician and a resident do not', () => {
  assert.equal(mayEnter({ type: 'staff', permissions: ['gate.operate', 'parcels.handle'] }), false);
  assert.equal(mayEnter({ type: 'staff', permissions: ['tickets.work'] }), false);
  assert.equal(mayEnter({ type: 'resident', permissions: ['tickets.create', 'requests.create', 'units.read'] }), false);
  assert.equal(mayEnter({ type: 'resident', permissions: ['community.read', 'suggestions.create'] }), false);
});

test('an answer without permissions admits nobody but a manager', () => {
  assert.equal(mayEnter(null), false);
  assert.equal(mayEnter(undefined), false);
  assert.equal(mayEnter({}), false);
  assert.equal(mayEnter({ type: 'staff' }), false);
  assert.equal(mayEnter({ type: 'staff', permissions: 'tickets.dispatch' }), false);
});

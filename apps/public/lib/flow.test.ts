import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RULES, canSubmit, flowReducer, initialFlow, type FlowEvent, type FlowRules, type FlowState } from './flow.ts';

const run = (rules: FlowRules, events: FlowEvent[], from: FlowState = initialFlow) =>
  events.reduce(flowReducer(rules), from);

test('nothing is sent before a submit, and one submit sends once', () => {
  assert.equal(canSubmit(initialFlow), true);
  const busy = run(RULES.accountNotMe, [{ type: 'submit' }]);
  assert.equal(busy.busy, true);
  assert.equal(canSubmit(busy), false);
  assert.equal(run(RULES.accountNotMe, [{ type: 'submit' }], busy), busy);
});

test('not-me: confirm, then done; a spent link is dead', () => {
  assert.deepEqual(run(RULES.accountNotMe, [{ type: 'submit' }, { type: 'advanced', to: 'done' }]), {
    step: 'done',
    busy: false,
    error: null,
    fields: [],
  });
  const dead = run(RULES.accountNotMe, [{ type: 'submit' }, { type: 'failed', code: 'ACTION_TOKEN_INVALID' }]);
  assert.equal(dead.step, 'dead');
  assert.equal(canSubmit(dead), false);
  assert.equal(run(RULES.accountNotMe, [{ type: 'submit' }], dead), dead);
});

test('a rate limit keeps the step and can be retried', () => {
  const limited = run(RULES.accountNotMe, [{ type: 'submit' }, { type: 'failed', code: 'RATE_LIMITED' }]);
  assert.deepEqual(limited, { step: 'intro', busy: false, error: 'RATE_LIMITED', fields: [] });
  assert.equal(canSubmit(limited), true);
  assert.equal(run(RULES.accountNotMe, [{ type: 'submit' }], limited).error, null);
});

test('export: a wrong code stays on the code step, a dead link ends it', () => {
  const atCode = run(RULES.export, [{ type: 'submit' }, { type: 'advanced', to: 'code' }]);
  assert.equal(atCode.step, 'code');
  const wrong = run(RULES.export, [{ type: 'submit' }, { type: 'failed', code: 'STEP_UP_CODE_INVALID' }], atCode);
  assert.deepEqual(wrong, { step: 'code', busy: false, error: 'STEP_UP_CODE_INVALID', fields: [] });
  const spent = run(RULES.export, [{ type: 'submit' }, { type: 'failed', code: 'ACTION_TOKEN_INVALID' }], atCode);
  assert.equal(spent.step, 'dead');
  // A new code from the code step returns to it.
  assert.equal(run(RULES.export, [{ type: 'submit' }, { type: 'advanced', to: 'code' }], wrong).step, 'code');
});

test('invite: OTP_INVALID never kills the page', () => {
  const atCode = run(RULES.invite, [{ type: 'submit' }, { type: 'advanced', to: 'code' }]);
  const wrong = run(RULES.invite, [{ type: 'submit' }, { type: 'failed', code: 'OTP_INVALID' }], atCode);
  assert.equal(wrong.step, 'code');
  assert.equal(wrong.error, 'OTP_INVALID');
});

test('registration: a refused form returns to it with its field errors', () => {
  const fields = [{ field: 'phone', code: 'INVALID_PHONE' }];
  const refused = run(RULES.registration, [{ type: 'submit' }, { type: 'failed', code: 'VALIDATION_FAILED', fields }]);
  assert.deepEqual(refused, { step: 'intro', busy: false, error: 'VALIDATION_FAILED', fields });
  const atCode = run(RULES.registration, [{ type: 'submit' }, { type: 'advanced', to: 'code' }]);
  const late = run(RULES.registration, [{ type: 'submit' }, { type: 'failed', code: 'VALIDATION_FAILED', fields }], atCode);
  assert.equal(late.step, 'intro');
  // Without a form, a validation error stays where it happened.
  assert.equal(
    run(RULES.export, [{ type: 'submit' }, { type: 'failed', code: 'VALIDATION_FAILED' }], atCode).step,
    'code',
  );
});

test('edit leaves the code step only, and never while busy', () => {
  const atCode = run(RULES.registration, [{ type: 'submit' }, { type: 'advanced', to: 'code' }]);
  assert.deepEqual(run(RULES.registration, [{ type: 'edit' }], atCode), initialFlow);
  const busy = run(RULES.registration, [{ type: 'submit' }], atCode);
  assert.equal(run(RULES.registration, [{ type: 'edit' }], busy), busy);
  assert.equal(run(RULES.registration, [{ type: 'edit' }]), initialFlow);
});

test('an answer that arrives when nothing is in flight is ignored', () => {
  assert.equal(run(RULES.export, [{ type: 'advanced', to: 'done' }]), initialFlow);
  assert.equal(run(RULES.export, [{ type: 'failed', code: 'ACTION_TOKEN_INVALID' }]), initialFlow);
});

test('restart begins again from a finished page only', () => {
  const done = run(RULES.export, [{ type: 'submit' }, { type: 'advanced', to: 'done' }]);
  assert.deepEqual(run(RULES.export, [{ type: 'restart' }], done), initialFlow);
  const dead = run(RULES.export, [{ type: 'submit' }, { type: 'failed', code: 'ACTION_TOKEN_INVALID' }]);
  assert.equal(run(RULES.export, [{ type: 'restart' }], dead), dead);
  assert.equal(run(RULES.export, [{ type: 'restart' }]), initialFlow);
});

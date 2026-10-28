import { DERIVED_MOVE_STEPS, MoveSteps } from './move-steps';

describe('MoveSteps', () => {
  const done = () => Promise.resolve({ done: true, at: null, reference: null });

  it('refuses to start while a derived step has no reader', () => {
    const steps = new MoveSteps();
    steps.register('move_permit', done);
    expect(steps.missing()).toEqual([
      'utilities_requested',
      'clearance_issued',
      'deposits_settled',
    ]);
    expect(() => steps.onApplicationBootstrap()).toThrow(
      /utilities_requested, clearance_issued, deposits_settled/,
    );
  });

  it('starts once every step has one reader, and never two', () => {
    const steps = new MoveSteps();
    for (const s of DERIVED_MOVE_STEPS) steps.register(s, done);
    expect(() => steps.onApplicationBootstrap()).not.toThrow();
    expect(() => steps.register('move_permit', done)).toThrow(/twice/);
  });
});

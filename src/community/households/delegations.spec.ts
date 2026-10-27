import { DELEGATION_SCOPES } from './delegations.service';

describe('delegation scopes (ADR 0016)', () => {
  it('are exactly household, workers and permits — never money, contracts, governance or ownership', () => {
    expect([...DELEGATION_SCOPES].sort()).toEqual([
      'household',
      'permits',
      'workers',
    ]);
  });
});

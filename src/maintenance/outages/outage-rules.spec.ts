import { scopeProblems } from './outage-rules';

describe('an outage’s scope (ADR 0066)', () => {
  it('the whole compound names no building', () => {
    expect(scopeProblems('compound', [])).toEqual([]);
    expect(scopeProblems('compound', ['Tower A'])).toEqual([
      { field: 'buildings', code: 'FIELD_NOT_ALLOWED' },
    ]);
  });

  it('buildings name at least one', () => {
    expect(scopeProblems('buildings', ['Tower A', 'Tower B'])).toEqual([]);
    expect(scopeProblems('buildings', [])).toEqual([
      { field: 'buildings', code: 'FIELD_REQUIRED' },
    ]);
  });
});

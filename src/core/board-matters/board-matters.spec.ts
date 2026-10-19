import { BoardMatters, type ApprovalKindHandler } from './board-matters';

const handler: ApprovalKindHandler = {
  subject: null,
  raise: () => Promise.resolve({ cost: null }),
  describe: () => Promise.resolve(null),
  decided: () => Promise.resolve({ implemented: true }),
  withdrawn: () => Promise.resolve(),
};

describe('BoardMatters (ADR 0055)', () => {
  it('takes one handler per type, and says what is missing', () => {
    const m = new BoardMatters();
    m.registerApproval('major_contract', handler);
    expect(() => m.registerApproval('major_contract', handler)).toThrow(
      /twice/,
    );
    expect(m.approval('major_contract')).toBe(handler);
    expect(m.approval('legal_escalation')).toBeNull();
    expect(
      m.missing({
        approvals: ['major_contract', 'annual_budget'],
        appeals: ['vehicle_fine'],
      }),
    ).toEqual(['approval:annual_budget', 'appeal:vehicle_fine']);
  });

  it('keeps overview sections in registration order, once each', () => {
    const m = new BoardMatters();
    const section = () => Promise.resolve({});
    m.registerOverview('finance', section);
    m.registerOverview('security', section);
    expect(() => m.registerOverview('finance', section)).toThrow(/twice/);
    expect(m.overview().map(([name]) => name)).toEqual(['finance', 'security']);
  });

  it('has one thresholds reader', () => {
    const m = new BoardMatters();
    const reader = () => Promise.resolve('5000.00');
    m.registerThresholds(reader);
    expect(() => m.registerThresholds(reader)).toThrow(/twice/);
  });
});

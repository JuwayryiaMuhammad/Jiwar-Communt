import { escalationRefusal, type EscalationFacts } from './escalation-rules';

const facts = (over: Partial<EscalationFacts> = {}): EscalationFacts => ({
  status: 'assigned',
  holdReason: null,
  overdue: ['response'],
  escalated: false,
  mayAct: true,
  ...over,
});

describe('resident escalation rules (ADR 0038)', () => {
  it('an open, overdue ticket, not escalated yet, by someone who may act', () => {
    for (const status of [
      'new',
      'assigned',
      'en_route',
      'in_progress',
    ] as const)
      expect(escalationRefusal(facts({ status }))).toBeNull();
  });

  it('never a ticket nobody is working on any more', () => {
    for (const status of ['completed', 'closed', 'cancelled'] as const)
      expect(escalationRefusal(facts({ status }))).toBe('status');
  });

  it('on hold: not while it waits for the residents themselves', () => {
    const held = (holdReason: EscalationFacts['holdReason']) =>
      escalationRefusal(facts({ status: 'on_hold', holdReason }));
    expect(held('awaiting_resident')).toBe('status');
    expect(held('awaiting_parts')).toBeNull();
    expect(held('other')).toBeNull();
  });

  it('only while overdue, and once', () => {
    expect(escalationRefusal(facts({ overdue: [] }))).toBe('not_overdue');
    expect(escalationRefusal(facts({ escalated: true }))).toBe(
      'already_escalated',
    );
  });

  it('answers in order: who, the state, the time, once', () => {
    const all = facts({
      mayAct: false,
      status: 'closed',
      overdue: [],
      escalated: true,
    });
    expect(escalationRefusal(all)).toBe('not_allowed');
    expect(escalationRefusal({ ...all, mayAct: true })).toBe('status');
    expect(
      escalationRefusal({ ...all, mayAct: true, status: 'assigned' }),
    ).toBe('not_overdue');
  });
});

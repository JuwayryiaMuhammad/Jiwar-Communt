import {
  choiceProblem,
  pollStatus,
  resultsHidden,
  RESULTS_MIN_TURNOUT,
} from './poll-rules';

const NOW = new Date('2026-10-20T10:00:00.000Z');
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);
const poll = (over: object = {}) => ({
  opensAt: at(-1),
  closesAt: at(1),
  closedAt: null,
  cancelledAt: null,
  ...over,
});

describe('poll rules (ADR 0040)', () => {
  it('scheduled, open, closed by the clock; closed early by the staff; cancelled wins', () => {
    expect(pollStatus(poll({ opensAt: at(0.5) }), NOW)).toBe('scheduled');
    expect(pollStatus(poll(), NOW)).toBe('open');
    expect(pollStatus(poll({ opensAt: NOW }), NOW)).toBe('open');
    // The closing instant is already closed, before any sweep ran.
    expect(pollStatus(poll({ closesAt: NOW }), NOW)).toBe('closed');
    expect(pollStatus(poll({ closedAt: at(-0.5) }), NOW)).toBe('closed');
    expect(pollStatus(poll({ cancelledAt: at(-0.5) }), NOW)).toBe('cancelled');
    expect(
      pollStatus(poll({ closesAt: at(-0.1), cancelledAt: at(-0.5) }), NOW),
    ).toBe('cancelled');
  });

  it('an open poll shows its counts from five units on, and to a resident only once their unit voted', () => {
    expect(RESULTS_MIN_TURNOUT).toBe(5);
    expect(resultsHidden('open', 'staff', 4)).toBe('few_votes');
    expect(resultsHidden('open', 'staff', 5)).toBeNull();
    expect(resultsHidden('open', { voted: false }, 50)).toBe('not_voted');
    expect(resultsHidden('open', { voted: true }, 4)).toBe('few_votes');
    expect(resultsHidden('open', { voted: true }, 5)).toBeNull();
  });

  it('a closed poll shows everything to everyone; a cancelled one nothing; a scheduled one has nothing yet', () => {
    for (const reader of [
      'staff',
      { voted: false },
      { voted: true },
    ] as const) {
      expect(resultsHidden('closed', reader, 0)).toBeNull();
      expect(resultsHidden('closed', reader, 1)).toBeNull();
      expect(resultsHidden('cancelled', reader, 100)).toBe('cancelled');
      expect(resultsHidden('scheduled', reader, 0)).toBe('not_open');
    }
  });

  it('a choice is one option of the poll, or several when the poll allows it, each once', () => {
    const options = ['a', 'b', 'c'];
    expect(choiceProblem(['a'], options, false)).toBeNull();
    expect(choiceProblem(['a', 'b'], options, false)).toEqual({
      index: -1,
      max: 1,
    });
    expect(choiceProblem([], options, true)).toEqual({ index: -1, max: 3 });
    expect(choiceProblem(['a', 'c'], options, true)).toBeNull();
    expect(choiceProblem(['a', 'a'], options, true)).toEqual({
      index: -1,
      max: 3,
    });
    expect(choiceProblem(['a', 'x'], options, true)).toEqual({
      index: 1,
      max: 3,
    });
  });
});

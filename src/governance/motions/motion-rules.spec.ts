import {
  closedAsItStands,
  decided,
  quorumOf,
  tally,
  type Choice,
  type Count,
} from './motion-rules';

const count = (
  seats: string[],
  votes: Record<string, Choice>,
  chair: string | null = null,
): Count => ({ seats, chair, votes: new Map(Object.entries(votes)) });

describe('motion rules (ADR 0055)', () => {
  it('the quorum is a majority of the seats that count', () => {
    expect([1, 2, 3, 4, 5, 6, 15].map(quorumOf)).toEqual([1, 2, 2, 3, 3, 4, 8]);
  });

  it('counts only the seats that count (an ended or recused seat’s vote is ignored)', () => {
    expect(tally(count(['a', 'b', 'c'], { a: 'for', x: 'for' }))).toEqual({
      n: 3,
      quorum: 2,
      cast: 1,
      for: 1,
      against: 0,
    });
  });

  it('a majority of all seats decides at once', () => {
    const seats = ['a', 'b', 'c', 'd', 'e'];
    expect(decided(count(seats, { a: 'for', b: 'for' }))).toBeNull();
    expect(decided(count(seats, { a: 'for', b: 'for', c: 'for' }))).toBe(
      'carried',
    );
    expect(
      decided(count(seats, { a: 'against', b: 'against', c: 'against' })),
    ).toBe('failed');
  });

  it('waits for the quorum even when the result can no longer change', () => {
    // Four seats, the chair against: for can reach at most a tie, which the
    // chair breaks against. Only two votes, below the quorum of three.
    const seats = ['chair', 'b', 'c', 'd'];
    expect(
      decided(count(seats, { chair: 'against', b: 'against' }, 'chair')),
    ).toBeNull();
    expect(
      decided(
        count(seats, { chair: 'against', b: 'against', c: 'for' }, 'chair'),
      ),
    ).toBe('failed');
  });

  it('a tie is the chair’s vote; with no chair, or a silent one, it fails', () => {
    const seats = ['chair', 'b', 'c', 'd'];
    const tie = { chair: 'for', b: 'for', c: 'against', d: 'against' } as const;
    expect(decided(count(seats, tie, 'chair'))).toBe('carried');
    expect(decided(count(seats, tie, null))).toBe('failed');
    expect(
      closedAsItStands(
        count(seats, { b: 'for', c: 'against', d: 'for' }, 'chair'),
      ),
    ).toBe('carried');
    expect(
      closedAsItStands(
        count(
          ['chair', 'b', 'c', 'd', 'e'],
          { b: 'for', c: 'against', d: 'for', e: 'against' },
          'chair',
        ),
      ),
    ).toBe('failed');
  });

  it('a chair recused (not among the seats) breaks no tie', () => {
    const c = count(
      ['b', 'c'],
      { b: 'for', c: 'against', chair: 'for' },
      'chair',
    );
    expect(decided(c)).toBe('failed');
  });

  it('with the chair still to vote, a tie it could break is not decided', () => {
    const seats = ['chair', 'b', 'c'];
    expect(
      decided(count(seats, { b: 'for', c: 'against' }, 'chair')),
    ).toBeNull();
    expect(decided(count(seats, { b: 'for', c: 'for' }, 'chair'))).toBe(
      'carried',
    );
  });

  it('a close after the deadline needs the quorum', () => {
    const seats = ['a', 'b', 'c', 'd', 'e'];
    expect(closedAsItStands(count(seats, { a: 'for', b: 'for' }))).toBeNull();
    expect(
      closedAsItStands(count(seats, { a: 'for', b: 'for', c: 'against' })),
    ).toBe('carried');
  });
});

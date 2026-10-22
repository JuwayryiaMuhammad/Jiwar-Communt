import { MAX_ALTERNATIVES, rankAlternatives } from './alternatives';

const c = (
  id: string,
  openNow: boolean,
  average: number | null,
  listedDay: number,
) => ({
  id,
  openNow,
  average,
  listedAt: new Date(Date.UTC(2031, 0, listedDay)),
});

describe('a suspended partner’s alternatives (ADR 0060)', () => {
  it('open now first, then the best rated, then the newest; never itself; three at most', () => {
    const ranked = rankAlternatives(
      [
        c('gone', true, 5, 1),
        c('closed-top', false, 4.9, 1),
        c('open-unrated', true, null, 9),
        c('open-good', true, 4.5, 1),
        c('open-ok', true, 3, 2),
        c('closed-new', false, null, 30),
      ],
      'gone',
    );
    expect(ranked.map((x) => x.id)).toEqual([
      'open-good',
      'open-ok',
      'open-unrated',
    ]);
    expect(MAX_ALTERNATIVES).toBe(3);
  });

  it('with nobody open, the best rated then the newest', () => {
    expect(
      rankAlternatives(
        [c('a', false, null, 5), c('b', false, null, 7), c('c', false, 2, 1)],
        'x',
      ).map((x) => x.id),
    ).toEqual(['c', 'b', 'a']);
  });
});

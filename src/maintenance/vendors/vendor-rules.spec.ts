import { averageScore, vendorReference } from './vendor-rules';

describe('vendor rules (ADR 0077)', () => {
  it('numbers a vendor V-0001', () => {
    expect(vendorReference(1)).toBe('V-0001');
    expect(vendorReference(12345)).toBe('V-12345');
  });

  it('averages each criterion and the overall to one decimal, null with none', () => {
    expect(averageScore([])).toEqual({
      quality: null,
      timeliness: null,
      cost: null,
      communication: null,
      safety: null,
      overall: null,
    });
    expect(
      averageScore([
        { quality: 5, timeliness: 4, cost: 3, communication: 5, safety: 5 },
        { quality: 4, timeliness: 2, cost: 3, communication: 4, safety: 5 },
      ]),
    ).toEqual({
      quality: 4.5,
      timeliness: 3,
      cost: 3,
      communication: 4.5,
      safety: 5,
      overall: 4,
    });
  });
});

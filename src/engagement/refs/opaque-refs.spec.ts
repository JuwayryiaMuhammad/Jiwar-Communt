import { deriveRef, sameRef } from './opaque-refs';

const KEY = 'k'.repeat(32);

describe('deriveRef (ADR 0040)', () => {
  it('is 32 bytes, stable for the same input', () => {
    const a = deriveRef(KEY, 'read:account', 'x', 'y');
    expect(a).toHaveLength(32);
    expect(sameRef(deriveRef(KEY, 'read:account', 'x', 'y'), a)).toBe(true);
  });

  it('differs by key, by label and by every part', () => {
    const base = deriveRef(KEY, 'read:account', 'x', 'y');
    for (const other of [
      deriveRef('j'.repeat(32), 'read:account', 'x', 'y'),
      deriveRef(KEY, 'read:unit', 'x', 'y'),
      deriveRef(KEY, 'ballot', 'x', 'y'),
      deriveRef(KEY, 'read:account', 'z', 'y'),
      deriveRef(KEY, 'read:account', 'x', 'z'),
    ])
      expect(sameRef(other, base)).toBe(false);
  });

  it('a ballot does not survive its salt: another salt is another reference', () => {
    const ballot = (salt: string) => deriveRef(KEY, 'ballot', salt, 'p', 'u');
    expect(sameRef(ballot('aa'), ballot('ab'))).toBe(false);
  });
});

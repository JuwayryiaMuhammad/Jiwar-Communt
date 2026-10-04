import type * as IdBlocks from './id-blocks';
import { nationalIdFor, uniquePhone } from './fixtures';
import { parseEgyptianNationalId } from '../../src/core/common/egyptian-national-id';

/**
 * The generators behind test phones and national IDs never repeat within a
 * run, across suites too (each suite loads the module afresh and claims its
 * own block).
 */
describe('Test identities', () => {
  /** What a freshly loaded suite would draw: its own module instance. */
  function aSuiteDraws(n: number): number[] {
    let values: number[] = [];
    jest.isolateModules(() => {
      const fresh = jest.requireActual<typeof IdBlocks>('./id-blocks');
      const next = fresh.suiteSequence(1e8, 1e5);
      values = Array.from({ length: n }, next);
    });
    return values;
  }

  it('suites draw from blocks that never overlap, so their values never meet', () => {
    const suites = Array.from({ length: 12 }, () => aSuiteDraws(2000));
    const all = suites.flat();
    expect(new Set(all).size).toBe(all.length);
    // Each suite counts up inside one block of 100,000.
    for (const values of suites) {
      expect(Math.floor(values[0] / 1e5)).toBe(
        Math.floor(values[values.length - 1] / 1e5),
      );
    }
  });

  it('draws are the same width as a phone number and national ID need', () => {
    const phones = Array.from({ length: 5000 }, uniquePhone);
    expect(new Set(phones).size).toBe(5000);
    expect(phones.every((p) => /^\+2010\d{8}$/.test(p))).toBe(true);
    const ids = Array.from({ length: 900 }, () => nationalIdFor());
    expect(new Set(ids).size).toBe(900);
    expect(ids.every((id) => parseEgyptianNationalId(id) !== null)).toBe(true);
  });

  it('a suite that needs more than its share fails loudly instead of wrapping', () => {
    jest.isolateModules(() => {
      const fresh = jest.requireActual<typeof IdBlocks>('./id-blocks');
      const next = fresh.suiteSequence(1e8, 3);
      next();
      next();
      next();
      expect(() => next()).toThrow(/more than its 3 test ids/);
    });
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as IdBlocks from './id-blocks';
import {
  HAND_WRITTEN_GOVERNORATES,
  nationalIdFor,
  uniquePhone,
  uniqueUkDigits,
} from './fixtures';
import { normalizePhone } from '../../src/core/auth/identifier';
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
    expect(phones.every((p) => /^\+2012\d{8}$/.test(p))).toBe(true);
    expect(phones.every((p) => normalizePhone(p) === p)).toBe(true);
    const ids = Array.from({ length: 900 }, () => nationalIdFor());
    expect(new Set(ids).size).toBe(900);
    expect(ids.every((id) => parseEgyptianNationalId(id) !== null)).toBe(true);
    expect(
      ids.filter((id) => HAND_WRITTEN_GOVERNORATES.includes(id.slice(7, 9))),
    ).toEqual([]);
  });

  it('no hand-written phone or national ID under test/ is in the generated space', () => {
    const root = join(__dirname, '..');
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(join(root, f), 'utf8'));
    const literals = (pattern: RegExp) =>
      files.flatMap((text) => text.match(pattern) ?? []);

    // Generated phones are +2012..., generated UK mobiles +447400...
    expect(literals(/\+20 ?12\d{8}\b/g)).toEqual([]);
    expect(literals(/\+44 ?7400 ?\d{6}\b/g)).toEqual([]);
    // Generated national IDs never use the hand-written governorates.
    const ids = literals(/\b[23]\d{13}\b/g).filter(
      (id) => parseEgyptianNationalId(id) !== null,
    );
    expect(ids.length).toBeGreaterThan(0);
    expect(
      ids.filter((id) => !HAND_WRITTEN_GOVERNORATES.includes(id.slice(7, 9))),
    ).toEqual([]);
    expect(uniqueUkDigits()).toMatch(/^\d{6}$/);
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

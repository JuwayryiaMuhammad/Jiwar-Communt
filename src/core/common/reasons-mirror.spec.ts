import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from './reasons';

/**
 * The dashboards' copy of the closed reason lists
 * (packages/api/src/reasons.ts) is written by hand: every list the backend
 * has must be there, code for code and in order, and no other. A domain's
 * own mirror spec pins its lists too; this one keeps a new list from being
 * forgotten (R11c-1b's companionRemove and chargeCancel were, and 27
 * others before them).
 */
const text = readFileSync(
  join(__dirname, '../../../packages/api/src/reasons.ts'),
  'utf8',
);
// One shape for single- and multi-line lists: `key: ['a', 'b']`.
const flat = text
  .replace(/\/\/.*$/gm, '')
  .replace(/\s+/g, ' ')
  .replace(/\[ /g, '[')
  .replace(/,? \]/g, ']');
const quoted = (codes: readonly string[]) =>
  codes.map((c) => `'${c}'`).join(', ');

describe('the dashboards’ mirror of the reason lists', () => {
  it.each(Object.keys(REASON_CODES) as (keyof typeof REASON_CODES)[])(
    '%s is the backend’s list',
    (list) => {
      expect(flat).toContain(` ${list}: [${quoted(REASON_CODES[list])}]`);
    },
  );

  it('names no list the backend does not have', () => {
    const mirrored = [...text.matchAll(/^ {2}(\w+): \[/gm)].map((m) => m[1]);
    expect(mirrored.filter((k) => !(k in REASON_CODES))).toEqual([]);
    expect(new Set(mirrored).size).toBe(mirrored.length);
  });
});

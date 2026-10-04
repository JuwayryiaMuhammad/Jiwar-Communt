import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Test identities that never repeat within one e2e run (phone numbers and
 * national IDs are unique per compound, and a random draw repeats after about
 * the square root of its range: two numbers in one compound once collided).
 *
 * Each suite claims a **block** of the run's id space, once, when its module
 * loads (an exclusive `mkdir` in a directory the global setup empties at the
 * start of every run, so it works across jest workers as well). A suite then
 * counts up inside its own block. Blocks do not overlap and counters do not
 * repeat, so no two values of a run are equal: by construction, not by luck.
 * Running out of a block or of blocks throws instead of wrapping.
 */
const DIR = join(tmpdir(), 'jiwar-e2e-id-blocks');

/** Called once per run by the global setup. */
export function resetIdBlocks(): void {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
}

let claimed: number | undefined;

/** This suite's block number, unique within the run. */
function suiteBlock(): number {
  if (claimed !== undefined) return claimed;
  mkdirSync(DIR, { recursive: true });
  for (let block = 0; ; block++) {
    try {
      mkdirSync(join(DIR, String(block)));
      claimed = block;
      return block;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

/**
 * A counter over the first `space` values of an id space, `perSuite` of
 * them for each suite: the n-th call of the suite in block b returns
 * `b * perSuite + n`.
 */
export function suiteSequence(space: number, perSuite: number): () => number {
  let used = 0;
  return () => {
    if (used >= perSuite)
      throw new Error(`a suite used more than its ${perSuite} test ids`);
    const block = suiteBlock();
    if ((block + 1) * perSuite > space)
      throw new Error(
        `more than ${Math.floor(space / perSuite)} suites in one run: widen the id space`,
      );
    return block * perSuite + used++;
  };
}

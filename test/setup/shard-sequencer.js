// @ts-check
const { readFileSync } = require('node:fs');
const path = require('node:path');
const Sequencer = require('@jest/test-sequencer').default;

/**
 * CI's e2e shards (`--shard=i/N`), balanced by each suite's duration
 * instead of jest's hash of the path, which left one shard of four with
 * nearly twice another's minutes. Longest suite first, each to the shard
 * with the fewest seconds so far (ties: path, then lowest shard), from the
 * committed test/e2e-durations.json: every shard computes the same split
 * from the same checkout, so no suite runs twice or not at all. A suite
 * missing from the file (new, or under jest's 5 s slow threshold, which
 * prints no time) counts as DEFAULT_SECONDS. Order within a shard is
 * jest's own.
 *
 * Refresh the durations from a green CI run:
 *   gh run view <run-id> --log | node test/setup/shard-sequencer.js > test/e2e-durations.json
 */
const DURATIONS = path.join(__dirname, '..', 'e2e-durations.json');
const DEFAULT_SECONDS = 3;

class ShardSequencer extends Sequencer {
  shard(tests, { shardIndex, shardCount }) {
    /** @type {Record<string, number>} */
    const seconds = JSON.parse(readFileSync(DURATIONS, 'utf8'));
    const weighed = tests
      .map((test) => {
        const rel = path
          .relative(test.context.config.rootDir, test.path)
          .split(path.sep)
          .join('/');
        return { test, rel, s: seconds[rel] ?? DEFAULT_SECONDS };
      })
      .sort(
        (a, b) => b.s - a.s || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0),
      );
    const load = Array.from({ length: shardCount }, () => 0);
    const mine = [];
    for (const w of weighed) {
      const to = load.indexOf(Math.min(...load));
      load[to] += w.s;
      if (to === shardIndex - 1) mine.push(w.test);
    }
    return mine;
  }
}

module.exports = ShardSequencer;

// The refresh: a CI log on stdin, the durations file on stdout.
if (require.main === module) {
  const log = readFileSync(0, 'utf8');
  /** @type {Record<string, number>} */
  const out = {};
  for (const m of log.matchAll(
    /(?:PASS|FAIL) (test\/\S+\.e2e-spec\.ts) \(([0-9.]+) s\)/g,
  ))
    out[m[1]] = Math.max(out[m[1]] ?? 0, Math.round(Number(m[2])));
  const sorted = Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  process.stdout.write(`${JSON.stringify(sorted, null, 2)}\n`);
}

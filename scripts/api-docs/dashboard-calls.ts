/**
 * The API calls the manager's dashboard makes, read from its source: every
 * `api.GET('/api/v1/...')` (and the other methods) in `apps/manager`. Keys
 * are `<method> <path without the prefix>`, the method in lower case, as the
 * audience rules compare them.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CALL =
  /\bapi\.(GET|POST|PUT|PATCH|DELETE)\(\s*['"`]\/api\/v1(\/[^'"`]*)['"`]/g;
const SKIP = new Set(['node_modules', '.next', 'out', 'dist']);

export function dashboardCalls(appDir: string): Set<string> {
  const calls = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name))
        for (const m of readFileSync(full, 'utf8').matchAll(CALL))
          calls.add(`${m[1].toLowerCase()} ${m[2]}`);
    }
  };
  walk(appDir);
  return calls;
}

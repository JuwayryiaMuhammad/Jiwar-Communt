import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '../../..');

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts'))
      yield path;
  }
}

/**
 * Swagger keys a component schema by its class name: two classes of the same
 * name are one schema in the contract, and the last one read wins. That is
 * how the recurring visitor windows came to be documented as a maintenance
 * visit's `{ startsAt, endsAt }`, and the household's permission decision as
 * the gate's `approve | deny`. Every class a contract file declares has a
 * name of its own.
 */
describe('OpenAPI schema names', () => {
  it('no two contract classes share a name', () => {
    const seen = new Map<string, string[]>();
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes("from '@nestjs/swagger'")) continue;
      for (const m of text.matchAll(/export (?:abstract )?class (\w+)/g)) {
        seen.set(m[1], [...(seen.get(m[1]) ?? []), relative(SRC, file)]);
      }
    }
    const duplicates = [...seen].filter(([, files]) => files.length > 1);
    expect(duplicates).toEqual([]);
  });
});

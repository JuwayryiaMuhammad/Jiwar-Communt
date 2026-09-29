import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Bypassing the audit immutability triggers is allowed only in test/ (test
 * cleanup over a superuser connection). Application code, migrations, the
 * seed and the Docker init must never do it (ADR 0014).
 */
describe('audit guard rails', () => {
  const repo = join(__dirname, '..', '..');
  // Built by concatenation so this file does not match itself.
  const needle = ['session', 'replication', 'role'].join('_');

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.(ts|js|mjs|sql|sh)$/.test(name) ? [path] : [];
    });
  }

  it(`${needle} appears nowhere outside test/`, () => {
    const offenders = ['src', 'prisma', 'docker', 'scripts']
      .map((d) => join(repo, d))
      .filter((d) => {
        try {
          return statSync(d).isDirectory();
        } catch {
          return false;
        }
      })
      .flatMap(files)
      .filter((f) => readFileSync(f, 'utf8').toLowerCase().includes(needle))
      .map((f) => relative(repo, f));
    expect(offenders).toEqual([]);
  });
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Bypassing the audit immutability triggers is allowed only in test/ (test
 * cleanup over a superuser connection). Application code, migrations, the
 * seed and the Docker init must never do it (ADR 0014).
 */
describe('audit guard rails', () => {
  const repo = join(__dirname, '..', '..', '..');
  // Built by concatenation so this file does not match itself.
  const needles = [
    // bypasses the immutability triggers
    ['session', 'replication', 'role'].join('_'),
    // the superuser connection used for test cleanup
    ['TEST', 'SUPERUSER', 'DATABASE', 'URL'].join('_'),
  ];

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.(ts|js|mjs|sql|sh)$/.test(name) ? [path] : [];
    });
  }

  const scanned = ['src', 'prisma', 'docker', 'scripts']
    .map((d) => join(repo, d))
    .filter((d) => {
      try {
        return statSync(d).isDirectory();
      } catch {
        return false;
      }
    })
    .flatMap(files);

  it('scans the whole repository (a moved spec must not scan nothing)', () => {
    expect(
      scanned.some((f) => f.startsWith(join(repo, 'src', 'community'))),
    ).toBe(true);
    expect(scanned.some((f) => f.startsWith(join(repo, 'prisma')))).toBe(true);
  });

  it.each(needles)('%s appears nowhere outside test/', (needle) => {
    const offenders = scanned
      .filter((f) =>
        readFileSync(f, 'utf8').toLowerCase().includes(needle.toLowerCase()),
      )
      .map((f) => relative(repo, f));
    expect(offenders).toEqual([]);
  });
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * ADR 0013: every error the API returns carries a stable code. The type
 * system enforces it for AppException; this test makes sure nothing in src/
 * bypasses it with a bare Nest (or any other) exception.
 */
describe('error contract', () => {
  const root = join(__dirname, '..', '..'); // src/

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
    });
  }

  it('src/ constructs no exception type other than AppException', () => {
    const offenders = sourceFiles(root).flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return [...text.matchAll(/new\s+([A-Za-z_]\w*Exception)\s*\(/g)]
        .filter((m) => m[1] !== 'AppException')
        .map((m) => `${relative(root, file)}: new ${m[1]}(`);
    });
    expect(offenders).toEqual([]);
  });

  it('src/ never extends HttpException outside errors.ts', () => {
    const offenders = sourceFiles(root)
      .filter((file) => !file.endsWith(join('common', 'errors.ts')))
      .filter((file) =>
        /extends\s+HttpException/.test(readFileSync(file, 'utf8')),
      )
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });
});

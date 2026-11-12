/**
 * `pnpm api-docs`: one command for the whole API documentation.
 *
 *   1. `pnpm openapi:export` and `pnpm postman:export` (the repo's own scripts)
 *      rewrite the contract; any difference from what is committed is reported.
 *   2. The controllers' decorators are read (permissions, public, platform).
 *   3. The audience folders, READMEs and Postman collections are written under
 *      `docs/api/`.
 *
 * Flags: `--skip-export` uses the contract files as they are.
 * Needs no database: the exports build the module graph in preview mode. The
 * environment variables the app validates default to the placeholders of
 * `.env.example` when they are not set.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generate } from './generate';

const root = resolve(__dirname, '..', '..');
const OPENAPI = 'docs/api/openapi.v0.json';
const POSTMAN = 'docs/api/jiwar.postman_collection.json';
const ROUTES = join(root, 'node_modules', '.cache', 'api-docs', 'routes.json');

/** Placeholders from .env.example for what the app validates and is not set. */
function envWithExamples(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const example = join(root, '.env.example');
  if (!existsSync(example)) return env;
  for (const line of readFileSync(example, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || env[m[1]] !== undefined) continue;
    env[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return env;
}

/** Runs a package script with the same runner that started this one. */
function runScript(
  name: string,
  tsFile: string,
  env: NodeJS.ProcessEnv,
  args: string[] = [],
): void {
  const pnpm = process.env.npm_execpath;
  const viaPnpm = !!pnpm && /pnpm/i.test(pnpm) && args.length === 0;
  const cmd = process.execPath;
  const argv = viaPnpm
    ? [pnpm, 'run', name]
    : ['-r', 'ts-node/register/transpile-only', tsFile, ...args];
  const res = spawnSync(cmd, argv, { cwd: root, env, stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`${name} failed (exit ${res.status})`);
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function changed(file: string): boolean {
  const res = spawnSync('git', ['diff', '--quiet', '--', file], { cwd: root });
  return res.status !== 0;
}

function main(): void {
  const skipExport = process.argv.includes('--skip-export');
  const env = envWithExamples();
  const sha = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain', '--', 'src', 'prisma');
  if (dirty)
    console.warn(
      'warning: src/ or prisma/ has uncommitted changes; the docs describe the working tree',
    );

  let drift: string[] = [];
  if (!skipExport) {
    console.log('1/3 exporting the contract');
    runScript('openapi:export', 'src/openapi.cli.ts', env);
    runScript('postman:export', 'src/postman.cli.ts', env);
    drift = [OPENAPI, POSTMAN].filter(changed);
    console.log(
      drift.length
        ? `   DIFFERENT from the committed contract: ${drift.join(', ')}`
        : '   the contract equals the committed files',
    );
  }

  console.log('2/3 reading the controllers');
  runScript('extract-routes', 'scripts/api-docs/extract-routes.ts', env, [
    ROUTES,
  ]);

  console.log('3/3 writing the documentation');
  const result = generate({
    repoRoot: root,
    outDir: join(root, 'docs', 'api'),
    openapiFile: join(root, OPENAPI),
    routesFile: ROUTES,
    sha,
  });

  console.log(`\nmain@${sha}`);
  console.log(`${result.total} operations; ${result.placements} placements`);
  for (const [audience, n] of Object.entries(result.perAudience))
    console.log(`  ${audience.padEnd(11)} ${n}`);
  console.log(`${result.files.length} files written`);
  if (result.review.length) {
    console.log(`needs review (${result.review.length}):`);
    for (const r of result.review)
      console.log(`  ${r.op.method.toUpperCase()} ${r.op.path}: ${r.reason}`);
  }
  for (const { audience, op } of result.inOther) {
    console.log(
      `  no section: [${audience}] ${op.method.toUpperCase()} ${op.path} (tag ${op.tag})`,
    );
  }
  if (result.problems.length) {
    console.error('\nproblems:');
    for (const p of result.problems) console.error(`  ${p}`);
    process.exit(1);
  }
}

main();

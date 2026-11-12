/**
 * Step 3 of `pnpm api-docs`: reads the contract and the routes file, and
 * writes the audience folders, the Postman collections and the READMEs.
 * Pure of the app: it needs no database and loads no controller.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { AUDIENCES, type Audience } from './audiences';
import { dashboardCalls } from './dashboard-calls';
import { scanErrorStatuses } from './error-codes';
import { renderSection } from './markdown';
import {
  buildOperations,
  byAudience,
  type OpenApiDoc,
  type Operation,
  type RoutesFile,
} from './model';
import {
  authOperations,
  buildCollection,
  buildEnvironment,
  validateCollection,
} from './postman';
import {
  audienceReadme,
  rootReadme,
  type AudienceSummary,
  type SectionSummary,
} from './readme';
import { SchemaTools } from './schema';
import { SECTIONS, sectionFor } from './sections';

export interface GenerateOptions {
  repoRoot: string;
  /** Where the audience folders go, `docs/api` by default. */
  outDir: string;
  openapiFile: string;
  routesFile: string;
  sha: string;
}

export interface GenerateResult {
  total: number;
  placements: number;
  perAudience: Record<Audience, number>;
  files: string[];
  unplaced: Operation[];
  inOther: { audience: Audience; op: Operation }[];
  review: { op: Operation; reason: string }[];
  problems: string[];
}

function write(files: string[], file: string, content: string): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(
    file,
    content.endsWith('\n') ? content : content + '\n',
    'utf8',
  );
  files.push(file);
}

/** Removes the files an earlier run wrote in an audience folder. */
function clearGenerated(dir: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === 'README.md' || /^\d\d-[a-z0-9-]+\.md$/.test(name))
      unlinkSync(join(dir, name));
  }
}

export function generate(opts: GenerateOptions): GenerateResult {
  const doc = JSON.parse(readFileSync(opts.openapiFile, 'utf8')) as OpenApiDoc;
  const routes = JSON.parse(
    readFileSync(opts.routesFile, 'utf8'),
  ) as RoutesFile;
  const statuses = scanErrorStatuses(join(opts.repoRoot, 'src'));
  const tools = new SchemaTools(doc.components);
  const ops = buildOperations(
    doc,
    routes,
    statuses,
    dashboardCalls(join(opts.repoRoot, 'apps', 'manager')),
  );
  const grouped = byAudience(ops);

  const result: GenerateResult = {
    total: ops.length,
    placements: 0,
    perAudience: {} as Record<Audience, number>,
    files: [],
    unplaced: ops.filter((o) => o.classification.audiences.length === 0),
    inOther: [],
    review: ops
      .filter((o) => o.classification.needsReview)
      .map((o) => ({
        op: o,
        reason: o.classification.reviewReason ?? 'unclear',
      })),
    problems: [],
  };

  const summaries: AudienceSummary[] = [];
  const out = resolve(opts.outDir);

  for (const audience of AUDIENCES) {
    const audienceOps = grouped[audience] ?? [];
    result.perAudience[audience] = audienceOps.length;
    result.placements += audienceOps.length;
    const dir = join(out, audience);
    clearGenerated(dir);

    // Place each operation in the first section that takes it.
    const defs = SECTIONS[audience];
    const bySection = new Map<string, Operation[]>();
    for (const op of audienceOps) {
      const def = sectionFor(audience, {
        path: op.path,
        method: op.method,
        tag: op.tag,
      });
      if (def.slug === 'other') result.inOther.push({ audience, op });
      const list = bySection.get(def.slug) ?? [];
      list.push(op);
      bySection.set(def.slug, list);
    }

    const sections: SectionSummary[] = [];
    let n = 0;
    const folders: { title: string; description: string; ops: Operation[] }[] =
      [];
    const authOps = authOperations(audience, audienceOps);
    const authKeys = new Set(authOps.map((o) => o.key));
    for (const def of defs) {
      const secOps = bySection.get(def.slug) ?? [];
      if (secOps.length === 0) {
        sections.push({
          number: '',
          slug: def.slug,
          title: def.title,
          blurb: def.blurb,
          count: 0,
        });
        continue;
      }
      n += 1;
      const number = String(n).padStart(2, '0');
      sections.push({
        number,
        slug: def.slug,
        title: def.title,
        blurb: def.blurb,
        count: secOps.length,
      });
      write(
        result.files,
        join(dir, `${number}-${def.slug}.md`),
        renderSection(tools, {
          audience,
          number,
          slug: def.slug,
          title: def.title,
          blurb: def.blurb,
          notes: def.notes ?? [],
          ops: secOps,
          sha: opts.sha,
        }),
      );
      folders.push({
        title: def.title,
        description: def.blurb,
        ops: secOps.filter((o) => !authKeys.has(o.key)),
      });
    }

    const summary: AudienceSummary = { audience, ops: audienceOps, sections };
    summaries.push(summary);
    write(
      result.files,
      join(dir, 'README.md'),
      audienceReadme(summary, routes, opts.sha),
    );

    const collection = buildCollection(tools, {
      audience,
      sha: opts.sha,
      folders,
      authOps,
    });
    const problems = validateCollection(collection);
    for (const p of problems) result.problems.push(`${audience}: ${p}`);
    write(
      result.files,
      join(out, 'postman', `${audience}.postman_collection.json`),
      JSON.stringify(collection, null, 2),
    );
  }

  write(
    result.files,
    join(out, 'postman', 'jiwar.postman_environment.json'),
    JSON.stringify(buildEnvironment(opts.sha), null, 2),
  );
  write(
    result.files,
    join(out, 'README.md'),
    rootReadme({
      sha: opts.sha,
      total: result.total,
      audiences: summaries,
      review: result.review,
      placements: result.placements,
      contractDrift: null,
    }),
  );

  if (result.unplaced.length) {
    result.problems.push(
      `${result.unplaced.length} operations have no audience`,
    );
  }
  if (result.inOther.length) {
    result.problems.push(
      `${result.inOther.length} placements fell in an "Other" section`,
    );
  }
  return result;
}

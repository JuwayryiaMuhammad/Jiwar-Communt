// ============================================================================
// Migrations under FORCE RLS (ADR 0061)
// ============================================================================
//
// `prisma migrate deploy` runs as jiwar_migrator: the tables' owner, not a
// superuser, without BYPASSRLS. On a table with FORCE ROW LEVEL SECURITY the
// policies hold for the owner too, so a migration's UPDATE, INSERT or DELETE
// there sees no compound unless it sets `app.tenant_id` first: an UPDATE
// silently matches no row, an INSERT is refused. Two migrations reached main
// that way (20261104091000, 20261108090000). This reads every migration in
// order and refuses such a statement outside a loop that sets the compound,
// unless it is marked with a reason. Pure: the CLI and the spec feed it.

export interface MigrationFile {
  /** The migration's directory name, e.g. `20261113090000_guard_…`. */
  name: string;
  sql: string;
}

/** `<migration>:<line>` → why the statement is safe or historic. */
export type BareDmlAllow = Record<string, string>;

export interface Finding {
  migration: string;
  line: number;
  verb: 'UPDATE' | 'INSERT' | 'DELETE';
  table: string;
  /** `bare`: unscoped and unmarked; `empty-reason`: marked without a reason. */
  problem: 'bare' | 'empty-reason';
}

export interface ScanResult {
  findings: Finding[];
  /** Allowlist keys that match no unscoped statement any more. */
  stale: string[];
  /** Every table under FORCE RLS after the last migration, sorted. */
  forced: string[];
}

/** The in-file marker, on the line just above the statement. */
export const MARKER = 'rls-dml-allow:';

type BlockKind = 'do' | 'function' | 'other';

interface Block {
  start: number;
  end: number;
  kind: BlockKind;
}

interface Lexed {
  /** The text with comments and string literals blanked, offsets kept. */
  masked: string;
  /** Top-level dollar-quoted bodies, by what holds them. */
  blocks: Block[];
  /** Line (1-based) → the marker's reason, from `-- rls-dml-allow: …`. */
  markers: Map<number, string>;
}

const blank = (s: string) => s.replace(/[^\n]/g, ' ');

/**
 * Comments and quoted strings blanked (newlines kept, so offsets and lines
 * hold), identifiers in double quotes kept. A dollar-quoted body at the top
 * is code (a DO block or a function); one inside a body is a string.
 */
function lex(sql: string): Lexed {
  const out: string[] = [];
  const blocks: Block[] = [];
  const markers = new Map<number, string>();
  const lineAt = (i: number) => sql.slice(0, i).split('\n').length;
  let i = 0;
  let open: { tag: string; start: number } | null = null;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      const text = sql.slice(i + 2, stop).trim();
      if (text.startsWith(MARKER))
        markers.set(lineAt(i), text.slice(MARKER.length).trim());
      out.push(blank(sql.slice(i, stop)));
      i = stop;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out.push(blank(sql.slice(i, stop)));
      i = stop;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      out.push(blank(sql.slice(i, j + 1)));
      i = j + 1;
      continue;
    }
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      if (open && tag === open.tag) {
        blocks.push({ start: open.start, end: i, kind: 'other' });
        open = null;
        out.push(tag);
        i += tag.length;
        continue;
      }
      if (open) {
        // A dollar-quoted string inside a body: blanked to its close.
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        out.push(blank(sql.slice(i, stop)));
        i = stop;
        continue;
      }
      open = { tag, start: i + tag.length };
      out.push(tag);
      i += tag.length;
      continue;
    }
    out.push(sql[i]);
    i++;
  }
  const masked = out.join('');
  for (const b of blocks) {
    // The statement that holds the body: back to the previous `;`.
    const before = masked.slice(0, b.start);
    const stmt = before.slice(before.lastIndexOf(';') + 1);
    if (/\bDO\s+(LANGUAGE\s+\w+\s+)?\$[A-Za-z0-9_]*\$$/i.test(stmt))
      b.kind = 'do';
    else if (/\bCREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\b/i.test(stmt))
      b.kind = 'function';
  }
  return { masked, blocks, markers };
}

interface ForceEvent {
  at: number;
  table: string;
  forced: boolean;
}

/** Where the file forces or unforces RLS, by offset, in its two forms. */
function forceEvents(sql: string, masked: string): ForceEvent[] {
  const events: ForceEvent[] = [];
  const direct =
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:"?public"?\.)?"?(\w+)"?\s+(NO\s+)?FORCE\s+ROW\s+LEVEL\s+SECURITY/gi;
  for (const m of masked.matchAll(direct))
    events.push({ at: m.index, table: m[1], forced: !m[2] });
  // FOREACH t IN ARRAY ARRAY['a', 'b'] LOOP … format('ALTER TABLE %I FORCE …') …
  const loop =
    /FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\s*\[([^\]]*)\]\s*LOOP([\s\S]*?)END\s+LOOP/gi;
  for (const m of sql.matchAll(loop)) {
    const body = m[2];
    if (!/FORCE\s+ROW\s+LEVEL\s+SECURITY/i.test(body)) continue;
    const forced = !/NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i.test(body);
    for (const t of m[1].matchAll(/'(\w+)'/g))
      events.push({ at: m.index, table: t[1], forced });
  }
  return events.sort((a, b) => a.at - b.at);
}

/** Inside a DO block: is the statement in a loop that set the compound? */
function scopedInDo(
  sql: string,
  masked: string,
  b: Block,
  at: number,
): boolean {
  const loops: number[] = [];
  const tokens = /\bEND\s+LOOP\b|\bLOOP\b/gi;
  const inner = masked.slice(b.start, at);
  for (const m of inner.matchAll(tokens)) {
    if (/^END/i.test(m[0])) loops.pop();
    else loops.push(b.start + m.index + m[0].length);
  }
  const sets = /set_config\(\s*'app\.tenant_id'\s*,\s*(?!''\s*,)/i;
  return loops.some((start) => sets.test(sql.slice(start, at)));
}

const DML =
  /\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:ONLY\s+)?(?:"?public"?\.)?"?(\w+)"?/gi;

/**
 * Every UPDATE, INSERT or DELETE on a table under FORCE RLS (at that point
 * of the history) that is neither in a DO block's loop setting
 * `app.tenant_id` nor in a function body (which runs later, as the app),
 * and is neither marked nor allowlisted.
 */
export function scanMigrations(
  files: readonly MigrationFile[],
  allow: BareDmlAllow = {},
): ScanResult {
  const forced = new Set<string>();
  const findings: Finding[] = [];
  const used = new Set<string>();
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const { masked, blocks, markers } = lex(f.sql);
    const events = forceEvents(f.sql, masked);
    let e = 0;
    for (const m of masked.matchAll(DML)) {
      const at = m.index;
      for (; e < events.length && events[e].at < at; e++)
        if (events[e].forced) forced.add(events[e].table);
        else forced.delete(events[e].table);
      const table = m[2];
      if (!forced.has(table)) continue;
      const block = blocks.find((b) => b.start <= at && at < b.end);
      if (block?.kind === 'function') continue;
      if (block?.kind === 'do' && scopedInDo(f.sql, masked, block, at))
        continue;
      const line = masked.slice(0, at).split('\n').length;
      const verb = m[1].split(/\s+/)[0].toUpperCase() as Finding['verb'];
      const key = `${f.name}:${line}`;
      if (key in allow) {
        used.add(key);
        if (!allow[key].trim())
          findings.push({
            migration: f.name,
            line,
            verb,
            table,
            problem: 'empty-reason',
          });
        continue;
      }
      const marker = markers.get(line - 1);
      if (marker === undefined)
        findings.push({
          migration: f.name,
          line,
          verb,
          table,
          problem: 'bare',
        });
      else if (!marker)
        findings.push({
          migration: f.name,
          line,
          verb,
          table,
          problem: 'empty-reason',
        });
    }
    for (; e < events.length; e++)
      if (events[e].forced) forced.add(events[e].table);
      else forced.delete(events[e].table);
  }
  return {
    findings,
    stale: Object.keys(allow).filter((k) => !used.has(k)),
    forced: [...forced].sort(),
  };
}

/**
 * `prisma/migrations-rls-allow.json` (ADR 0061): the reasoned exceptions
 * for migrations already applied, which are never edited — their stored
 * checksum would change. A new migration marks its own statement instead.
 */
export interface MigrationsAllow {
  /** `<migration>:<line>` → why that unscoped statement is acceptable. */
  bareDml: BareDmlAllow;
  /**
   * A migration that removes seeded rows on purpose (a dedupe, a purge):
   * the tables it may shrink in the migrate-with-data job, and why.
   */
  rowsRemoved: Record<string, { tables: string[]; reason: string }>;
}

/** What is wrong with the allowlist itself, against the migrations there are. */
export function allowProblems(
  allow: MigrationsAllow,
  migrations: readonly string[],
): string[] {
  const known = new Set(migrations);
  const problems: string[] = [];
  for (const [key, reason] of Object.entries(allow.bareDml)) {
    if (!/^[^:]+:\d+$/.test(key))
      problems.push(`bareDml ${key}: not <migration>:<line>`);
    else if (!known.has(key.split(':')[0]))
      problems.push(`bareDml ${key}: no such migration`);
    if (!reason.trim()) problems.push(`bareDml ${key}: no reason`);
  }
  for (const [name, entry] of Object.entries(allow.rowsRemoved)) {
    if (!known.has(name))
      problems.push(`rowsRemoved ${name}: no such migration`);
    if (!entry.reason?.trim()) problems.push(`rowsRemoved ${name}: no reason`);
    if (!Array.isArray(entry.tables) || !entry.tables.length)
      problems.push(`rowsRemoved ${name}: no tables`);
  }
  return problems;
}

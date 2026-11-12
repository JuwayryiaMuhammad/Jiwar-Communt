/**
 * Which HTTP status each error code is thrown with, read from the source
 * (`appError.conflict(ErrorCode.X, ...)` and friends). The contract names the
 * codes only inside descriptions; this gives each its status.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const KIND_STATUS: Record<string, number> = {
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  unprocessable: 422,
  tooManyRequests: 429,
  serviceUnavailable: 503,
  badGateway: 502,
};

const HTTP_STATUS_NAME: Record<string, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  SERVICE_UNAVAILABLE: 503,
};

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) {
      yield* sourceFiles(full);
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
      yield full;
    }
  }
}

export function scanErrorStatuses(srcDir: string): Map<string, number[]> {
  const found = new Map<string, Set<number>>();
  const add = (code: string, status: number) => {
    if (!found.has(code)) found.set(code, new Set());
    found.get(code)!.add(status);
  };
  const viaHelper =
    /appError\.(\w+)\(\s*(?:ErrorCode\.)?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)/g;
  const viaClass =
    /new AppException\(\s*HttpStatus\.(\w+)\s*,\s*(?:ErrorCode\.)?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)/g;
  for (const file of sourceFiles(srcDir)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(viaHelper)) {
      const status = KIND_STATUS[m[1]];
      if (status) add(m[2], status);
    }
    for (const m of text.matchAll(viaClass)) {
      const status = HTTP_STATUS_NAME[m[1]];
      if (status) add(m[2], status);
    }
  }
  return new Map([...found].map(([code, set]) => [code, [...set].sort()]));
}

/** Codes written in a description, with the sentence they appear in. */
export function codesInDescription(
  description: string | undefined,
  known: Map<string, number[]>,
  registry: Set<string>,
): { code: string; statuses: number[]; context: string }[] {
  if (!description) return [];
  const out = new Map<
    string,
    { code: string; statuses: number[]; context: string }
  >();
  // Sentences: split on a full stop followed by a space and a capital/backtick.
  const sentences = description.split(/(?<=[.;])\s+(?=[A-Z`(])/);
  const re = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;
  for (const sentence of sentences) {
    for (const m of sentence.matchAll(re)) {
      const code = m[1];
      if (out.has(code) || !registry.has(code)) continue;
      // An explicit status next to the code: "(409 CODE)" or "422 CODE".
      const near = new RegExp(`\\b(\\d{3})\\s+${code}\\b`).exec(sentence);
      const statuses = near ? [Number(near[1])] : (known.get(code) ?? []);
      out.set(code, { code, statuses, context: sentence.trim() });
    }
  }
  return [...out.values()];
}

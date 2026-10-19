import { createHash } from 'node:crypto';
import type { Incident } from '@prisma/client';

/**
 * What an incident signature signs (ADR 0056): the report's canonical
 * content for the signer's role, version 1.
 *
 * - **author**: the report itself — its number, type, severity, place,
 *   unit, when it happened, its words, its author, its links, when it was
 *   reported — and the ids of its photos, recordings and evidence.
 * - **reviewer**: all of that, and its status, outcome and closing note.
 *
 * So closing the incident never supersedes the author's signature, and any
 * change inside a scope supersedes the signatures over that scope: evidence
 * linked later supersedes both; an assignment or a close, the reviewer's.
 * Ids are sorted; keys are sorted at every level; instants are ISO-8601 in
 * UTC with milliseconds; absent is null. The hash is SHA-256 of that JSON
 * in UTF-8, in lower-case hex.
 */
export const CANONICAL_VERSION = 1;

export const SIGNATURE_ROLES = ['author', 'reviewer'] as const;
export type SignatureRole = (typeof SIGNATURE_ROLES)[number];

export interface SignedMaterial {
  incident: Pick<
    Incident,
    | 'id'
    | 'number'
    | 'type'
    | 'severity'
    | 'placeId'
    | 'unitId'
    | 'occurredAt'
    | 'description'
    | 'reportedById'
    | 'emergencyId'
    | 'gateServiceRequestId'
    | 'patrolNoteId'
    | 'createdAt'
    | 'status'
    | 'outcome'
    | 'closingNote'
  >;
  photoFileIds: readonly string[];
  mediaFileIds: readonly string[];
  evidenceIds: readonly string[];
}

/** JSON with every object's keys sorted, instants as ISO strings. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}

/** The content a role signs, as an object. */
export function scopeOf(role: SignatureRole, m: SignedMaterial): object {
  const i = m.incident;
  const author = {
    version: CANONICAL_VERSION,
    scope: 'author',
    incident: {
      id: i.id,
      number: i.number,
      type: i.type,
      severity: i.severity,
      placeId: i.placeId,
      unitId: i.unitId,
      occurredAt: i.occurredAt,
      description: i.description,
      reportedById: i.reportedById,
      links: {
        emergencyId: i.emergencyId,
        gateServiceRequestId: i.gateServiceRequestId,
        patrolNoteId: i.patrolNoteId,
      },
      reportedAt: i.createdAt,
    },
    photoFileIds: [...m.photoFileIds].sort(),
    mediaFileIds: [...m.mediaFileIds].sort(),
    evidenceIds: [...m.evidenceIds].sort(),
  };
  if (role === 'author') return author;
  return {
    ...author,
    scope: 'reviewer',
    review: {
      status: i.status,
      outcome: i.outcome,
      closingNote: i.closingNote,
    },
  };
}

/** The SHA-256, in hex, of a role's canonical content. */
export const contentSha256 = (role: SignatureRole, m: SignedMaterial): string =>
  createHash('sha256')
    .update(canonicalJson(scopeOf(role, m)), 'utf8')
    .digest('hex');

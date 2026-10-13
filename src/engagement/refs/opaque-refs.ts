import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../core/config/env.schema';

/**
 * `HMAC-SHA256(key, label ‖ parts)`, 32 bytes. The label keeps one kind of
 * reference from ever equalling another; a part never contains `:` (they
 * are UUIDs and hex), so the joined message is unambiguous.
 */
export function deriveRef(key: string, label: string, ...parts: string[]): Ref {
  return new Uint8Array(
    createHmac('sha256', key)
      .update([label, ...parts].join(':'))
      .digest(),
  );
}

/** A reference as the database's `bytea` column takes it. */
export type Ref = Uint8Array<ArrayBuffer>;

export const sameRef = (a: Uint8Array, b: Uint8Array): boolean =>
  Buffer.compare(a, b) === 0;

/**
 * The opaque references of the community life (ADR 0040). Each stands for
 * a subject (an account, a unit) in a row that must not name it:
 *
 * - a read mark says "this one read it", so readers can be counted and a
 *   reader told so, and no list of readers can be made;
 * - a ballot reference says "these choices are one unit's", so a vote can
 *   be changed, and no query can tell whose they are.
 *
 * The key is ENGAGEMENT_REF_SECRET, which lives in the environment and
 * never in the database: what the database holds is not enough to go from
 * a subject to its reference or back.
 */
@Injectable()
export class OpaqueRefs {
  private readonly key: string;

  constructor(config: ConfigService<Env, true>) {
    this.key = config.get('ENGAGEMENT_REF_SECRET', { infer: true });
  }

  /** An account's, or a unit's, mark on one announcement. */
  readMark(
    kind: 'account' | 'unit',
    announcementId: string,
    subjectId: string,
  ): Ref {
    return deriveRef(this.key, `read:${kind}`, announcementId, subjectId);
  }

  /**
   * A unit's ballot in one poll. The poll's salt is part of it and is
   * destroyed when the poll closes: from then on nobody, with or without
   * the key, can derive it again.
   */
  ballot(salt: Uint8Array, pollId: string, unitId: string): Ref {
    return deriveRef(
      this.key,
      'ballot',
      Buffer.from(salt).toString('hex'),
      pollId,
      unitId,
    );
  }
}

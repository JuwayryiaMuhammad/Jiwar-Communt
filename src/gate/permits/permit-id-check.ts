import { Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { IdentifierHasher } from '../../core/auth/identifier';
import { RateLimitService } from '../../core/redis/rate-limit.service';

/**
 * The lockout on a contractor worker's ID check (ADR 0049): five wrong
 * last-fours lock the guard out for 15 minutes, ten lock the worker out for
 * a day. Counted in Redis, so a refusal that rolls the entry back still
 * counts. The management lifts either from the permit's detail.
 */
export const ID_CHECK_LIMITS = {
  guard: { limit: 5, windowSeconds: 15 * 60 },
  worker: { limit: 10, windowSeconds: 24 * 3600 },
} as const;

/**
 * A contractor worker's ID last four (ADR 0049): stored only as a keyed
 * hash, compared in constant time, and the failures counted per guard and
 * per worker.
 */
@Injectable()
export class PermitIdCheck {
  constructor(
    private readonly hasher: IdentifierHasher,
    private readonly rateLimit: RateLimitService,
  ) {}

  hash(tenantId: string, workerId: string, last4: string): string {
    return this.hasher.hashPermitWorkerIdLast4(
      tenantId,
      workerId,
      last4.trim().toUpperCase(),
    );
  }

  /** Whether the typed last four are the worker's: in constant time. */
  matches(
    tenantId: string,
    worker: { id: string; idLast4Hash: string | null },
    last4: string,
  ): boolean {
    if (!worker.idLast4Hash) return false;
    const typed = Buffer.from(this.hash(tenantId, worker.id, last4), 'hex');
    const stored = Buffer.from(worker.idLast4Hash, 'hex');
    return typed.length === stored.length && timingSafeEqual(typed, stored);
  }

  /** Who is locked out, the guard first; null when neither is. */
  async lockedOut(
    tenantId: string,
    guardId: string,
    workerId: string,
  ): Promise<'guard' | 'worker' | null> {
    if (await this.isLocked('guard', tenantId, guardId)) return 'guard';
    if (await this.isLocked('worker', tenantId, workerId)) return 'worker';
    return null;
  }

  /** A wrong last four: one failure for the guard and one for the worker. */
  async failed(
    tenantId: string,
    guardId: string,
    workerId: string,
  ): Promise<void> {
    await this.rateLimit.hit(
      key('guard', tenantId, guardId),
      ID_CHECK_LIMITS.guard.windowSeconds,
    );
    await this.rateLimit.hit(
      key('worker', tenantId, workerId),
      ID_CHECK_LIMITS.worker.windowSeconds,
    );
  }

  /** Those of `ids` locked out now. */
  async locked(
    scope: 'guard' | 'worker',
    tenantId: string,
    ids: readonly string[],
  ): Promise<string[]> {
    const out: string[] = [];
    for (const id of ids)
      if (await this.isLocked(scope, tenantId, id)) out.push(id);
    return out;
  }

  /** Lifts a lockout (and forgets the failures so far). */
  clear(scope: 'guard' | 'worker', tenantId: string, id: string) {
    return this.rateLimit.reset(key(scope, tenantId, id));
  }

  private isLocked(scope: 'guard' | 'worker', tenantId: string, id: string) {
    return this.rateLimit.exceeded(
      key(scope, tenantId, id),
      ID_CHECK_LIMITS[scope].limit - 1,
    );
  }
}

const key = (scope: 'guard' | 'worker', tenantId: string, id: string) =>
  `permit-id-fail:${scope}:${tenantId}:${id}`;

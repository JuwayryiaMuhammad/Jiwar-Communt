import { createHash } from 'node:crypto';

/**
 * The backend rotates the refresh token on every use and revokes the whole
 * session when an old or concurrently-rotated secret comes back (ADR 0004:
 * reuse detection). A dashboard fires several requests at once, so the BFF
 * must never refresh the same token twice:
 *
 * - in flight: concurrent callers with the same refresh token share one
 *   backend call;
 * - grace: for GRACE_MS after it settles, a caller still holding the old
 *   token (its browser had not yet received the new cookie) gets the same
 *   result instead of replaying the rotated secret.
 *
 * State is per server process. Run one BFF instance per app, or route a
 * session to one instance, until refresh moves to a shared store.
 */
const GRACE_MS = 30_000;

interface Entry<T> {
  promise: Promise<T>;
  settledAt?: number;
}

export class SingleFlight<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly graceMs: number;

  constructor(graceMs = GRACE_MS) {
    this.graceMs = graceMs;
  }

  run(key: string, work: () => Promise<T>, now = Date.now()): Promise<T> {
    this.prune(now);
    const id = createHash('sha256').update(key).digest('hex');
    const existing = this.entries.get(id);
    if (existing) return existing.promise;
    const entry: Entry<T> = {
      promise: work().finally(() => {
        entry.settledAt = Date.now();
      }),
    };
    this.entries.set(id, entry);
    return entry.promise;
  }

  private prune(now: number) {
    for (const [id, entry] of this.entries) {
      if (entry.settledAt !== undefined && now - entry.settledAt > this.graceMs) {
        this.entries.delete(id);
      }
    }
  }
}

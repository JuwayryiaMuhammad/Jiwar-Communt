import { OutboxProcessor } from '../../src/core/mail/outbox-processor';
import type { HttpHarness } from './http-app';

/**
 * Delivers everything due in the outbox, now. The poller is disabled in
 * tests (OUTBOX_ENABLED=false), so suites drain explicitly (ADR 0019).
 */
export async function drainOutbox(h: HttpHarness, now = new Date()) {
  const processor = h.moduleRef.get(OutboxProcessor);
  for (;;) {
    const run = await processor.processDue(now);
    if (run.sent + run.retried + run.dead === 0) return;
  }
}

import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { Env } from '../config/env.schema';
import {
  GlobalDbService,
  type ClaimedOutboxMessage,
} from '../database/global-db.service';
import { EmailTemplates } from './email-templates';
import { Mailer } from './mailer';

const BATCH_SIZE = 20;
/** Long enough for a batch of sends; an expired lease is claimed again. */
export const LEASE_MS = 60_000;
const PURGE_EVERY_MS = 60 * 60_000;
const MINUTE = 60_000;
/** After attempt n fails, the next one waits BACKOFF[n - 1] (the last repeats). */
export const BACKOFF_MS = [
  1 * MINUTE,
  5 * MINUTE,
  30 * MINUTE,
  120 * MINUTE,
  360 * MINUTE,
];

export interface OutboxRun {
  sent: number;
  retried: number;
  dead: number;
}

/**
 * Delivers the outbox (ADR 0019), in the app, with no extra
 * infrastructure. Each run:
 * 1. claims due messages in one short statement (SKIP LOCKED, with a lease)
 *    — several instances never send the same message at the same time;
 * 2. renders and sends each OUTSIDE any transaction, with the message id
 *    as a stable Message-ID (delivery is at least once);
 * 3. marks it sent, or schedules a retry (1m → 5m → 30m → 2h → 6h), or
 *    after OUTBOX_MAX_ATTEMPTS marks it dead and logs the id and the error
 *    code — never the recipient or the body.
 * At most hourly it deletes sent rows past OUTBOX_RETENTION_DAYS and
 * strips the personal data of dead ones (they stay, as evidence that a
 * notice never arrived).
 */
@Injectable()
export class OutboxProcessor
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxProcessor.name);
  private readonly enabled: boolean;
  private readonly pollMs: number;
  private readonly maxAttempts: number;
  private readonly retentionMs: number;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<unknown> | null = null;
  private stopping = false;
  private lastPurge = 0;

  constructor(
    config: ConfigService<Env, true>,
    private readonly globalDb: GlobalDbService,
    private readonly templates: EmailTemplates,
    private readonly mailer: Mailer,
  ) {
    this.enabled = config.get('OUTBOX_ENABLED', { infer: true });
    this.pollMs = config.get('OUTBOX_POLL_MS', { infer: true });
    this.maxAttempts = config.get('OUTBOX_MAX_ATTEMPTS', { infer: true });
    this.retentionMs =
      config.get('OUTBOX_RETENTION_DAYS', { infer: true }) * 24 * 60 * MINUTE;
  }

  onApplicationBootstrap(): void {
    if (this.enabled) this.schedule();
  }

  /** Stops polling and waits for the run in progress. */
  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.current;
  }

  /** Whether the poller is scheduled (for tests and health). */
  get polling(): boolean {
    return this.timer !== null || this.current !== null;
  }

  private schedule(): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.current = this.tick().finally(() => {
        this.current = null;
        this.schedule();
      });
    }, this.pollMs);
  }

  private async tick(): Promise<void> {
    try {
      await this.processDue();
      if (Date.now() - this.lastPurge >= PURGE_EVERY_MS) {
        this.lastPurge = Date.now();
        await this.purge();
      }
    } catch (error) {
      this.logger.error(`outbox run failed (${errorCode(error)})`);
    }
  }

  /** One delivery run. `now` is a parameter so tests can move time. */
  async processDue(now: Date = new Date()): Promise<OutboxRun> {
    const run: OutboxRun = { sent: 0, retried: 0, dead: 0 };
    const claimed = await this.globalDb.claimOutbox(BATCH_SIZE, LEASE_MS, now);
    for (const message of claimed) {
      run[await this.deliver(message, now)] += 1;
    }
    return run;
  }

  private async deliver(
    message: ClaimedOutboxMessage,
    now: Date,
  ): Promise<keyof OutboxRun> {
    const lease = {
      id: message.id,
      status: 'processing' as const,
      lockedUntil: message.lockedUntil,
    };
    const render = this.templates.get(message.templateKey);
    if (!render) {
      // Retrying cannot help: the code that could render it is gone.
      await this.markDead(message, 'UNKNOWN_TEMPLATE');
      return 'dead';
    }
    try {
      await this.mailer.send(
        message.recipient,
        render(message.locale, message.params),
        { messageId: this.mailer.messageIdFor(`outbox-${message.id}`) },
      );
    } catch (error) {
      const attempts = message.attempts + 1;
      const code = errorCode(error);
      if (attempts >= this.maxAttempts) {
        await this.markDead({ ...message, attempts }, code);
        return 'dead';
      }
      await this.globalDb.outboxMessage.updateMany({
        where: lease,
        data: {
          status: 'pending',
          attempts,
          lastErrorCode: code,
          lockedUntil: null,
          nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
        },
      });
      return 'retried';
    }
    await this.globalDb.outboxMessage.updateMany({
      where: lease,
      data: {
        status: 'sent',
        sentAt: new Date(),
        lockedUntil: null,
        attempts: message.attempts + 1,
      },
    });
    return 'sent';
  }

  private async markDead(message: ClaimedOutboxMessage, code: string) {
    await this.globalDb.outboxMessage.updateMany({
      where: {
        id: message.id,
        status: 'processing',
        lockedUntil: message.lockedUntil,
      },
      data: {
        status: 'dead',
        attempts: message.attempts,
        lastErrorCode: code,
        lockedUntil: null,
      },
    });
    // The id and the code only: never the recipient or the body.
    this.logger.error(`outbox message ${message.id} is dead (${code})`);
  }

  /**
   * Retention (ADR 0019): sent rows older than OUTBOX_RETENTION_DAYS are
   * deleted; dead rows that old keep their evidence (template, tenant,
   * timestamps, attempts, error code) but lose the recipient and params.
   */
  async purge(
    now: Date = new Date(),
  ): Promise<{ deleted: number; stripped: number }> {
    const before = new Date(now.getTime() - this.retentionMs);
    const deleted = await this.globalDb.outboxMessage.deleteMany({
      where: { status: 'sent', sentAt: { lt: before } },
    });
    const stripped = await this.globalDb.outboxMessage.updateMany({
      where: { status: 'dead', strippedAt: null, createdAt: { lt: before } },
      data: { recipient: null, params: Prisma.DbNull, strippedAt: now },
    });
    return { deleted: deleted.count, stripped: stripped.count };
  }
}

export function backoffMs(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1];
}

/** A loggable reason with no content: an SMTP/network code or the class. */
function errorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'UNKNOWN';
  const e = error as { code?: unknown; responseCode?: unknown; name?: unknown };
  if (typeof e.code === 'string') return e.code;
  if (typeof e.responseCode === 'number') return `SMTP_${e.responseCode}`;
  return typeof e.name === 'string' ? e.name : 'UNKNOWN';
}

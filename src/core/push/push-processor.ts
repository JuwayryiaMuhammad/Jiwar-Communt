import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../common/cls/app-cls';
import type { Env } from '../config/env.schema';
import {
  GlobalDbService,
  type ClaimedPushDelivery,
} from '../database/global-db.service';
import { TenantTx } from '../database/tenant-tx.service';
import {
  NOTIFICATION_KINDS,
  type NotificationKind,
  type NotificationParams,
} from '../notifications/kinds';
import { SweepRunner } from '../sweep/sweep-runner';
import { renderPush } from './push-texts';
import {
  PUSH_TRANSPORT,
  type PushMessage,
  type PushResult,
  type PushTransport,
} from './push-transport';

const BATCH_SIZE = 20;
/**
 * Renewed before every send, so it only has to outlast ONE request (the
 * transport gives up after 10 s). A lease that still runs out means the
 * sender died mid-send.
 */
export const PUSH_LEASE_MS = 60_000;
const SECOND = 1000;
/** After attempt n fails, the next one waits BACKOFF[n - 1] (the last repeats). */
export const PUSH_BACKOFF_MS = [
  30 * SECOND,
  2 * 60 * SECOND,
  10 * 60 * SECOND,
  30 * 60 * SECOND,
  120 * 60 * SECOND,
];
/** Finished rows (sent or given up) are deleted after this. */
export const PUSH_RETENTION_MS = 7 * 24 * 3600 * SECOND;
export const PUSH_RETENTION_SWEEP = 'push.retention';

export interface PushRun {
  sent: number;
  retried: number;
  /** Given up: out of attempts, refused, or of unknown outcome. */
  dead: number;
  /** Nothing to send any more: the device or the notification is gone. */
  dropped: number;
}

type Outcome = keyof PushRun;

/** Everything one send needs, read just before it. */
interface Prepared {
  message: PushMessage;
}

/**
 * Sends the push outbox (ADR 0041), in the app, like OutboxProcessor. Each
 * run:
 * 1. retires deliveries whose lease ran out (their sender died mid-send:
 *    the outcome is unknown, so they are NOT sent again);
 * 2. claims due rows in one statement (SKIP LOCKED, a lease, the attempt
 *    counted in the claim): two instances never hold the same row;
 * 3. for each: reads the notification as it is NOW (scrubbed params stay
 *    scrubbed, an erased one is gone) and checks that the device's session
 *    and account are still good — otherwise the device is deleted — then
 *    renews the lease and sends, outside any transaction;
 * 4. records the answer: sent; the token deleted when FCM says it is dead;
 *    a retry (30 s → 2 m → 10 m → 30 m → 2 h) when FCM did not take the
 *    message; given up after PUSH_MAX_ATTEMPTS, on a refused payload, or
 *    when no answer came back.
 *
 * At most once per notification and device: one row (a unique index), one
 * claimant (the lease fences every write), and no second send unless the
 * provider answered that the first did not go.
 *
 * Logs carry ids and codes only: never a token, a title or a body.
 */
@Injectable()
export class PushProcessor
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(PushProcessor.name);
  private readonly enabled: boolean;
  private readonly pollMs: number;
  private readonly maxAttempts: number;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<unknown> | null = null;
  private stopping = false;

  constructor(
    config: ConfigService<Env, true>,
    private readonly globalDb: GlobalDbService,
    private readonly tenantTx: TenantTx,
    private readonly cls: ClsService<AppClsStore>,
    private readonly sweep: SweepRunner,
    @Inject(PUSH_TRANSPORT) private readonly transport: PushTransport | null,
  ) {
    this.enabled = config.get('PUSH_ENABLED', { infer: true });
    this.pollMs = config.get('PUSH_POLL_MS', { infer: true });
    this.maxAttempts = config.get('PUSH_MAX_ATTEMPTS', { infer: true });
  }

  onModuleInit(): void {
    this.sweep.register(PUSH_RETENTION_SWEEP, (now) => this.purge(now));
  }

  onApplicationBootstrap(): void {
    if (!this.transport) {
      this.logger.warn(
        'Push delivery is disabled: FCM_PROJECT_ID / FCM_SERVICE_ACCOUNT are not set.',
      );
      return;
    }
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
    } catch (error) {
      this.logger.error(`push run failed (${errorName(error)})`);
    }
  }

  /**
   * One delivery run. `now` is a parameter so tests can move time; a real
   * run reads the clock again before each send.
   */
  async processDue(now?: Date): Promise<PushRun> {
    const run: PushRun = { sent: 0, retried: 0, dead: 0, dropped: 0 };
    const transport = this.transport;
    if (!transport) return run;
    const clock = () => now ?? new Date();
    for (const id of await this.globalDb.retireExpiredPush(clock())) {
      this.logDead(id, 'LEASE_EXPIRED');
      run.dead += 1;
    }
    const claimed = await this.globalDb.claimPush(
      BATCH_SIZE,
      PUSH_LEASE_MS,
      clock(),
    );
    for (const delivery of claimed) {
      try {
        run[await this.deliver(transport, delivery, clock)] += 1;
      } catch (error) {
        // Left in processing: its lease runs out and it is retired. Whether
        // it was sent is not known here, so it must not be sent again.
        this.logger.error(
          `push delivery ${delivery.id} failed (${errorName(error)})`,
        );
        run.dead += 1;
      }
    }
    return run;
  }

  private async deliver(
    transport: PushTransport,
    delivery: ClaimedPushDelivery,
    clock: () => Date,
  ): Promise<Outcome> {
    let prepared: Prepared | null;
    try {
      prepared = await this.prepare(delivery, clock());
    } catch (error) {
      // Nothing was sent yet: it goes back in the queue.
      return this.retryOrDie(delivery, errorName(error), clock());
    }
    if (!prepared) return 'dropped';

    // The lease covers this one send from here; whoever lost it (a run
    // slower than its lease) does not send.
    const lockedUntil = new Date(clock().getTime() + PUSH_LEASE_MS);
    const renewed = await this.globalDb.pushDelivery.updateMany({
      where: this.lease(delivery),
      data: { lockedUntil },
    });
    if (!renewed.count) return 'dropped';
    const held = { ...delivery, lockedUntil };

    const result = await this.send(transport, prepared.message);
    if (result.ok) {
      const at = clock();
      await this.globalDb.pushDelivery.updateMany({
        where: this.lease(held),
        data: { status: 'sent', sentAt: at, lockedUntil: null },
      });
      await this.globalDb.pushDevice.updateMany({
        where: { id: delivery.deviceId },
        data: { lastUsedAt: at },
      });
      return 'sent';
    }
    if (result.kind === 'token') {
      // The token is dead: the device goes, and its queue with it.
      await this.globalDb.pushDevice.deleteMany({
        where: { id: delivery.deviceId },
      });
      this.logger.warn(
        `push device ${delivery.deviceId} removed (${result.code})`,
      );
      return 'dropped';
    }
    if (result.kind === 'transient')
      return this.retryOrDie(held, result.code, clock(), result.retryAfterMs);
    return this.die(held, result.code);
  }

  /** The message did not go: later, unless the attempts are used up. */
  private async retryOrDie(
    held: ClaimedPushDelivery,
    code: string,
    now: Date,
    retryAfterMs = 0,
  ): Promise<Outcome> {
    if (held.attempts >= this.maxAttempts) return this.die(held, code);
    const wait = Math.max(pushBackoffMs(held.attempts), retryAfterMs);
    await this.globalDb.pushDelivery.updateMany({
      where: this.lease(held),
      data: {
        status: 'pending',
        lastErrorCode: code,
        lockedUntil: null,
        nextAttemptAt: new Date(now.getTime() + wait),
      },
    });
    return 'retried';
  }

  private async die(held: ClaimedPushDelivery, code: string): Promise<Outcome> {
    await this.globalDb.pushDelivery.updateMany({
      where: this.lease(held),
      data: { status: 'dead', lastErrorCode: code, lockedUntil: null },
    });
    this.logDead(held.id, code);
    return 'dead';
  }

  /** A transport answers; one that throws anyway left the outcome unknown. */
  private async send(
    transport: PushTransport,
    message: PushMessage,
  ): Promise<PushResult> {
    try {
      return await transport.send(message);
    } catch (error) {
      return { ok: false, kind: 'unknown', code: errorName(error) };
    }
  }

  /**
   * The message for one delivery, or null when there is nothing to send:
   * the notification was deleted (erasure, retention), or the device may no
   * longer receive — its session ended or expired, or its account is not
   * active — and is deleted here.
   */
  private async prepare(
    delivery: ClaimedPushDelivery,
    now: Date,
  ): Promise<Prepared | null> {
    const read = await this.cls.run({ ifNested: 'inherit' }, () => {
      this.cls.set('auditActor', { type: 'system', id: null });
      return this.tenantTx.runInTenantUnsafe(delivery.tenantId, async (tx) => {
        const global = this.globalDb.in(tx);
        const device = await global.pushDevice.findUnique({
          where: { id: delivery.deviceId },
          select: { token: true, accountId: true, sessionId: true },
        });
        if (!device) return { device: null };
        const session = await global.session.findFirst({
          where: {
            id: device.sessionId,
            accountId: device.accountId,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          select: { id: true },
        });
        const account = await tx.account.findUnique({
          where: { id: device.accountId },
          select: { status: true, preferredLocale: true },
        });
        const notification = await tx.notification.findFirst({
          where: { id: delivery.notificationId, accountId: device.accountId },
          select: {
            kind: true,
            params: true,
            targetType: true,
            targetId: true,
          },
        });
        return { device, live: !!session, account, notification };
      });
    });
    if (!read.device) {
      await this.drop(delivery);
      return null;
    }
    if (!read.live || read.account?.status !== 'active') {
      await this.globalDb.pushDevice.deleteMany({
        where: { id: delivery.deviceId },
      });
      return null;
    }
    const n = read.notification;
    if (!n || !(n.kind in NOTIFICATION_KINDS)) {
      await this.drop(delivery);
      return null;
    }
    const kind = n.kind as NotificationKind;
    const text = renderPush(
      kind,
      read.account.preferredLocale,
      n.params as NotificationParams,
    );
    return {
      message: {
        token: read.device.token,
        title: text.title,
        body: text.body,
        data: {
          notificationId: delivery.notificationId,
          kind,
          targetType: n.targetType ?? '',
          targetId: n.targetId ?? '',
        },
        critical: NOTIFICATION_KINDS[kind].critical,
        collapseId: delivery.notificationId,
      },
    };
  }

  private async drop(delivery: ClaimedPushDelivery): Promise<void> {
    await this.globalDb.pushDelivery.deleteMany({
      where: this.lease(delivery),
    });
  }

  /** Later writes only apply while this claim still holds the row. */
  private lease(delivery: ClaimedPushDelivery) {
    return {
      id: delivery.id,
      status: 'processing' as const,
      lockedUntil: delivery.lockedUntil,
    };
  }

  private logDead(id: string, code: string) {
    this.logger.error(`push delivery ${id} is dead (${code})`);
  }

  /** Deletes finished rows past retention. How many. */
  async purge(now: Date = new Date()): Promise<number> {
    const before = new Date(now.getTime() - PUSH_RETENTION_MS);
    const { count } = await this.globalDb.pushDelivery.deleteMany({
      where: { status: { in: ['sent', 'dead'] }, createdAt: { lt: before } },
    });
    return count;
  }
}

export function pushBackoffMs(attempts: number): number {
  return PUSH_BACKOFF_MS[Math.min(attempts, PUSH_BACKOFF_MS.length) - 1];
}

function errorName(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'UNKNOWN';
  const e = error as { code?: unknown; name?: unknown };
  if (typeof e.code === 'string') return e.code;
  return typeof e.name === 'string' ? e.name : 'UNKNOWN';
}

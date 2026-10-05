import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { AccountLifecycle } from '../accounts/account-lifecycle';
import { RequestContext } from '../common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../common/cursor';
import { appError, ErrorCode } from '../common/errors';
import type { Env } from '../config/env.schema';
import { TenantTx } from '../database/tenant-tx.service';
import { SweepRunner } from '../sweep/sweep-runner';

export const NOTIFICATIONS_RETENTION_SWEEP = 'notifications.retention';

const PAGE = keysetCursor('createdAt');

export interface InboxItem {
  id: string;
  kind: string;
  priority: 'normal' | 'critical';
  params: Record<string, string | number>;
  targetType: string | null;
  targetId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

/**
 * The signed-in account's own inbox (ADR 0027). Nothing here takes another
 * account's id: a notification of someone else is NOTIFICATION_NOT_FOUND.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly retentionMs: number;

  constructor(
    private readonly ctx: RequestContext,
    private readonly tenantTx: TenantTx,
    private readonly sweep: SweepRunner,
    private readonly lifecycle: AccountLifecycle,
    config: ConfigService<Env, true>,
  ) {
    this.retentionMs =
      config.get('NOTIFICATIONS_RETENTION_DAYS', { infer: true }) * 86_400_000;
  }

  onModuleInit(): void {
    this.sweep.register(NOTIFICATIONS_RETENTION_SWEEP, (now) =>
      this.purgeRead(now),
    );
    // An erased account keeps nothing addressed to it (ADR 0023).
    this.lifecycle.onErasing(async (tx, account) => {
      await tx.notification.deleteMany({ where: { accountId: account.id } });
      return [];
    });
  }

  /** Newest first; `unread` keeps only the unread ones. */
  async mine(
    q: { cursor?: string; limit?: number; unread?: boolean } = {},
  ): Promise<Page<InboxItem>> {
    const limit = clampLimit(q.limit);
    const accountId = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.notification.findMany({
        where: {
          AND: [
            { accountId },
            ...(q.unread ? [{ readAt: null }] : []),
            ...(PAGE.after(q.cursor) as Prisma.NotificationWhereInput[]),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return {
        nextCursor: page.nextCursor,
        items: page.items.map((n) => ({
          id: n.id,
          kind: n.kind,
          priority: n.priority,
          params: n.params as Record<string, string | number>,
          targetType: n.targetType,
          targetId: n.targetId,
          readAt: n.readAt,
          createdAt: n.createdAt,
        })),
      };
    });
  }

  async unreadCount(): Promise<{ unread: number; critical: number }> {
    const accountId = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const unread = await tx.notification.count({
        where: { accountId, readAt: null },
      });
      const critical = await tx.notification.count({
        where: { accountId, readAt: null, priority: 'critical' },
      });
      return { unread, critical };
    });
  }

  /** Idempotent: marking a read notification again changes nothing. */
  async markRead(id: string): Promise<void> {
    const accountId = this.ctx.accountId;
    await this.tenantTx.withTenantTx(async (tx) => {
      const { count } = await tx.notification.updateMany({
        where: { id, accountId, readAt: null },
        data: { readAt: new Date() },
      });
      if (count) return;
      const own = await tx.notification.count({ where: { id, accountId } });
      if (!own)
        throw appError.notFound(
          ErrorCode.NOTIFICATION_NOT_FOUND,
          'Notification not found',
        );
    });
  }

  async markAllRead(): Promise<number> {
    const accountId = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const { count } = await tx.notification.updateMany({
        where: { accountId, readAt: null },
        data: { readAt: new Date() },
      });
      return count;
    });
  }

  /** The retention sweep: read notifications older than the retention go. */
  private purgeRead(now: Date): Promise<number> {
    const before = new Date(now.getTime() - this.retentionMs);
    return this.sweep.forEachTenant(async (tx) => {
      const { count } = await tx.notification.deleteMany({
        where: { readAt: { not: null }, createdAt: { lt: before } },
      });
      return count;
    });
  }
}

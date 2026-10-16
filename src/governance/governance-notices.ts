import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import type {
  NotificationKind,
  NotificationParams,
} from '../core/notifications/kinds';
import { Notifier } from '../core/notifications/notifier';

/**
 * Tells the active accounts among `to` (ADR 0051), in the action's
 * transaction: a notification exists exactly when its cause committed.
 */
@Injectable()
export class GovernanceNotices {
  constructor(private readonly notifier: Notifier) {}

  async send(
    tx: TenantTxClient,
    to: readonly string[],
    kind: NotificationKind,
    targetId: string,
    params: NotificationParams = {},
  ): Promise<number> {
    const ids = [...new Set(to)];
    if (!ids.length) return 0;
    const active = await tx.account.findMany({
      where: { id: { in: ids }, status: 'active' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    if (!active.length) return 0;
    return this.notifier.notify(
      tx,
      active.map((a) => a.id),
      { kind, params, targetId },
    );
  }
}

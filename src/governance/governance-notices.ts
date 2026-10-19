import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import type {
  NotificationKind,
  NotificationParams,
} from '../core/notifications/kinds';
import { Notifier } from '../core/notifications/notifier';
import { GovernanceAccess } from './access';

/**
 * Tells the active accounts among `to` (ADR 0051), in the action's
 * transaction: a notification exists exactly when its cause committed.
 * Its row key-shares each account: one the write did not lock first is
 * locked late (`GovernanceAccess.lockLate`, ADR 0055).
 */
@Injectable()
export class GovernanceNotices {
  constructor(
    private readonly notifier: Notifier,
    private readonly access: GovernanceAccess,
  ) {}

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
    const accountIds = active.map((a) => a.id);
    await this.access.lockLate(tx, accountIds);
    return this.notifier.notify(tx, accountIds, { kind, params, targetId });
  }
}

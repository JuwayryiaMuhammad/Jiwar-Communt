import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import type {
  NotificationKind,
  NotificationParams,
} from '../../core/notifications/kinds';
import { Notifier } from '../../core/notifications/notifier';

/**
 * Bookings' and the club's notifications (ADR 0027, 0044), in the action's
 * transaction: inbox rows, pushed by the outbox. The category is
 * `bookings`; no kind is critical. The target is the booking, the
 * suspension or the membership; params are reason codes at most — never a
 * facility's name, a time, a unit or anyone's name.
 */
@Injectable()
export class BookingNotices {
  constructor(private readonly notifier: Notifier) {}

  /**
   * Tells the active accounts among `to`, never `except` (the one who
   * acted).
   */
  async send(
    tx: TenantTxClient,
    to: readonly (string | null)[],
    kind: NotificationKind,
    targetId: string,
    params: NotificationParams = {},
    except: string | null = null,
  ): Promise<number> {
    const ids = [...new Set(to)].filter(
      (id): id is string => id !== null && id !== except,
    );
    if (!ids.length) return 0;
    const active = await tx.account.findMany({
      where: { id: { in: ids }, status: 'active' },
      select: { id: true },
    });
    if (!active.length) return 0;
    return this.notifier.notify(
      tx,
      active.map((a) => a.id),
      { kind, params, targetId },
    );
  }
}

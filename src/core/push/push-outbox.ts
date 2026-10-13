import { Inject, Injectable } from '@nestjs/common';
import { newId } from '../common/uuid';
import { GlobalDbService } from '../database/global-db.service';
import type { TenantTxClient } from '../database/tenant-tx.service';
import { kindDelivery, type NotificationKind } from '../notifications/kinds';
import { deliveryDecision } from '../preferences/delivery-decision';
import { DeliveryPreferences } from '../preferences/delivery-preferences';
import { PUSH_TRANSPORT, type PushTransport } from './push-transport';

/**
 * Queues the pushes of a notification (ADR 0041), in the SAME transaction
 * that writes it to the inbox: one row per notification and registered
 * device. A notification that rolls back queues nothing; PushProcessor
 * sends the rows later.
 *
 * The account's preferences decide here, with the kind's delivery class
 * (ADR 0036). A critical kind always goes. Anything else goes only when it
 * would be delivered right now: a muted category, quiet hours and a pause
 * all mean NO push, not a later one. The inbox has the notification, and a
 * push that arrives hours late is noise.
 *
 * When push is not configured nothing is queued at all.
 */
@Injectable()
export class PushOutbox {
  constructor(
    private readonly globalDb: GlobalDbService,
    private readonly preferences: DeliveryPreferences,
    @Inject(PUSH_TRANSPORT) private readonly transport: PushTransport | null,
  ) {}

  /** How many deliveries were queued. */
  async enqueue(
    tx: TenantTxClient,
    tenantId: string,
    notifications: readonly { id: string; accountId: string }[],
    kind: NotificationKind,
    now: Date = new Date(),
  ): Promise<number> {
    if (!this.transport || !notifications.length) return 0;
    const global = this.globalDb.in(tx);
    const devices = await global.pushDevice.findMany({
      where: {
        tenantId,
        accountId: { in: notifications.map((n) => n.accountId) },
      },
      select: { id: true, accountId: true },
      orderBy: { id: 'asc' },
    });
    if (!devices.length) return 0;

    const klass = kindDelivery(kind);
    let reachable = new Set(devices.map((d) => d.accountId));
    if (!klass.critical) {
      const prefs = await this.preferences.loadMany(tx, [...reachable]);
      reachable = new Set(
        [...prefs]
          .filter(
            ([, p]) =>
              deliveryDecision(p, klass, 'push', now).action === 'deliver',
          )
          .map(([accountId]) => accountId),
      );
    }
    const data = notifications
      .filter((n) => reachable.has(n.accountId))
      .flatMap((n) =>
        devices
          .filter((d) => d.accountId === n.accountId)
          .map((d) => ({
            id: newId(),
            tenantId,
            notificationId: n.id,
            deviceId: d.id,
            nextAttemptAt: now,
          })),
      );
    if (!data.length) return 0;
    return (await global.pushDelivery.createMany({ data })).count;
  }
}

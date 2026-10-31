import { Injectable } from '@nestjs/common';
import type { GateDirection } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { Notifier } from '../../core/notifications/notifier';

/**
 * A household told when its visitor comes and goes (ADR 0071): an entry or
 * an exit on a pass that says so (`notifyOnEntry`) reaches its host and
 * whoever in the unit is told of its visitors (`visitorsNotify`), active
 * accounts only. The pass and the gate, never the visitor's name. In the
 * entry's transaction, online or uploaded later from a device offline.
 */
@Injectable()
export class VisitorPassNotices {
  constructor(
    private readonly community: CommunityGatePort,
    private readonly notifier: Notifier,
  ) {}

  async tell(
    tx: TenantTxClient,
    passId: string,
    direction: GateDirection,
    gateName: string,
  ): Promise<void> {
    const pass = await tx.visitorPass.findUnique({
      where: { id: passId },
      select: { unitId: true, hostAccountId: true, notifyOnEntry: true },
    });
    if (!pass?.notifyOnEntry) return;
    const holders = await this.community.holders(
      tx,
      pass.unitId,
      'visitorsNotify',
    );
    const active = await tx.account.findMany({
      where: {
        id: { in: [...new Set([pass.hostAccountId, ...holders])] },
        status: 'active',
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    if (!active.length) return;
    await this.notifier.notify(
      tx,
      active.map((a) => a.id),
      {
        kind:
          direction === 'in' ? 'visitor_pass.entered' : 'visitor_pass.exited',
        params: { gateName },
        targetId: passId,
      },
    );
  }
}

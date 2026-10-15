import { Injectable } from '@nestjs/common';
import type { Emergency } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';

export type EscalationReason = 'timeout' | 'no_responders';

/**
 * Hands an emergency to the management (ADR 0047), once: when nobody was
 * there to tell (at the report), or nobody accepted within two minutes (the
 * sweep). Every holder of `emergencies.manage` gets a critical push; the
 * escalation is recorded with how many were told, none included.
 */
@Injectable()
export class EmergencyEscalation {
  constructor(
    private readonly core: SafetyCore,
    private readonly audit: AuditService,
  ) {}

  /** The caller holds the emergency's row; it is open and not escalated. */
  async escalate(
    tx: TenantTxClient,
    e: Emergency,
    reason: EscalationReason,
  ): Promise<Emergency> {
    const escalated = await tx.emergency.update({
      where: { id: e.id },
      data: { escalatedAt: await dbNow(tx), escalationReason: reason },
    });
    const recipients = await this.core.notify(
      tx,
      await this.core.holding(tx, 'emergencies.manage'),
      'emergency.escalated',
      e.id,
      { emergencyType: e.type },
    );
    await this.audit.record(tx, {
      action: 'emergency.escalated',
      targetId: e.id,
      metadata: { reason, recipients },
    });
    return escalated;
  }
}

import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Emergency } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';

export type EscalationReason = 'timeout' | 'no_responders';

export const EMERGENCY_ESCALATION_SWEEP = 'gate.emergency_escalation';
/** Unanswered this long, an emergency goes to the management. */
export const ESCALATE_AFTER_MS = 2 * 60_000;
/** Often enough that "two minutes" is at most two and a half. */
export const ESCALATION_INTERVAL_MS = 30_000;
const SWEEP_BATCH = 200;

/**
 * Hands an emergency to the management (ADR 0047), once: when nobody was
 * there to tell (at the report), or nobody accepted within two minutes (the
 * sweep). Every holder of `emergencies.manage` gets a critical push; the
 * escalation is recorded with how many were told, none included.
 */
@Injectable()
export class EmergencyEscalation implements OnModuleInit {
  constructor(
    private readonly core: SafetyCore,
    private readonly audit: AuditService,
    private readonly sweep: SweepRunner,
  ) {}

  onModuleInit(): void {
    this.sweep.register(
      EMERGENCY_ESCALATION_SWEEP,
      (now) => this.escalateDue(now),
      { intervalMs: ESCALATION_INTERVAL_MS },
    );
  }

  /**
   * Emergencies nobody accepted within two minutes, one transaction each:
   * the row is taken with SKIP LOCKED and judged again under its lock, so
   * an accept or a cancel holding it wins and the sweep leaves it. Run
   * twice, or on two instances at once, an emergency is escalated once
   * (`escalated_at` is the claim, and the trigger allows it once).
   */
  escalateDue(now: Date): Promise<number> {
    const due = new Date(now.getTime() - ESCALATE_AFTER_MS);
    return this.sweep.forEachTenantItem(
      async (tx) =>
        (
          await tx.emergency.findMany({
            where: {
              status: 'reported',
              escalatedAt: null,
              reportedAt: { lte: due },
            },
            orderBy: [{ reportedAt: 'asc' }, { id: 'asc' }],
            take: SWEEP_BATCH,
            select: { id: true },
          })
        ).map((e) => e.id),
      async (tx, _tenantId, id) => {
        const [claimed] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM emergencies
           WHERE id = ${id}::uuid FOR UPDATE SKIP LOCKED`;
        if (!claimed) return 0;
        const e = await tx.emergency.findUniqueOrThrow({ where: { id } });
        if (e.status !== 'reported' || e.escalatedAt || e.reportedAt > due)
          return 0;
        await this.escalate(tx, e, 'timeout', now);
        return 1;
      },
    );
  }

  /** The caller holds the emergency's row; it is open and not escalated. */
  async escalate(
    tx: TenantTxClient,
    e: Emergency,
    reason: EscalationReason,
    at?: Date,
  ): Promise<Emergency> {
    const escalated = await tx.emergency.update({
      where: { id: e.id },
      data: {
        escalatedAt: at ?? (await dbNow(tx)),
        escalationReason: reason,
      },
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

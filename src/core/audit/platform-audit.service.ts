import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { newId } from '../common/uuid';
import type { Env } from '../config/env.schema';
import { AUDIT_ACTIONS, type PlatformAuditAction } from './actions';
import { AuditContext } from './audit-context';
import { prepare, type AuditEntry } from './audit.service';

/**
 * Platform audit log (ADR 0014): the platform owner's actions. `tx` is the
 * transaction of the action — a TenantTx one when the action writes inside a
 * compound, or GlobalDbService.transaction for global-only work.
 */
@Injectable()
export class PlatformAuditService {
  private readonly logger = new Logger(PlatformAuditService.name);
  private strict: boolean;

  constructor(
    private readonly context: AuditContext,
    config: ConfigService<Env, true>,
  ) {
    this.strict = config.get('NODE_ENV', { infer: true }) === 'test';
  }

  async record(
    tx: Prisma.TransactionClient,
    entry: AuditEntry<PlatformAuditAction> & { targetTenantId?: string | null },
  ): Promise<void> {
    const { changes, metadata } = prepare(entry, this.strict, this.logger);
    const actor = this.context.actor();
    await tx.platformAuditLog.create({
      data: {
        id: newId(),
        actorType: actor.type,
        actorId: actor.id,
        action: entry.action,
        targetType: AUDIT_ACTIONS[entry.action].target,
        targetId: entry.targetId,
        targetTenantId: entry.targetTenantId ?? null,
        changes,
        metadata,
        ...this.context.origin(),
      },
    });
  }
}

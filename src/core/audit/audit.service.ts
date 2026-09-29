import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { newId } from '../common/uuid';
import type { Env } from '../config/env.schema';
import type { TenantTxClient } from '../database/tenant-tx.service';
import { AUDIT_ACTIONS, type TenantAuditAction } from './actions';
import { AuditContext } from './audit-context';
import type { Changes } from './diff';
import { sanitize } from './personal-data';

export interface AuditEntry<A> {
  action: A;
  targetId: string | null;
  changes?: Changes;
  metadata?: Record<string, unknown>;
}

/**
 * Tenant audit log (ADR 0014). `tx` is required: the entry commits or rolls
 * back with the action (fail-closed). The tenant is the one the transaction
 * was opened for; actor and origin come from the request context.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  /** Tests throw on personal-looking values; production redacts them. */
  private strict: boolean;

  constructor(
    private readonly context: AuditContext,
    config: ConfigService<Env, true>,
  ) {
    this.strict = config.get('NODE_ENV', { infer: true }) === 'test';
  }

  async record(
    tx: TenantTxClient,
    entry: AuditEntry<TenantAuditAction>,
  ): Promise<void> {
    const tenantId = this.context.txTenantId();
    if (!tenantId) {
      throw new Error(
        'AuditService.record must run inside a TenantTx transaction',
      );
    }
    const { changes, metadata } = prepare(entry, this.strict, this.logger);
    const actor = this.context.actor();
    const origin = this.context.origin();
    await tx.auditLog.create({
      data: {
        id: newId(),
        tenantId,
        actorType: actor.type,
        actorId: actor.id,
        action: entry.action,
        targetType: AUDIT_ACTIONS[entry.action].target,
        targetId: entry.targetId,
        changes,
        metadata,
        ...origin,
      },
    });
  }
}

/** Shared by the tenant and platform audit services. */
export function prepare(
  entry: AuditEntry<keyof typeof AUDIT_ACTIONS>,
  strict: boolean,
  logger: Logger,
): { changes?: Prisma.InputJsonValue; metadata?: Prisma.InputJsonValue } {
  const changes = entry.changes
    ? sanitize(entry.changes, { checkKeys: false, strict, root: 'changes' })
    : undefined;
  const metadata = entry.metadata
    ? sanitize(entry.metadata, { checkKeys: true, strict, root: 'metadata' })
    : undefined;
  const redacted = [
    ...(changes?.redacted ?? []),
    ...(metadata?.redacted ?? []),
  ];
  if (redacted.length) {
    // Paths only — never the values.
    logger.warn(
      `${entry.action}: redacted values that look like personal data at ${redacted.join(', ')}`,
    );
  }
  return {
    changes: changes?.value as Prisma.InputJsonValue | undefined,
    metadata: metadata?.value as Prisma.InputJsonValue | undefined,
  };
}

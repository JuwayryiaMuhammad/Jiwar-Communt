import { Injectable } from '@nestjs/common';
import type { AuditActorType } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../common/cls/app-cls';

export interface AuditActor {
  type: AuditActorType;
  id: string | null;
}

export interface RequestOrigin {
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
}

/** Who acts and from where, from the request context (ADR 0014). */
@Injectable()
export class AuditContext {
  constructor(private readonly cls: ClsService<AppClsStore>) {}

  actor(): AuditActor {
    if (!this.cls.isActive()) return { type: 'system', id: null };
    const explicit = this.cls.get('auditActor');
    if (explicit) return explicit;
    const platformAdminId = this.cls.get('platformAdminId');
    if (platformAdminId) return { type: 'platform_admin', id: platformAdminId };
    const accountId = this.cls.get('accountId');
    if (accountId) return { type: 'account', id: accountId };
    return { type: 'system', id: null };
  }

  origin(): RequestOrigin {
    if (!this.cls.isActive())
      return { requestId: null, ip: null, userAgent: null };
    return {
      requestId: this.cls.getId() ?? null,
      ip: this.cls.get('ip') ?? null,
      userAgent: this.cls.get('userAgent') ?? null,
    };
  }

  /** The tenant of the running TenantTx transaction, if any. */
  txTenantId(): string | undefined {
    return this.cls.isActive() ? this.cls.get('txTenantId') : undefined;
  }
}

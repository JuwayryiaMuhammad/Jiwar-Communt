import type { AuditLog, PlatformAuditLog, SecurityEvent } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../../src/common/cls/app-cls';
import { GlobalDbService } from '../../src/database/global-db.service';
import { PrismaService } from '../../src/database/prisma.service';
import type { HttpHarness } from './http-app';

/** Readers for asserting audit rows (tests only; the app has query services). */
export function auditReaders(h: HttpHarness) {
  const cls = h.moduleRef.get<ClsService<AppClsStore>>(ClsService);
  const prisma = h.moduleRef.get(PrismaService);
  const globalDb = h.moduleRef.get(GlobalDbService);

  return {
    /** Tenant audit rows, oldest first, read under RLS as that tenant. */
    tenant(
      tenantId: string,
      where: Partial<Pick<AuditLog, 'action' | 'targetId'>> = {},
    ) {
      return cls.run(async () => {
        cls.set('tenantId', tenantId);
        return await prisma.tenant.auditLog.findMany({
          where,
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        });
      });
    },
    platform(
      where: Partial<
        Pick<PlatformAuditLog, 'action' | 'targetId' | 'targetTenantId'>
      > = {},
    ) {
      return globalDb.platformAuditLog.findMany({
        where,
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      });
    },
    security(
      where: Partial<
        Pick<
          SecurityEvent,
          'event' | 'identifierHash' | 'accountId' | 'platformAdminId'
        >
      > = {},
    ) {
      return globalDb.securityEvent.findMany({
        where,
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      });
    },
  };
}

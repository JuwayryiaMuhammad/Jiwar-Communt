import { Injectable } from '@nestjs/common';
import type {
  AuditLog,
  PlatformAuditLog,
  Prisma,
  SecurityEvent,
} from '@prisma/client';
import { GlobalDbService } from '../database/global-db.service';
import { PrismaService } from '../database/prisma.service';
import {
  clampLimit,
  NEWEST_FIRST,
  pageWhere,
  toPage,
  type Page,
  type PageQuery,
} from './cursor';

// Read side of the audit trail, for future screens (no controllers yet).
// Callers are guarded: `audit.read` for the tenant log; the platform admin
// for the platform log and security events.

export interface AuditQuery extends PageQuery {
  action?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
}

/** The current compound's audit log (RLS-scoped). */
@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: AuditQuery = {}): Promise<Page<AuditLog>> {
    const limit = clampLimit(q.limit);
    const where: Prisma.AuditLogWhereInput = {
      AND: [
        ...(q.action ? [{ action: q.action }] : []),
        ...(q.actorId ? [{ actorId: q.actorId }] : []),
        ...(q.targetType ? [{ targetType: q.targetType }] : []),
        ...(q.targetId ? [{ targetId: q.targetId }] : []),
        ...(pageWhere(q) as Prisma.AuditLogWhereInput[]),
      ],
    };
    const rows = await this.prisma.tenant.auditLog.findMany({
      where,
      orderBy: NEWEST_FIRST,
      take: limit + 1,
    });
    return toPage(rows, limit);
  }
}

export interface PlatformAuditQuery extends AuditQuery {
  targetTenantId?: string;
}

/** The platform owner's audit log. */
@Injectable()
export class PlatformAuditQueryService {
  constructor(private readonly globalDb: GlobalDbService) {}

  async list(q: PlatformAuditQuery = {}): Promise<Page<PlatformAuditLog>> {
    const limit = clampLimit(q.limit);
    const where: Prisma.PlatformAuditLogWhereInput = {
      AND: [
        ...(q.action ? [{ action: q.action }] : []),
        ...(q.actorId ? [{ actorId: q.actorId }] : []),
        ...(q.targetType ? [{ targetType: q.targetType }] : []),
        ...(q.targetId ? [{ targetId: q.targetId }] : []),
        ...(q.targetTenantId ? [{ targetTenantId: q.targetTenantId }] : []),
        ...(pageWhere(q) as Prisma.PlatformAuditLogWhereInput[]),
      ],
    };
    const rows = await this.globalDb.platformAuditLog.findMany({
      where,
      orderBy: NEWEST_FIRST,
      take: limit + 1,
    });
    return toPage(rows, limit);
  }
}

export interface SecurityEventsQuery extends PageQuery {
  event?: string;
  identifierHash?: string;
  accountId?: string;
  tenantId?: string;
  platformAdminId?: string;
}

/** Security events, for the platform owner. */
@Injectable()
export class SecurityEventsQueryService {
  constructor(private readonly globalDb: GlobalDbService) {}

  async list(q: SecurityEventsQuery = {}): Promise<Page<SecurityEvent>> {
    const limit = clampLimit(q.limit);
    const where: Prisma.SecurityEventWhereInput = {
      AND: [
        ...(q.event ? [{ event: q.event }] : []),
        ...(q.identifierHash ? [{ identifierHash: q.identifierHash }] : []),
        ...(q.accountId ? [{ accountId: q.accountId }] : []),
        ...(q.tenantId ? [{ tenantId: q.tenantId }] : []),
        ...(q.platformAdminId ? [{ platformAdminId: q.platformAdminId }] : []),
        ...(pageWhere(q) as Prisma.SecurityEventWhereInput[]),
      ],
    };
    const rows = await this.globalDb.securityEvent.findMany({
      where,
      orderBy: NEWEST_FIRST,
      take: limit + 1,
    });
    return toPage(rows, limit);
  }
}

import { ApiProperty } from '@nestjs/swagger';
import { AuditActorType } from '@prisma/client';
import type { AuditLog, PlatformAuditLog, SecurityEvent } from '@prisma/client';

/**
 * A compound's audit entry, for its managers. No IP and no user agent:
 * managers see who did what, not where from (PII decision, ADR 0025).
 */
export class AuditEntryView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt: Date;
  @ApiProperty({ enum: AuditActorType, enumName: 'AuditActorType' })
  actorType: AuditActorType;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  actorId: string | null;
  @ApiProperty({ type: String })
  action: string;
  @ApiProperty({ type: String })
  targetType: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  targetId: string | null;
  @ApiProperty({
    type: Object,
    nullable: true,
    description: 'Changed fields; personal values are `{ changed: true }`.',
  })
  changes: unknown;
  @ApiProperty({
    type: Object,
    nullable: true,
    description: 'Codes and counts only; never personal data.',
  })
  metadata: unknown;
  @ApiProperty({ type: String, nullable: true })
  requestId: string | null;

  static from(e: AuditLog): AuditEntryView {
    return {
      id: e.id,
      occurredAt: e.occurredAt,
      actorType: e.actorType,
      actorId: e.actorId,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      changes: e.changes,
      metadata: e.metadata,
      requestId: e.requestId,
    };
  }
}

/** The platform's audit entry, with its origin, for the platform owner. */
export class PlatformAuditEntryView extends AuditEntryView {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  targetTenantId: string | null;
  @ApiProperty({ type: String, nullable: true })
  ip: string | null;
  @ApiProperty({ type: String, nullable: true })
  userAgent: string | null;

  static fromPlatform(e: PlatformAuditLog): PlatformAuditEntryView {
    return {
      id: e.id,
      occurredAt: e.occurredAt,
      actorType: e.actorType,
      actorId: e.actorId,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      targetTenantId: e.targetTenantId,
      changes: e.changes,
      metadata: e.metadata,
      requestId: e.requestId,
      ip: e.ip,
      userAgent: e.userAgent,
    };
  }
}

export class SecurityEventView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt: Date;
  @ApiProperty({ type: String })
  event: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'HMAC of the login identifier; never the email or phone.',
  })
  identifierHash: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  accountId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  tenantId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  platformAdminId: string | null;
  @ApiProperty({ type: String, nullable: true })
  ip: string | null;
  @ApiProperty({ type: String, nullable: true })
  userAgent: string | null;
  @ApiProperty({ type: String, nullable: true })
  requestId: string | null;
  @ApiProperty({ type: Object, nullable: true })
  metadata: unknown;

  static from(e: SecurityEvent): SecurityEventView {
    return {
      id: e.id,
      occurredAt: e.occurredAt,
      event: e.event,
      identifierHash: e.identifierHash,
      accountId: e.accountId,
      tenantId: e.tenantId,
      platformAdminId: e.platformAdminId,
      ip: e.ip,
      userAgent: e.userAgent,
      requestId: e.requestId,
      metadata: e.metadata,
    };
  }
}

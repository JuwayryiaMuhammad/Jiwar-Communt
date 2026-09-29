import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { newId } from '../common/uuid';
import type { Env } from '../config/env.schema';
import { GlobalDbService } from '../database/global-db.service';
import type { SecurityEventName } from './actions';
import { AuditContext } from './audit-context';
import {
  PersonalValueError,
  sanitize,
  SensitiveKeyError,
} from './personal-data';

export interface SecurityEventData {
  /** The login identifier HMAC — never a raw email or phone. */
  identifierHash?: string | null;
  accountId?: string | null;
  tenantId?: string | null;
  platformAdminId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Security events (ADR 0014): written on their own, outside business
 * transactions, and FAIL-OPEN — a failure to log must never block a login
 * (that would be a denial of service). Callers record transactional
 * outcomes only after commit.
 */
@Injectable()
export class SecurityEventsService {
  private readonly logger = new Logger(SecurityEventsService.name);
  private strict: boolean;

  constructor(
    private readonly globalDb: GlobalDbService,
    private readonly context: AuditContext,
    config: ConfigService<Env, true>,
  ) {
    this.strict = config.get('NODE_ENV', { infer: true }) === 'test';
  }

  async record(
    event: SecurityEventName,
    data: SecurityEventData = {},
  ): Promise<void> {
    try {
      const metadata = data.metadata
        ? sanitize(data.metadata, {
            checkKeys: true,
            strict: this.strict,
            root: 'metadata',
          })
        : undefined;
      if (metadata?.redacted.length) {
        this.logger.warn(
          `${event}: redacted values at ${metadata.redacted.join(', ')}`,
        );
      }
      await this.globalDb.securityEvent.create({
        data: {
          id: newId(),
          event,
          identifierHash: data.identifierHash ?? null,
          accountId: data.accountId ?? null,
          tenantId: data.tenantId ?? null,
          platformAdminId: data.platformAdminId ?? null,
          metadata: metadata?.value as Prisma.InputJsonValue | undefined,
          ...this.context.origin(),
        },
      });
    } catch (error) {
      // A developer mistake must surface in tests; nothing else may escape.
      if (
        this.strict &&
        (error instanceof SensitiveKeyError ||
          error instanceof PersonalValueError)
      ) {
        throw error;
      }
      this.logger.error(
        `security event ${event} not recorded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

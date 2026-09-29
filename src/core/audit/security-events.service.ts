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
 * (that would be a denial of service). Each insert is capped by a
 * database-side statement_timeout (SECURITY_EVENT_TIMEOUT_MS), so a locked
 * table delays a login by at most that much and never holds a pooled
 * connection. Callers record transactional outcomes only after commit.
 */
@Injectable()
export class SecurityEventsService {
  private readonly logger = new Logger(SecurityEventsService.name);
  private readonly strict: boolean;
  private readonly timeoutMs: number;

  constructor(
    private readonly globalDb: GlobalDbService,
    private readonly context: AuditContext,
    config: ConfigService<Env, true>,
  ) {
    this.strict = config.get('NODE_ENV', { infer: true }) === 'test';
    this.timeoutMs = config.get('SECURITY_EVENT_TIMEOUT_MS', { infer: true });
  }

  /**
   * Fire-and-forget: the caller never waits. For work already off the
   * request path (e.g. `otp.requested` before the code is emailed). The write
   * is still bounded by SECURITY_EVENT_TIMEOUT_MS, so it can't hold a
   * connection either.
   */
  recordInBackground(
    event: SecurityEventName,
    data: SecurityEventData = {},
  ): void {
    this.record(event, data).catch((error: unknown) => {
      this.logger.error(`security event ${event} failed (${errorCode(error)})`);
    });
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
      await this.globalDb.insertSecurityEvent(
        {
          id: newId(),
          event,
          identifierHash: data.identifierHash ?? null,
          accountId: data.accountId ?? null,
          tenantId: data.tenantId ?? null,
          platformAdminId: data.platformAdminId ?? null,
          metadata: metadata?.value as Prisma.InputJsonValue | undefined,
          ...this.context.origin(),
        },
        this.timeoutMs,
      );
    } catch (error) {
      // A developer mistake must surface in tests; nothing else may escape.
      if (
        this.strict &&
        (error instanceof SensitiveKeyError ||
          error instanceof PersonalValueError)
      ) {
        throw error;
      }
      // The event name and an error code only: a driver message can echo
      // the row, and the row must stay in the database.
      this.logger.error(
        `security event ${event} not recorded (${errorCode(error)})`,
      );
    }
  }
}

/** A loggable reason that carries no row data: a SQLSTATE, a Prisma code, or the error class. */
function errorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return typeof error;
  const e = error as {
    code?: unknown;
    name?: unknown;
    cause?: { code?: unknown; originalCode?: unknown };
    meta?: {
      code?: unknown;
      driverAdapterError?: { cause?: { originalCode?: unknown } };
    };
  };
  const sqlState =
    e.cause?.originalCode ??
    e.meta?.driverAdapterError?.cause?.originalCode ??
    e.meta?.code;
  const parts = [e.code, sqlState].filter(
    (p): p is string => typeof p === 'string',
  );
  if (parts.length) return parts.join(' ');
  return typeof e.name === 'string' ? e.name : 'Error';
}

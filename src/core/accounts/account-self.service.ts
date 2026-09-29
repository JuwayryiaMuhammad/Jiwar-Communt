import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../audit/audit.service';
import { diffChanges } from '../audit/diff';
import { SecurityEventsService } from '../audit/security-events.service';
import type { AppClsStore } from '../common/cls/app-cls';
import { RequestContext } from '../common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../common/errors';
import { LOCALES, type Locale } from '../common/i18n/locale';
import { GlobalDbService } from '../database/global-db.service';
import { TenantTx } from '../database/tenant-tx.service';

export interface MySession {
  id: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  userAgent: string | null;
  /** The session behind the access token making this request. */
  isCurrent: boolean;
}

/**
 * What any signed-in account manages for itself (residents and family
 * members first): language and sessions. The account is always the one in
 * the request context; nothing here takes another account's id.
 */
@Injectable()
export class AccountSelfService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly cls: ClsService<AppClsStore>,
    private readonly tenantTx: TenantTx,
    private readonly globalDb: GlobalDbService,
    private readonly audit: AuditService,
    private readonly securityEvents: SecurityEventsService,
  ) {}

  async updatePreferredLocale(locale: Locale): Promise<Locale> {
    if (!(LOCALES as readonly string[]).includes(locale)) {
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid locale', {
        fields: [
          {
            field: 'preferredLocale',
            code: FieldErrorCode.INVALID_VALUE,
            params: { allowed: [...LOCALES] },
          },
        ],
      });
    }
    const accountId = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await tx.account.findUniqueOrThrow({
        where: { id: accountId },
        select: { preferredLocale: true },
      });
      if (before.preferredLocale === locale) return locale;
      await tx.account.update({
        where: { id: accountId },
        data: { preferredLocale: locale },
      });
      await this.audit.record(tx, {
        action: 'account.locale_changed',
        targetId: accountId,
        changes: diffChanges(
          { preferredLocale: before.preferredLocale },
          { preferredLocale: locale },
          'account.locale_changed',
        ),
      });
      return locale;
    });
  }

  /** Live sessions, newest use first. Never the IP. */
  async listMySessions(): Promise<MySession[]> {
    const current = this.cls.get('sessionId');
    const rows = await this.globalDb.session.findMany({
      where: {
        accountId: this.ctx.accountId,
        tenantId: this.ctx.tenantId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, createdAt: true, lastUsedAt: true, userAgent: true },
      orderBy: [{ lastUsedAt: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((s) => ({ ...s, isCurrent: s.id === current }));
  }

  /** One of the caller's own sessions; anything else is "not found". */
  async revokeSession(sessionId: string): Promise<void> {
    const { count } = await this.globalDb.session.updateMany({
      where: {
        id: sessionId,
        accountId: this.ctx.accountId,
        tenantId: this.ctx.tenantId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    if (count === 0) {
      throw appError.notFound(ErrorCode.SESSION_NOT_FOUND, 'Session not found');
    }
    await this.securityEvents.record('session.revoked', {
      tenantId: this.ctx.tenantId,
      accountId: this.ctx.accountId,
      metadata: { reason: 'self', scope: 'one', sessionId },
    });
  }

  /**
   * "That wasn't me": every session ends, the current one included — its
   * access token stops working on the next request.
   */
  async revokeAllMySessions(): Promise<number> {
    const { count } = await this.globalDb.session.updateMany({
      where: {
        accountId: this.ctx.accountId,
        tenantId: this.ctx.tenantId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    await this.securityEvents.record('session.revoked', {
      tenantId: this.ctx.tenantId,
      accountId: this.ctx.accountId,
      metadata: { reason: 'self', scope: 'all', count },
    });
    return count;
  }
}

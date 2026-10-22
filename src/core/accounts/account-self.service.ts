import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
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
import { clampLimit, keysetCursor, type Page } from '../common/cursor';
import { SweepRunner } from '../sweep/sweep-runner';
import { AccountLifecycle } from './account-lifecycle';

export const LOGINS_RETENTION_SWEEP = 'account.logins_retention';
/** How long a login stays in its holder's history (ADR 0058). */
export const LOGIN_RETENTION_DAYS = 90;
/** Devices are few; the list is bounded, not paged. */
const MAX_DEVICES = 100;

/** A device's coarse label (ADR 0058): codes, never the user agent. */
export interface DeviceLabel {
  deviceType: string;
  os: string;
  client: string;
}

export interface MySession {
  id: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  userAgent: string | null;
  /** The known device it was started on; null before ADR 0058. */
  device: (DeviceLabel & { id: string }) | null;
  /** The session behind the access token making this request. */
  isCurrent: boolean;
}

export interface MyDevice extends DeviceLabel {
  id: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** Live sessions started on it. */
  liveSessions: number;
  /** The device of the session making this request. */
  isCurrent: boolean;
}

export interface MyLogin {
  id: string;
  at: Date;
  device: DeviceLabel & { id: string };
  /** The login that started the session making this request. */
  isCurrent: boolean;
}

const LOGINS = keysetCursor('createdAt');
const LABEL = {
  id: true,
  deviceType: true,
  os: true,
  client: true,
} as const;

/**
 * What any signed-in account manages for itself (residents and family
 * members first): language and sessions. The account is always the one in
 * the request context; nothing here takes another account's id.
 */
@Injectable()
export class AccountSelfService implements OnModuleInit {
  constructor(
    private readonly ctx: RequestContext,
    private readonly cls: ClsService<AppClsStore>,
    private readonly tenantTx: TenantTx,
    private readonly globalDb: GlobalDbService,
    private readonly audit: AuditService,
    private readonly securityEvents: SecurityEventsService,
    private readonly lifecycle: AccountLifecycle,
    private readonly sweep: SweepRunner,
  ) {}

  onModuleInit(): void {
    this.sweep.register(LOGINS_RETENTION_SWEEP, (now) => this.purgeLogins(now));
  }

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

  /** Live sessions, newest use first, each with its device. Never the IP. */
  async listMySessions(): Promise<MySession[]> {
    const current = this.cls.get('sessionId');
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await this.globalDb.in(tx).session.findMany({
        where: {
          accountId: this.ctx.accountId,
          tenantId: this.ctx.tenantId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: {
          id: true,
          createdAt: true,
          lastUsedAt: true,
          userAgent: true,
          knownDeviceId: true,
        },
        orderBy: [{ lastUsedAt: 'desc' }, { createdAt: 'desc' }],
      });
      const ids = [...new Set(rows.flatMap((r) => r.knownDeviceId ?? []))];
      const devices = new Map(
        (
          await tx.knownDevice.findMany({
            where: { id: { in: ids }, accountId: this.ctx.accountId },
            select: LABEL,
          })
        ).map((d) => [d.id, d]),
      );
      return rows.map(({ knownDeviceId, ...s }) => ({
        ...s,
        device: (knownDeviceId && devices.get(knownDeviceId)) || null,
        isCurrent: s.id === current,
      }));
    });
  }

  /**
   * The caller's known devices (ADR 0058), newest use first: what the
   * login alert knows, with how many live sessions each has. A device its
   * holder disowned ("not me") is not listed.
   */
  async listMyDevices(): Promise<MyDevice[]> {
    const accountId = this.ctx.accountId;
    const current = this.cls.get('sessionId');
    return this.tenantTx.withTenantTx(async (tx) => {
      const devices = await tx.knownDevice.findMany({
        where: { accountId, disownedAt: null },
        select: { ...LABEL, firstSeenAt: true, lastSeenAt: true },
        orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
        take: MAX_DEVICES,
      });
      const live = await this.globalDb.in(tx).session.findMany({
        where: {
          accountId,
          tenantId: this.ctx.tenantId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
          knownDeviceId: { in: devices.map((d) => d.id) },
        },
        select: { id: true, knownDeviceId: true },
      });
      return devices.map((d) => {
        const mine = live.filter((l) => l.knownDeviceId === d.id);
        return {
          ...d,
          liveSessions: mine.length,
          isCurrent: mine.some((l) => l.id === current),
        };
      });
    });
  }

  /**
   * Signs a device out (ADR 0058): its live sessions end, with the push
   * tokens they registered, and its next login alerts as a new device.
   * Under the account's row lock, the one a login takes to record its
   * device and start its session: a login racing this either comes before
   * (its session is ended here) or after (the device is live again and the
   * alert went out). Saying it again changes nothing; another account's
   * device, or one disowned, is DEVICE_NOT_FOUND.
   */
  async revokeDevice(deviceId: string): Promise<number> {
    const accountId = this.ctx.accountId;
    const tenantId = this.ctx.tenantId;
    const count = await this.tenantTx.withTenantTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${accountId}::uuid FOR NO KEY UPDATE`;
      const device = await tx.knownDevice.findFirst({
        where: { id: deviceId, accountId, disownedAt: null },
        select: { id: true, revokedAt: true },
      });
      if (!device)
        throw appError.notFound(ErrorCode.DEVICE_NOT_FOUND, 'Device not found');
      if (!device.revokedAt)
        await tx.knownDevice.update({
          where: { id: deviceId },
          data: { revokedAt: new Date() },
        });
      const global = this.globalDb.in(tx);
      const sessions = await global.session.findMany({
        where: {
          accountId,
          tenantId,
          knownDeviceId: deviceId,
          revokedAt: null,
        },
        select: { id: true },
      });
      const ids = sessions.map((x) => x.id);
      if (!ids.length) return 0;
      await global.session.updateMany({
        where: { id: { in: ids }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await global.pushDevice.deleteMany({
        where: { sessionId: { in: ids }, accountId },
      });
      return ids.length;
    });
    await this.securityEvents.record('session.revoked', {
      tenantId,
      accountId,
      metadata: { reason: 'self', scope: 'device', deviceId, count },
    });
    return count;
  }

  /** The caller's logins (ADR 0058), newest first; the last 90 days. */
  async listMyLogins(
    q: { cursor?: string; limit?: number } = {},
  ): Promise<Page<MyLogin>> {
    const limit = clampLimit(q.limit);
    const current = this.cls.get('sessionId');
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.accountLogin.findMany({
        where: {
          AND: [
            { accountId: this.ctx.accountId },
            ...(LOGINS.after(q.cursor) as Prisma.AccountLoginWhereInput[]),
          ],
        },
        select: {
          id: true,
          createdAt: true,
          sessionId: true,
          knownDevice: { select: LABEL },
        },
        orderBy: LOGINS.orderBy,
        take: limit + 1,
      });
      const page = LOGINS.toPage(rows, limit);
      return {
        nextCursor: page.nextCursor,
        items: page.items.map((r) => ({
          id: r.id,
          at: r.createdAt,
          device: r.knownDevice,
          isCurrent: r.sessionId === current,
        })),
      };
    });
  }

  /** The login history's retention sweep: logins older than 90 days go. */
  private purgeLogins(now: Date): Promise<number> {
    const before = new Date(now.getTime() - LOGIN_RETENTION_DAYS * 86_400_000);
    return this.sweep.forEachTenant(async (tx) => {
      const { count } = await tx.accountLogin.deleteMany({
        where: { createdAt: { lt: before } },
      });
      return count;
    });
  }

  /** One of the caller's own sessions; anything else is "not found". */
  async revokeSession(sessionId: string): Promise<void> {
    const where = {
      id: sessionId,
      accountId: this.ctx.accountId,
      tenantId: this.ctx.tenantId,
    };
    // The push token that session registered goes with it (ADR 0041).
    const count = await this.globalDb.transaction(async (tx) => {
      const { count } = await tx.session.updateMany({
        where: { ...where, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count)
        await tx.pushDevice.deleteMany({
          where: { sessionId, accountId: where.accountId },
        });
      return count;
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
   * access token stops working on the next request. The domains react in
   * the same transaction (`AccountLifecycle.onSessionsRevoked`: entry
   * credentials go, ADR 0031). The account row is locked first, so a
   * request still in flight under one of these sessions cannot register
   * something after the revocation (it re-checks its session under the
   * same lock).
   */
  async revokeAllMySessions(): Promise<number> {
    const accountId = this.ctx.accountId;
    const tenantId = this.ctx.tenantId;
    const count = await this.tenantTx.withTenantTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${accountId}::uuid FOR UPDATE`;
      const { count } = await this.globalDb.in(tx).session.updateMany({
        where: { accountId, tenantId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.lifecycle.sessionsRevoked(tx, { id: accountId, tenantId });
      return count;
    });
    await this.securityEvents.record('session.revoked', {
      tenantId,
      accountId,
      metadata: { reason: 'self', scope: 'all', count },
    });
    return count;
  }
}

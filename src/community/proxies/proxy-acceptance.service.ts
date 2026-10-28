import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { AccountWriter } from '../../core/accounts/account-writer';
import { AuditService } from '../../core/audit/audit.service';
import { SecurityEventsService } from '../../core/audit/security-events.service';
import { IdentifierHasher } from '../../core/auth/identifier';
import { OtpService } from '../../core/auth/otp.service';
import type { AppClsStore } from '../../core/common/cls/app-cls';
import { appError, ErrorCode } from '../../core/common/errors';
import type { Locale } from '../../core/common/i18n/locale';
import type { Env } from '../../core/config/env.schema';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { dbNow } from '../db-clock';
import { lockUnits } from '../units/unit-lock';
import { PROXY_PERSONAL_GONE, ProxiesService } from './proxies.service';

const invalidCode = () =>
  appError.unauthorized(ErrorCode.OTP_INVALID, 'Invalid or expired code');

/**
 * Accepting a unit proxy invite (ADR 0063), as a household invite is
 * accepted (ADR 0016): the person has no account and no compound yet, so
 * the invite is found through the global `proxy_invite_tokens` row and
 * read with runInTenantUnsafe in exactly that compound (ESLint allows this
 * file).
 *
 * 1. start(token): a code goes to the invited email, and only to it; the
 *    answer never says whether the token was valid.
 * 2. complete(token, code): one transaction creates (or reuses) the
 *    person's `proxy` account, makes the proxy active, drops the invite's
 *    details and deletes its link. The person then logs in as any account.
 */
@Injectable()
export class ProxyAcceptanceService {
  private readonly logger = new Logger(ProxyAcceptanceService.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly globalDb: GlobalDbService,
    private readonly tenantTx: TenantTx,
    private readonly hasher: IdentifierHasher,
    private readonly otp: OtpService,
    private readonly rateLimit: RateLimitService,
    private readonly securityEvents: SecurityEventsService,
    private readonly writer: AccountWriter,
    private readonly audit: AuditService,
    private readonly cls: ClsService<AppClsStore>,
    private readonly proxies: ProxiesService,
  ) {}

  /** Rate-limited per IP and per token; the email leaves off the request path. */
  async start(token: string, ip: string, locale: Locale): Promise<void> {
    const tokenHash = this.hasher.hashProxyInviteToken(token);
    const window = this.config.get('OTP_RATE_LIMIT_WINDOW_SECONDS', {
      infer: true,
    });
    await this.rateLimit.consume(
      `proxy-start:ip:${ip}`,
      this.config.get('OTP_RATE_LIMIT_PER_IP', { infer: true }),
      window,
    );
    await this.rateLimit.consume(
      `proxy-start:token:${tokenHash}`,
      this.config.get('OTP_RATE_LIMIT_PER_IDENTIFIER', { infer: true }),
      window,
    );
    void this.sendCode(tokenHash, locale).catch((error: unknown) => {
      this.logger.error(
        `proxy code failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
    });
  }

  async complete(token: string, code: string, ip?: string): Promise<void> {
    if (ip !== undefined)
      await this.rateLimit.consume(
        `proxy-complete:ip:${ip}`,
        this.config.get('OTP_RATE_LIMIT_PER_IP', { infer: true }),
        this.config.get('OTP_RATE_LIMIT_WINDOW_SECONDS', { infer: true }),
      );
    const tokenHash = this.hasher.hashProxyInviteToken(token);
    const pointer = await this.livePointer(tokenHash);
    if (!pointer) {
      await this.tokenInvalid('complete', 'unknown_or_expired');
      throw invalidCode();
    }
    if (!(await this.otp.verifyInvite(tokenHash, code, 'proxy_accept'))) {
      await this.securityEvents.record('otp.verify_failed', {
        tenantId: pointer.tenantId,
        metadata: { purpose: 'proxy_accept' },
      });
      throw invalidCode();
    }
    // The system writes on the person's behalf: the code proved the email.
    const accepted = await this.cls.run({ ifNested: 'inherit' }, () => {
      this.cls.set('auditActor', { type: 'system', id: null });
      return this.tenantTx.runInTenantUnsafe(pointer.tenantId, (tx) =>
        this.accept(tx, pointer.tenantId, pointer.proxyId),
      );
    });
    if (!accepted) {
      await this.tokenInvalid('complete', 'invite_not_pending');
      throw invalidCode();
    }
  }

  // --------------------------------------------------------------------------

  private async sendCode(tokenHash: string, locale: Locale): Promise<void> {
    const pointer = await this.livePointer(tokenHash);
    if (!pointer) return this.tokenInvalid('start', 'unknown_or_expired');
    const invite = await this.tenantTx.runInTenantUnsafe(
      pointer.tenantId,
      (tx) =>
        tx.unitProxy.findFirst({
          where: {
            id: pointer.proxyId,
            status: 'invited',
            inviteExpiresAt: { gt: new Date() },
          },
          select: { email: true },
        }),
    );
    if (!invite?.email) return this.tokenInvalid('start', 'invite_not_pending');
    await this.otp.issueForInvite(
      tokenHash,
      invite.email,
      locale,
      'proxy_accept',
    );
  }

  private async livePointer(tokenHash: string) {
    const row = await this.globalDb.proxyInviteToken.findUnique({
      where: { tokenHash },
      include: { tenant: { select: { status: true } } },
    });
    if (!row || row.expiresAt <= new Date() || row.tenant.status !== 'active')
      return null;
    return { tenantId: row.tenantId, proxyId: row.proxyId };
  }

  /** Under the unit's lock: still invited and in time, else nothing. */
  private async accept(
    tx: TenantTxClient,
    tenantId: string,
    proxyId: string,
  ): Promise<boolean> {
    const found = await tx.unitProxy.findUnique({ where: { id: proxyId } });
    if (!found) return false;
    await lockUnits(tx, [found.unitId]);
    const invite = await tx.unitProxy.findUniqueOrThrow({
      where: { id: proxyId },
    });
    if (invite.status !== 'invited') return false;
    const now = await dbNow(tx);
    if (invite.inviteExpiresAt <= now) {
      await this.proxies.end(tx, invite, 'invite_expired', null);
      return false;
    }
    // The code proved the email: this compound's proxy account with it is
    // the same person, and is reused.
    const existing = await tx.account.findFirst({
      where: { type: 'proxy', email: invite.email! },
    });
    let accountId: string;
    if (existing) {
      accountId = existing.id;
      if (existing.status !== 'active')
        await this.writer.setStatus(tx, existing.id, 'active');
      const already = await tx.unitProxy.findFirst({
        where: { unitId: invite.unitId, accountId, status: 'active' },
        select: { id: true },
      });
      if (already) {
        // Already this unit's proxy: the older place stands.
        await this.proxies.end(tx, invite, 'revoked', null);
        return true;
      }
    } else {
      const created = await this.writer.create(tx, tenantId, {
        type: 'proxy',
        fullName: invite.fullName!,
        phone: invite.phone!,
        email: invite.email!,
        idDocumentType: invite.idDocumentType!,
        idDocumentNumber: invite.idDocumentNumber!,
        nationality: invite.nationality!,
        birthDate: invite.birthDate ?? undefined,
      });
      accountId = created.id;
    }
    await tx.unitProxy.update({
      where: { id: invite.id },
      data: {
        status: 'active',
        accountId,
        acceptedAt: now,
        ...PROXY_PERSONAL_GONE,
      },
    });
    await this.globalDb
      .in(tx)
      .proxyInviteToken.deleteMany({ where: { proxyId: invite.id } });
    await this.audit.record(tx, {
      action: 'unit_proxy.accepted',
      targetId: invite.id,
      metadata: { unitId: invite.unitId, accountId },
    });
    return true;
  }

  private tokenInvalid(stage: 'start' | 'complete', reason: string) {
    return this.securityEvents.record('invite.token_invalid', {
      metadata: { stage, reason, invite: 'unit_proxy' },
    });
  }
}

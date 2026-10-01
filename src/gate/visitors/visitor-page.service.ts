import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { VisitorPass, VisitorPassKind } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { CommunityGatePort, type GateSchedule } from '../../community';
import { AccessTokens, isToken } from '../../core/auth/access-token';
import { IdentifierHasher } from '../../core/auth/identifier';
import type { AppClsStore } from '../../core/common/cls/app-cls';
import type { Env } from '../../core/config/env.schema';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { Notifier } from '../../core/notifications/notifier';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import {
  passNotFound,
  passStatus,
  VisitorPassesService,
  type PassStatus,
} from './visitor-passes.service';

/** Why a pass was cancelled, as the visitor may read it: never security. */
export type VisitorStatusReason = 'host_cancelled' | 'wrong_recipient';
export const WRONG_RECIPIENT = 'wrong_recipient';

/** What the person holding the link sees (ADR 0030), and nothing else. */
export interface VisitorPage {
  compoundName: string;
  unitCode: string;
  kind: VisitorPassKind;
  partySize: number;
  validFrom: Date;
  validUntil: Date;
  timeZone: string;
  schedule: GateSchedule | null;
  status: PassStatus;
  statusReason: VisitorStatusReason | null;
  /** Only while the pass is active. */
  code: string | null;
  qrPayload: string | null;
  visitorDirections: string | null;
  emergencyPhone: string | null;
}

interface Resolved {
  tenantId: string;
  compoundName: string;
  passId: string;
}

/**
 * The visitor's public page (ADR 0030): "the link itself is the
 * verification". The token arrives in a POST body (the link carries it in
 * the fragment, which never reaches a server) and resolves through the
 * global pointer, so no compound is known beforehand. Every token that is
 * not a live link — unknown, malformed, replaced, expired, a worker's, a
 * suspended compound's — is the same 404, rate-limited per IP and per token
 * before anything is read.
 */
@Injectable()
export class VisitorPageService {
  private readonly perIp: number;
  private readonly perToken: number;

  constructor(
    private readonly globalDb: GlobalDbService,
    private readonly tenantTx: TenantTx,
    private readonly cls: ClsService<AppClsStore>,
    private readonly hasher: IdentifierHasher,
    private readonly tokens: AccessTokens,
    private readonly community: CommunityGatePort,
    private readonly settings: TenantSettingsService,
    private readonly passes: VisitorPassesService,
    private readonly notifier: Notifier,
    private readonly rateLimit: RateLimitService,
    config: ConfigService<Env, true>,
  ) {
    this.perIp = config.get('VISITOR_PAGE_RATE_LIMIT_PER_IP', { infer: true });
    this.perToken = config.get('VISITOR_PAGE_RATE_LIMIT_PER_TOKEN', {
      infer: true,
    });
  }

  async lookup(token: string, ip: string): Promise<VisitorPage> {
    const link = await this.resolve(token, ip);
    return this.tenantTx.runInTenantUnsafe(link.tenantId, async (tx) => {
      const pass = await tx.visitorPass.findUnique({
        where: { id: link.passId },
      });
      if (!pass) throw passNotFound();
      const settings = await this.settings.inTx(tx, link.tenantId);
      const status = passStatus(pass);
      const live = status === 'active' && this.isCurrent(pass, token);
      return {
        compoundName: link.compoundName,
        unitCode: await this.community.unitCode(tx, pass.unitId),
        kind: pass.kind,
        partySize: pass.partySize,
        validFrom: pass.validFrom,
        validUntil: pass.validUntil,
        timeZone: settings.timezone,
        schedule: (pass.schedule as GateSchedule | null) ?? null,
        status,
        statusReason:
          status !== 'cancelled'
            ? null
            : pass.cancelReasonCode === WRONG_RECIPIENT
              ? 'wrong_recipient'
              : 'host_cancelled',
        code: live ? this.tokens.codeOf(token, 6) : null,
        qrPayload: live ? this.tokens.qrPayload(token) : null,
        visitorDirections: settings.visitorDirections,
        emergencyPhone: settings.emergencyPhone,
      };
    });
  }

  /**
   * "This isn't me" (journey 10): the pass is cancelled with reason
   * `wrong_recipient`, the host is told (normal priority), the audit actor
   * is `system`. Nothing is asked of the visitor. Only an active pass:
   * anything else, a second call included, is the same 404.
   */
  async notMe(token: string, ip: string): Promise<void> {
    const link = await this.resolve(token, ip);
    await this.cls.run({ ifNested: 'inherit' }, async () => {
      this.cls.set('auditActor', { type: 'system', id: null });
      await this.tenantTx.runInTenantUnsafe(link.tenantId, (tx) =>
        this.cancelAsWrongRecipient(tx, link.passId, token),
      );
    });
  }

  private async cancelAsWrongRecipient(
    tx: TenantTxClient,
    passId: string,
    token: string,
  ): Promise<void> {
    // The lock gate entries and the host's cancel take: one of them wins.
    await tx.$queryRaw`SELECT id FROM visitor_passes WHERE id = ${passId}::uuid FOR UPDATE`;
    const pass = await tx.visitorPass.findUnique({ where: { id: passId } });
    if (!pass || passStatus(pass) !== 'active' || !this.isCurrent(pass, token))
      throw passNotFound();
    await this.passes.close(tx, pass.id, WRONG_RECIPIENT);
    await this.notifier.notify(tx, [pass.hostAccountId], {
      kind: 'visitor_pass.not_me',
      params: { unitCode: await this.community.unitCode(tx, pass.unitId) },
      targetId: pass.id,
    });
  }

  /** Rate limits, then the pointer; every miss is the same 404. */
  private async resolve(token: string, ip: string): Promise<Resolved> {
    const tokenHash = this.hasher.hashVisitorLink(token);
    await this.rateLimit.consume(`visitor-page:ip:${ip}`, this.perIp, 60);
    await this.rateLimit.consume(
      `visitor-page:token:${tokenHash}`,
      this.perToken,
      60,
    );
    if (!isToken(token)) throw passNotFound();
    const link = await this.globalDb.visitorPassLink.findUnique({
      where: { tokenHash },
      include: { tenant: { select: { status: true, name: true } } },
    });
    if (
      !link ||
      link.expiresAt.getTime() <= Date.now() ||
      link.tenant.status !== 'active'
    )
      throw passNotFound();
    return {
      tenantId: link.tenantId,
      compoundName: link.tenant.name,
      passId: link.passId,
    };
  }

  /** The pass's live token is this one (a replaced link has no pointer anyway). */
  private isCurrent(pass: VisitorPass, token: string): boolean {
    return (
      pass.qrTokenHash !== null &&
      pass.qrTokenHash === this.hasher.hashQrToken(pass.tenantId, token)
    );
  }
}

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommunityGatePort } from '../../community';
import { AccessTokens, isToken } from '../../core/auth/access-token';
import { IdentifierHasher } from '../../core/auth/identifier';
import { localToday } from '../../core/common/egyptian-national-id';
import { appError, ErrorCode } from '../../core/common/errors';
import type { WeeklySchedule } from '../../core/common/slots/weekly-schedule';
import type { Env } from '../../core/config/env.schema';
import { GlobalDbService } from '../../core/database/global-db.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';
import { pickupPayload } from './child-tokens';
import type { PickupPageView } from './views/pickup-page.views';

const pickupNotFound = () =>
  appError.notFound(ErrorCode.CHILD_PICKUP_NOT_FOUND, 'Pickup link not found');

const ofDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The page an outside escort opens from the household's link (ADR 0054),
 * like a visitor's (ADR 0030): no account, the link is the verification.
 * Rate-limited per IP and per link before anything is read (the visitor
 * page's limits); every token that is not a live link — unknown,
 * malformed, reissued, revoked, a suspended compound's — is the same 404.
 * The page never names the child, the household, the escort or anyone
 * else: the escort knows whom they collect.
 */
@Injectable()
export class PickupPageService {
  private readonly perIp: number;
  private readonly perToken: number;

  constructor(
    private readonly globalDb: GlobalDbService,
    private readonly tenantTx: TenantTx,
    private readonly hasher: IdentifierHasher,
    private readonly tokens: AccessTokens,
    private readonly community: CommunityGatePort,
    private readonly settings: TenantSettingsService,
    private readonly rateLimit: RateLimitService,
    config: ConfigService<Env, true>,
  ) {
    this.perIp = config.get('VISITOR_PAGE_RATE_LIMIT_PER_IP', { infer: true });
    this.perToken = config.get('VISITOR_PAGE_RATE_LIMIT_PER_TOKEN', {
      infer: true,
    });
  }

  async lookup(token: string, ip: string): Promise<PickupPageView> {
    const linkHash = this.hasher.hashChildPickupLink(token);
    await this.rateLimit.consume(`child-pickup-page:ip:${ip}`, this.perIp, 60);
    await this.rateLimit.consume(
      `child-pickup-page:token:${linkHash}`,
      this.perToken,
      60,
    );
    if (!isToken(token)) throw pickupNotFound();
    const link = await this.globalDb.childPickupLink.findUnique({
      where: { tokenHash: linkHash },
      include: { tenant: { select: { status: true, name: true } } },
    });
    if (!link || link.tenant.status !== 'active') throw pickupNotFound();
    return this.tenantTx.runInTenantUnsafe(link.tenantId, async (tx) => {
      const escort = await tx.childEscort.findUnique({
        where: { id: link.escortId },
      });
      if (
        !escort ||
        escort.revokedAt ||
        escort.pickupQrHash !==
          this.hasher.hashChildPickupQr(link.tenantId, token)
      )
        throw pickupNotFound();
      const settings = await this.settings.inTx(tx, link.tenantId);
      const today = ofDate(localToday(settings.timezone, await dbNow(tx)));
      const validFrom = ofDate(escort.validFrom);
      const validUntil = escort.validUntil ? ofDate(escort.validUntil) : null;
      const status =
        today < validFrom
          ? 'not_yet'
          : validUntil !== null && today > validUntil
            ? 'expired'
            : 'active';
      const gate = escort.gateId
        ? await tx.gate.findUnique({
            where: { id: escort.gateId },
            select: { name: true },
          })
        : null;
      const zone = escort.placeId
        ? await tx.place.findUnique({
            where: { id: escort.placeId },
            select: { nameEn: true, nameAr: true },
          })
        : null;
      return {
        compoundName: link.tenant.name,
        unitCode: await this.community.unitCode(tx, escort.unitId),
        validFrom,
        validUntil,
        timeZone: settings.timezone,
        schedule: (escort.schedule as WeeklySchedule | null) ?? null,
        post:
          gate || zone
            ? {
                gateName: gate?.name ?? null,
                zoneNameEn: zone?.nameEn ?? null,
                zoneNameAr: zone?.nameAr ?? null,
              }
            : null,
        status,
        code: status === 'active' ? this.tokens.codeOf(token, 6) : null,
        qrPayload: status === 'active' ? pickupPayload(token) : null,
        visitorDirections: settings.visitorDirections,
        emergencyPhone: settings.emergencyPhone,
      };
    });
  }
}

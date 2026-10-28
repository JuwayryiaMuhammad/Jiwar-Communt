import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { appError, ErrorCode } from '../../core/common/errors';
import type { Env } from '../../core/config/env.schema';
import { GlobalDbService } from '../../core/database/global-db.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import {
  WORKS_CERTIFICATE_CODE,
  worksCertificateNumber,
  worksCodeHash,
  type PublicWorksCertificate,
} from './permit-inspections.service';

const notFound = () =>
  appError.notFound(
    ErrorCode.WORKS_CERTIFICATE_NOT_FOUND,
    'Certificate not found',
  );

/**
 * The public works certificate check (ADR 0063), as the clearance check
 * (ADR 0062): a code that is not 22 base64url characters is refused before
 * any read; the global pointer (the code's SHA-256) names the compound; the
 * record is read there with runInTenantUnsafe (this file is named in
 * eslint.config.mjs). Rate-limited per IP; every miss is one 404. It shows
 * the compound, the number, the unit's code and the day — no person.
 */
@Injectable()
export class WorksCertificatePageService {
  private readonly perIp: number;

  constructor(
    config: ConfigService<Env, true>,
    private readonly globalDb: GlobalDbService,
    private readonly tenantTx: TenantTx,
    private readonly rateLimit: RateLimitService,
  ) {
    this.perIp = config.get('RECEIPT_PAGE_RATE_LIMIT_PER_IP', { infer: true });
  }

  async lookup(code: string, ip: string): Promise<PublicWorksCertificate> {
    await this.rateLimit.consume(`works-page:ip:${ip}`, this.perIp, 60);
    if (!WORKS_CERTIFICATE_CODE.test(code ?? '')) throw notFound();
    const link = await this.globalDb.worksCertificateLink.findUnique({
      where: { codeHash: worksCodeHash(code) },
      include: { tenant: { select: { name: true, status: true } } },
    });
    if (!link || link.tenant.status !== 'active') throw notFound();
    return this.tenantTx.runInTenantUnsafe(link.tenantId, async (tx) => {
      const row = await tx.permitInspection.findUnique({
        where: { id: link.inspectionId },
      });
      // The pointer must name this very code: a hash collision opens nothing.
      if (!row || row.verifyCode !== code || row.status !== 'passed')
        throw notFound();
      const permit = await tx.unitPermit.findUniqueOrThrow({
        where: { id: row.permitId },
        select: { unitId: true },
      });
      const unit = await tx.unit.findUniqueOrThrow({
        where: { id: permit.unitId },
        select: { code: true },
      });
      return {
        compoundName: link.tenant.name,
        number: worksCertificateNumber(row.certificateNumber!),
        unitCode: unit.code,
        passedAt: row.decidedAt!,
      };
    });
  }
}

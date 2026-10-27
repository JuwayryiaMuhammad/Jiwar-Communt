import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { appError, ErrorCode } from '../../core/common/errors';
import type { Env } from '../../core/config/env.schema';
import { GlobalDbService } from '../../core/database/global-db.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { formatNumber } from '../counters';
import { fromDate, localToday } from '../db-clock';
import {
  CLEARANCE_CODE,
  clearanceCodeHash,
  type PublicClearance,
} from './clearances.service';

const notFound = () =>
  appError.notFound(ErrorCode.CLEARANCE_NOT_FOUND, 'Clearance not found');

/**
 * The public clearance check (ADR 0062), as the receipt page (ADR 0046):
 * a code that is not 22 base64url characters is refused before any read;
 * the global pointer (the code's SHA-256) names the compound; the record is
 * read there with runInTenantUnsafe (this file is named in
 * eslint.config.mjs). Rate-limited per IP; every miss is one 404. It shows
 * the compound, the number, the unit and the dates — no person.
 */
@Injectable()
export class ClearancePageService {
  private readonly perIp: number;

  constructor(
    config: ConfigService<Env, true>,
    private readonly globalDb: GlobalDbService,
    private readonly tenantTx: TenantTx,
    private readonly rateLimit: RateLimitService,
  ) {
    this.perIp = config.get('RECEIPT_PAGE_RATE_LIMIT_PER_IP', { infer: true });
  }

  async lookup(code: string, ip: string): Promise<PublicClearance> {
    await this.rateLimit.consume(`clearance-page:ip:${ip}`, this.perIp, 60);
    if (!CLEARANCE_CODE.test(code ?? '')) throw notFound();
    const link = await this.globalDb.clearanceLink.findUnique({
      where: { codeHash: clearanceCodeHash(code) },
      include: { tenant: { select: { name: true, status: true } } },
    });
    if (!link || link.tenant.status !== 'active') throw notFound();
    return this.tenantTx.runInTenantUnsafe(link.tenantId, async (tx) => {
      const row = await tx.financeClearance.findUnique({
        where: { id: link.clearanceId },
        include: { unit: { select: { code: true } } },
      });
      // The pointer must name this very code: a hash collision opens nothing.
      if (!row || row.verifyCode !== code) throw notFound();
      const settings = await tx.tenantSettings.findUnique({
        where: { tenantId: link.tenantId },
        select: { timezone: true },
      });
      const today = await localToday(tx, settings?.timezone ?? 'Africa/Cairo');
      const validUntil = fromDate(row.validUntil);
      return {
        compoundName: link.tenant.name,
        number: formatNumber('clearance', row.number),
        unitCode: row.unit.code,
        asOf: row.asOf,
        validUntil,
        status: validUntil >= today ? 'valid' : 'expired',
      };
    });
  }
}

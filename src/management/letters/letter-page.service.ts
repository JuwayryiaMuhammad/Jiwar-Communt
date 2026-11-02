import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { appError, ErrorCode } from '../../core/common/errors';
import type { Env } from '../../core/config/env.schema';
import { GlobalDbService } from '../../core/database/global-db.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { LETTER_CODE, letterCodeHash } from './letter-rules';
import { LettersService, type PublicLetter } from './letters.service';

const notFound = () =>
  appError.notFound(ErrorCode.OFFICIAL_LETTER_NOT_FOUND, 'Letter not found');

/**
 * The public letter check (ADR 0080), as the clearance check (ADR 0062): a
 * code that is not 22 base64url characters is refused before any read; the
 * global pointer (the code's SHA-256) names the compound; the record is
 * read there with runInTenantUnsafe (this file is named in
 * eslint.config.mjs). Rate-limited per IP; every miss is one 404. It tells
 * whether the letter stands, the compound that issued it and the day —
 * never a name, a unit, a number or what it says.
 */
@Injectable()
export class LetterPageService {
  private readonly perIp: number;

  constructor(
    config: ConfigService<Env, true>,
    private readonly globalDb: GlobalDbService,
    private readonly tenantTx: TenantTx,
    private readonly rateLimit: RateLimitService,
    private readonly letters: LettersService,
  ) {
    this.perIp = config.get('RECEIPT_PAGE_RATE_LIMIT_PER_IP', { infer: true });
  }

  async lookup(code: string, ip: string): Promise<PublicLetter> {
    await this.rateLimit.consume(`letter-page:ip:${ip}`, this.perIp, 60);
    if (!LETTER_CODE.test(code ?? '')) throw notFound();
    const link = await this.globalDb.officialLetterLink.findUnique({
      where: { codeHash: letterCodeHash(code) },
    });
    const tenant = link
      ? await this.globalDb.tenant.findUnique({
          where: { id: link.tenantId },
          select: { name: true, status: true },
        })
      : null;
    if (!link || tenant?.status !== 'active') throw notFound();
    const found = await this.tenantTx.runInTenantUnsafe(link.tenantId, (tx) =>
      this.letters.publicOf(tx, link.letterId, code, tenant.name),
    );
    if (!found) throw notFound();
    return found;
  }
}

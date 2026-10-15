import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { appError, ErrorCode } from '../../core/common/errors';
import type { Env } from '../../core/config/env.schema';
import { GlobalDbService } from '../../core/database/global-db.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { formatNumber } from '../counters';
import { fromDate } from '../db-clock';
import { show } from '../money';
import { RECEIPT_CODE, receiptCodeHash } from '../payments/receipts';

/** What anyone holding a receipt's code may read: no names, no unit. */
export interface PublicReceipt {
  compoundName: string;
  receiptNumber: string;
  amount: string;
  currency: string;
  paidOn: string;
  status: 'valid' | 'reversed';
}

const notFound = () =>
  appError.notFound(ErrorCode.RECEIPT_NOT_FOUND, 'Receipt not found');

/**
 * The public receipt page (ADR 0046): a code that is not 22 base64url
 * characters is refused before any read; the global pointer (the code's
 * SHA-256) names the compound; the payment is then read in that compound
 * with runInTenantUnsafe (this file is named in eslint.config.mjs), as the
 * visitor page does. Rate-limited per IP.
 */
@Injectable()
export class ReceiptPageService {
  private readonly perIp: number;

  constructor(
    config: ConfigService<Env, true>,
    private readonly globalDb: GlobalDbService,
    private readonly tenantTx: TenantTx,
    private readonly rateLimit: RateLimitService,
  ) {
    this.perIp = config.get('RECEIPT_PAGE_RATE_LIMIT_PER_IP', { infer: true });
  }

  async lookup(code: string, ip: string): Promise<PublicReceipt> {
    await this.rateLimit.consume(`receipt-page:ip:${ip}`, this.perIp, 60);
    if (!RECEIPT_CODE.test(code)) throw notFound();
    const link = await this.globalDb.receiptLink.findUnique({
      where: { codeHash: receiptCodeHash(code) },
    });
    if (!link) throw notFound();
    const tenant = await this.globalDb.tenant.findUnique({
      where: { id: link.tenantId },
      select: { name: true },
    });
    const found = await this.tenantTx.runInTenantUnsafe(link.tenantId, (tx) =>
      tx.financePayment.findUnique({
        where: { id: link.paymentId },
        select: {
          kind: true,
          receiptCode: true,
          receiptNumber: true,
          amount: true,
          currency: true,
          paidOn: true,
          reversedBy: { select: { id: true } },
        },
      }),
    );
    // The pointer must name this very code: a hash collision opens nothing.
    if (!tenant || found?.kind !== 'payment' || found.receiptCode !== code)
      throw notFound();
    return {
      compoundName: tenant.name,
      receiptNumber: formatNumber('receipt', found.receiptNumber!),
      amount: show(found.amount!),
      currency: found.currency!,
      paidOn: fromDate(found.paidOn!),
      status: found.reversedBy ? 'reversed' : 'valid',
    };
  }
}

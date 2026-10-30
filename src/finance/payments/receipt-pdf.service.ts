import { Injectable } from '@nestjs/common';
import { CommunityFinancePort } from '../../community';
import { GlobalDbService } from '../../core/database/global-db.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { drawCertificate } from '../../core/pdf/certificate';
import { PdfRenderer } from '../../core/pdf/pdf-renderer';
import { RequestContext } from '../../core/common/cls/request-context';
import { PaymentsService } from './payments.service';
import { receiptContent } from './receipt-pdf';

/**
 * A payment's receipt as a PDF (ADR 0069), drawn on demand and never
 * stored: for whoever sees the unit's money (`staff` false), or the staff
 * who keep payments. The same payment draws the same page.
 */
@Injectable()
export class ReceiptPdfService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly globalDb: GlobalDbService,
    private readonly community: CommunityFinancePort,
    private readonly payments: PaymentsService,
    private readonly pdf: PdfRenderer,
  ) {}

  draw(id: string, staff: boolean): Promise<{ name: string; body: Buffer }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await this.payments.readable(tx, id, staff);
      const building =
        (await this.community.units(tx, [p.unitId])).get(p.unitId)?.building ??
        null;
      const { name: compound } = await this.globalDb
        .in(tx)
        .tenant.findUniqueOrThrow({
          where: { id: this.ctx.txTenantId },
          select: { name: true },
        });
      const body = await this.pdf.render(
        { title: p.receiptNumber, createdAt: p.createdAt },
        (page) =>
          drawCertificate(
            page,
            receiptContent(compound, {
              receiptNumber: p.receiptNumber,
              receiptCode: p.receiptCode,
              receiptUrl: p.receiptUrl,
              unitCode: p.unitCode,
              building,
              method: p.method,
              amount: p.amount,
              paidOn: p.paidOn,
              invoiceNumbers: p.allocations.map((a) => a.invoiceNumber),
              reversed: p.reversal !== null,
            }),
          ),
      );
      return { name: `${p.receiptNumber}.pdf`, body };
    });
  }
}

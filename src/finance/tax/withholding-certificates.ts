import { Prisma } from '@prisma/client';
import type { AuditService } from '../../core/audit/audit.service';
import type { CertificateContent } from '../../core/pdf/certificate';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { formatNumber, takeNumbers } from '../counters';
import { asDate } from '../db-clock';
import { show } from '../money';
import { egp } from '../payments/receipt-pdf';
import type { WithholdingCategory } from './tax-rules';

/**
 * A payout's withholding certificate (ADR 0093), written with it in its
 * transaction: the counter after the payout's (COUNTER_ORDER), audited
 * with ids and amounts.
 */
export async function issueCertificate(
  tx: TenantTxClient,
  audit: AuditService,
  c: {
    tenantId: string;
    payoutId: string;
    vendorId: string;
    category: Exclude<WithholdingCategory, 'exempt'>;
    rate: Prisma.Decimal;
    base: Prisma.Decimal;
    amount: Prisma.Decimal;
    paidOn: string;
  },
): Promise<string> {
  const id = newId();
  const number = await takeNumbers(tx, c.tenantId, 'withholding_certificate');
  await tx.financeWithholdingCertificate.create({
    data: {
      id,
      tenantId: c.tenantId,
      number,
      payoutId: c.payoutId,
      vendorId: c.vendorId,
      category: c.category,
      rate: c.rate,
      base: show(c.base),
      amount: show(c.amount),
      paidOn: asDate(c.paidOn),
    },
  });
  await audit.record(tx, {
    action: 'withholding_certificate.issued',
    targetId: id,
    metadata: {
      number: formatNumber('withholding_certificate', number),
      payoutId: c.payoutId,
      vendorId: c.vendorId,
      category: c.category,
      rate: show(c.rate),
      base: show(c.base),
      amount: show(c.amount),
      paidOn: c.paidOn,
    },
  });
  return id;
}

const CATEGORY: Record<string, { en: string; ar: string }> = {
  supplies: { en: 'Supplies', ar: 'توريدات' },
  services: { en: 'Services and contracting', ar: 'خدمات ومقاولات' },
  professional: { en: 'Professional fees', ar: 'أتعاب مهنية' },
};

/** What a withholding certificate's PDF shows: the compound's, the vendor's, the figures. */
export interface CertificateFacts {
  number: string;
  compoundTaxNumber: string | null;
  vendorName: string;
  vendorTaxNumber: string | null;
  payoutNumber: string;
  invoiceNumber: string | null;
  vendorInvoiceNumber: string | null;
  category: string;
  rate: string;
  base: string;
  amount: string;
  paidOn: string;
  quarter: string;
}

/**
 * A withholding certificate as a page, drawn by the certificate's layout
 * (certificate.v2) without a verify line: there is no public page for it.
 * A vendor is a company (ADR 0077); its name and tax number are the
 * compound's records.
 */
export function certificateContent(
  compound: string,
  f: CertificateFacts,
): CertificateContent {
  const cat = CATEGORY[f.category] ?? { en: f.category, ar: f.category };
  return {
    template: 'certificate.v2',
    compound,
    titleEn: 'Withholding tax certificate',
    titleAr: 'شهادة خصم من المنبع',
    number: f.number,
    rows: [
      ...(f.compoundTaxNumber
        ? [
            {
              labelEn: 'Compound tax number',
              labelAr: 'الرقم الضريبي للكمبوند',
              value: f.compoundTaxNumber,
            },
          ]
        : []),
      { labelEn: 'Vendor', labelAr: 'المورد', value: f.vendorName },
      ...(f.vendorTaxNumber
        ? [
            {
              labelEn: 'Vendor tax number',
              labelAr: 'الرقم الضريبي للمورد',
              value: f.vendorTaxNumber,
            },
          ]
        : []),
      { labelEn: 'Payout', labelAr: 'الصرف', value: f.payoutNumber },
      ...(f.vendorInvoiceNumber
        ? [
            {
              labelEn: 'Vendor invoice',
              labelAr: 'فاتورة المورد',
              value: f.vendorInvoiceNumber,
            },
          ]
        : []),
      { labelEn: 'Category', labelAr: 'الفئة', value: `${cat.en} — ${cat.ar}` },
      {
        labelEn: 'Amount subject',
        labelAr: 'المبلغ الخاضع',
        value: egp(f.base),
      },
      { labelEn: 'Rate', labelAr: 'النسبة', value: `${f.rate} %` },
      {
        labelEn: 'Tax withheld',
        labelAr: 'الضريبة المخصومة',
        value: egp(f.amount),
      },
      { labelEn: 'Paid on', labelAr: 'تاريخ الصرف', value: f.paidOn },
      { labelEn: 'Quarter', labelAr: 'الربع', value: f.quarter },
    ],
    statementEn: `The compound withheld ${egp(f.amount)} of tax from its payment to ${f.vendorName}, to be paid to the Egyptian Tax Authority.`,
    statementAr: `خصم الكمبوند ${egp(f.amount)} ضريبة من مدفوعاته إلى ${f.vendorName}، تُورَّد إلى مصلحة الضرائب المصرية.`,
  };
}

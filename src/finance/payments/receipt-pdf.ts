import type { CertificateContent } from '../../core/pdf/certificate';

/** What a receipt's PDF shows of a payment (ADR 0069): no name, no reference. */
export interface ReceiptFacts {
  receiptNumber: string;
  receiptCode: string;
  receiptUrl: string;
  unitCode: string;
  building: string | null;
  method: string;
  /** Two decimals, as the API writes money. */
  amount: string;
  paidOn: string;
  invoiceNumbers: string[];
  reversed: boolean;
}

const METHODS: Record<string, { en: string; ar: string }> = {
  cash: { en: 'in cash', ar: 'نقدًا' },
  bank_transfer: { en: 'by bank transfer', ar: 'بتحويل بنكي' },
  cheque: { en: 'by cheque', ar: 'بشيك' },
  card: { en: 'by card', ar: 'ببطاقة' },
  wallet: { en: 'by mobile wallet', ar: 'بمحفظة إلكترونية' },
  deposit_offset: { en: 'from the deposit', ar: 'من التأمين' },
};

/** `1250.00` → `1,250.00 EGP`: every amount in one form, the figure then EGP. */
export const egp = (amount: string) =>
  `${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(amount))} EGP`;

/**
 * A payment's receipt as a page (ADR 0069), drawn by the certificate's
 * layout (certificate.v2): bilingual, the values between the two
 * languages, the method in each language's own sentence, and the public
 * page and code that verify it. It names nobody — a receipt is forwarded —
 * and never the transfer's or cheque's reference.
 */
export function receiptContent(
  compound: string,
  r: ReceiptFacts,
): CertificateContent {
  const method = METHODS[r.method] ?? { en: '', ar: '' };
  return {
    template: 'certificate.v2',
    compound,
    titleEn: 'Payment receipt',
    titleAr: 'إيصال سداد',
    number: r.receiptNumber,
    rows: [
      // The code and the building apart: mixed in one value, the Arabic
      // word would reorder around the digits.
      { labelEn: 'Unit', labelAr: 'الوحدة', value: r.unitCode },
      ...(r.building
        ? [{ labelEn: 'Building', labelAr: 'المبنى', value: r.building }]
        : []),
      { labelEn: 'Amount', labelAr: 'المبلغ', value: egp(r.amount) },
      { labelEn: 'Paid on', labelAr: 'تاريخ السداد', value: r.paidOn },
      ...(r.invoiceNumbers.length
        ? [
            {
              labelEn: 'Invoices settled',
              labelAr: 'الفواتير المسددة',
              value: r.invoiceNumbers.join(', '),
            },
          ]
        : []),
      ...(r.reversed
        ? [{ labelEn: 'Status', labelAr: 'الحالة', value: 'REVERSED — ملغاة' }]
        : []),
    ],
    statementEn: r.reversed
      ? `This payment for unit ${r.unitCode} was reversed: the receipt no longer stands.`
      : `The compound received ${egp(r.amount)} ${method.en} for unit ${r.unitCode}.`,
    statementAr: r.reversed
      ? `أُلغيت هذه الدفعة عن الوحدة ${r.unitCode}: الإيصال لم يعد قائمًا.`
      : `استلم الكمبوند ${egp(r.amount)} ${method.ar} عن الوحدة ${r.unitCode}.`,
    verifyUrl: r.receiptUrl,
    verifyCode: r.receiptCode,
  };
}

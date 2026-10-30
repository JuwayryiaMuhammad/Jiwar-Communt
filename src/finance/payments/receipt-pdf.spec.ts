import { egp, receiptContent, type ReceiptFacts } from './receipt-pdf';

const facts: ReceiptFacts = {
  receiptNumber: 'RC-000042',
  receiptCode: 'abcdefghijklmnopqrstuv',
  receiptUrl: 'https://app.jiwar.example/receipt#abcdefghijklmnopqrstuv',
  unitCode: 'B-12',
  building: '3',
  method: 'bank_transfer',
  amount: '1250.00',
  paidOn: '2027-01-05',
  invoiceNumbers: ['INV-000101', 'INV-000102'],
  reversed: false,
};

describe('a payment’s receipt as a page (ADR 0069)', () => {
  it('amounts in one form, the figure then EGP', () => {
    expect(egp('1250.00')).toBe('1,250.00 EGP');
    expect(egp('0.50')).toBe('0.50 EGP');
  });

  it('the unit, its building, the amount, the day and the invoices; the method in each language’s sentence; no name', () => {
    const c = receiptContent('Al Yasmin', facts);
    expect(c).toMatchObject({
      template: 'certificate.v2',
      number: 'RC-000042',
      verifyCode: 'abcdefghijklmnopqrstuv',
      statementEn:
        'The compound received 1,250.00 EGP by bank transfer for unit B-12.',
      statementAr: 'استلم الكمبوند 1,250.00 EGP بتحويل بنكي عن الوحدة B-12.',
    });
    expect(c.rows.map((r) => [r.labelEn, r.value])).toEqual([
      ['Unit', 'B-12'],
      ['Building', '3'],
      ['Amount', '1,250.00 EGP'],
      ['Paid on', '2027-01-05'],
      ['Invoices settled', 'INV-000101, INV-000102'],
    ]);
  });

  it('a reversed payment says so, row and statement', () => {
    const c = receiptContent('Al Yasmin', {
      ...facts,
      building: null,
      invoiceNumbers: [],
      reversed: true,
    });
    expect(c.rows.map((r) => r.labelEn)).toEqual([
      'Unit',
      'Amount',
      'Paid on',
      'Status',
    ]);
    expect(c.statementEn).toMatch(/was reversed/);
  });
});

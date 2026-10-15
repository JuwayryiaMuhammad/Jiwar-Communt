import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import {
  newReceiptCode,
  RECEIPT_CODE,
  receiptCodeHash,
  receiptUrl,
} from './receipts';

describe('receipts (ADR 0046)', () => {
  it('a code is 128 random bits as 22 base64url characters, never twice', () => {
    const codes = new Set(Array.from({ length: 2000 }, newReceiptCode));
    expect(codes.size).toBe(2000);
    for (const c of codes) expect(c).toMatch(RECEIPT_CODE);
  });

  it('the pointer keeps the SHA-256 only; the link keeps the code in its fragment', () => {
    expect(receiptCodeHash('AAAAAAAAAAAAAAAAAAAAAA')).toMatch(/^[0-9a-f]{64}$/);
    expect(receiptUrl('https://app.test', 'abc')).toBe(
      'https://app.test/receipt#abc',
    );
  });

  it('the reversal reasons are the CHECK’s and the dashboards’', () => {
    const repo = join(__dirname, '../../..');
    const migration = readFileSync(
      join(repo, 'prisma/migrations/20261024090500_payments/migration.sql'),
      'utf8',
    );
    const dashboards = readFileSync(
      join(repo, 'packages/api/src/reasons.ts'),
      'utf8',
    );
    const quoted = REASON_CODES.paymentReverse.map((c) => `'${c}'`).join(', ');
    expect(migration).toContain(`"reason_code" IN (${quoted})`);
    expect(dashboards).toContain(`paymentReverse: [${quoted}]`);
  });
});

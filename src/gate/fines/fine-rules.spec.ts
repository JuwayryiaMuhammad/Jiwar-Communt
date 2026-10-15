import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import { FINE_AMOUNT } from './fine-rules';

describe('fine amounts (ADR 0045)', () => {
  it('EGP above zero, at most 100,000, two decimals at most', () => {
    for (const ok of ['1', '500', '500.5', '500.50', '100000', '0.01'])
      expect(FINE_AMOUNT.test(ok)).toBe(true);
    for (const bad of ['0', '0.00', '-5', '1000000', '5.555', '5,00', ''])
      expect(FINE_AMOUNT.test(bad)).toBe(false);
  });
});

describe('the fines’ reason codes', () => {
  const read = (path: string) =>
    readFileSync(join(__dirname, '../../..', path), 'utf8');
  const migration = read(
    'prisma/migrations/20261023090500_vehicle_fines/migration.sql',
  ).replace(/\s+/g, ' ');
  const dashboards = read('packages/api/src/reasons.ts');
  const quoted = (codes: readonly string[]) =>
    codes.map((c) => `'${c}'`).join(', ');

  it.each([
    'vehicleFineReason',
    'vehicleFineCancel',
    'vehicleFinePaymentReverse',
  ] as const)('%s matches its CHECK and the dashboards’ mirror', (list) => {
    const codes = REASON_CODES[list];
    expect(migration).toContain(`IN (${quoted(codes)})`);
    expect(dashboards).toContain(`${list}: [${quoted(codes)}]`);
  });
});

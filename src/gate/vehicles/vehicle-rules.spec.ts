import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import {
  EXPIRING_DAYS,
  normalizeSticker,
  permitStatus,
  reference,
} from './vehicle-rules';

describe('permitStatus (ADR 0045)', () => {
  const today = '2026-10-15';

  it('reads pending, rejected and removed as they are', () => {
    for (const s of ['pending', 'rejected', 'removed'] as const)
      expect(permitStatus(s, null, today)).toBe(s);
  });

  it('an active permit expires soon within 30 days of its last day, and expires after it', () => {
    expect(EXPIRING_DAYS).toBe(30);
    expect(permitStatus('active', '2026-11-15', today)).toBe('active');
    expect(permitStatus('active', '2026-11-14', today)).toBe('expires_soon');
    expect(permitStatus('active', today, today)).toBe('expires_soon');
    expect(permitStatus('active', '2026-10-14', today)).toBe('expired');
  });
});

describe('reference', () => {
  it('pads to four digits and grows past them', () => {
    expect(reference('V', 42)).toBe('V-0042');
    expect(reference('P', 8741)).toBe('P-8741');
    expect(reference('F', 12345)).toBe('F-12345');
  });
});

describe('normalizeSticker', () => {
  it('upper-cases letters, digits and dashes, 1–20', () => {
    expect(normalizeSticker(' ab-0012 ')).toBe('AB-0012');
    expect(normalizeSticker('A'.repeat(20))).toBe('A'.repeat(20));
    for (const bad of ['', ' ', 'A'.repeat(21), 'AB 12', 'ق12', 'A/1'])
      expect(normalizeSticker(bad)).toBeNull();
  });
});

describe('the vehicles’ reason codes (ADR 0045)', () => {
  const read = (path: string) =>
    readFileSync(join(__dirname, '../../..', path), 'utf8');
  const migration = read(
    'prisma/migrations/20261023090300_vehicles/migration.sql',
  );
  const dashboards = read('packages/api/src/reasons.ts');
  const quoted = (codes: readonly string[]) =>
    codes.map((c) => `'${c}'`).join(', ');

  it.each([
    'vehicleReject',
    'vehicleRemove',
    'vehicleStaffRemove',
    'vehicleSystemRemove',
  ] as const)('%s matches its CHECK and the dashboards’ mirror', (list) => {
    const codes = REASON_CODES[list];
    expect(migration.replace(/\s+/g, ' ')).toContain(`IN (${quoted(codes)})`);
    expect(dashboards).toContain(`${list}: [${quoted(codes)}]`);
  });
});

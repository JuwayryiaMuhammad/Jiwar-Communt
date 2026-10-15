import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import { freeSpaces, peakOverlap, type Window } from './parking-rules';

const t = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 20, h, m));
const w = (a: number, b: number): Window => ({
  startsAt: t(a),
  endsAt: t(b),
});

describe('peakOverlap (ADR 0045)', () => {
  it('counts what holds one instant, not what touches the window', () => {
    expect(peakOverlap([w(10, 11), w(12, 13)], t(10), t(13))).toBe(1);
    expect(peakOverlap([w(10, 12), w(11, 13)], t(10), t(13))).toBe(2);
    expect(peakOverlap([w(9, 14), w(10, 11), w(10, 11)], t(10), t(13))).toBe(3);
  });

  it('windows are half-open: one ending as another starts holds one space', () => {
    expect(peakOverlap([w(10, 11), w(11, 12)], t(10), t(12))).toBe(1);
  });

  it('only the part inside the window counts', () => {
    expect(peakOverlap([w(8, 10), w(13, 15)], t(10), t(13))).toBe(0);
    expect(peakOverlap([w(8, 11), w(12, 15)], t(10), t(13))).toBe(1);
    expect(peakOverlap([], t(10), t(13))).toBe(0);
  });
});

describe('freeSpaces', () => {
  it('capacity less what holds now, never below zero', () => {
    expect(freeSpaces(3, [w(9, 11), w(10, 12)], t(10, 30))).toBe(1);
    expect(freeSpaces(3, [w(9, 11), w(11, 12)], t(11))).toBe(2);
    expect(freeSpaces(1, [w(9, 11), w(10, 12)], t(10, 30))).toBe(0);
  });
});

describe('visitor parking reason codes', () => {
  const read = (path: string) =>
    readFileSync(join(__dirname, '../../..', path), 'utf8');
  const migration = read(
    'prisma/migrations/20261023090400_parking/migration.sql',
  ).replace(/\s+/g, ' ');
  const dashboards = read('packages/api/src/reasons.ts');
  const quoted = (codes: readonly string[]) =>
    codes.map((c) => `'${c}'`).join(', ');

  it.each([
    'visitorParkingResidentCancel',
    'visitorParkingStaffCancel',
    'visitorParkingSystemCancel',
  ] as const)('%s matches its CHECK and the dashboards’ mirror', (list) => {
    const codes = REASON_CODES[list];
    expect(migration).toContain(`IN (${quoted(codes)})`);
    expect(dashboards).toContain(`${list}: [${quoted(codes)}]`);
  });
});

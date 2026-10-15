import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import {
  ETA_MINUTES,
  minutesAway,
  safetyReference,
  seriesOf,
  WHEN_OFFSET_MINUTES,
} from './safety-rules';

const read = (path: string) =>
  readFileSync(join(__dirname, '../../..', path), 'utf8');
const emergencies = read(
  'prisma/migrations/20261025090500_emergencies/migration.sql',
).replace(/\s+/g, ' ');
const services = read(
  'prisma/migrations/20261025090600_gate_service_requests/migration.sql',
).replace(/\s+/g, ' ');
const mirror = read('packages/api/src/reasons.ts');
const quoted = (list: readonly string[]) =>
  list.map((c) => `'${c}'`).join(', ');

describe('safety references', () => {
  it('pad to four digits and grow past them', () => {
    expect(safetyReference('E', 42)).toBe('E-0042');
    expect(safetyReference('A', 7)).toBe('A-0007');
    expect(safetyReference('S', 123456)).toBe('S-123456');
  });
});

describe('minutesAway', () => {
  const at = new Date('2026-10-25T10:00:00Z');
  const after = (ms: number) => new Date(at.getTime() + ms);
  const base = { etaMinutes: 5, acceptedAt: at, arrivedAt: null };

  it('null until someone accepts', () => {
    expect(
      minutesAway(
        {
          status: 'reported',
          etaMinutes: null,
          acceptedAt: null,
          arrivedAt: null,
        },
        at,
      ),
    ).toBeNull();
  });

  it('counts down from the acceptance, up to the next minute, never below 0', () => {
    const on = { ...base, status: 'on_the_way' };
    expect(minutesAway(on, at)).toBe(5);
    expect(minutesAway(on, after(1))).toBe(5);
    expect(minutesAway(on, after(60_000))).toBe(4);
    expect(minutesAway(on, after(4 * 60_000 + 1))).toBe(1);
    expect(minutesAway(on, after(5 * 60_000))).toBe(0);
    expect(minutesAway(on, after(30 * 60_000))).toBe(0);
    // A gate service request counts down the same while accepted or started.
    expect(minutesAway({ ...base, status: 'accepted' }, after(60_000))).toBe(4);
    expect(minutesAway({ ...base, status: 'in_progress' }, at)).toBe(5);
  });

  it('0 once arrived; null once closed', () => {
    expect(
      minutesAway({ ...base, status: 'arrived', arrivedAt: after(1) }, at),
    ).toBe(0);
    for (const status of ['resolved', 'cancelled', 'closed'])
      expect(minutesAway({ ...base, status }, at)).toBeNull();
    expect(
      minutesAway({ ...base, status: 'resolved', arrivedAt: after(1) }, at),
    ).toBeNull();
  });
});

describe('the emergencies’ lists (ADR 0047)', () => {
  it('the minutes match their CHECK', () => {
    expect(emergencies).toContain(
      `"eta_minutes" IN (${ETA_MINUTES.join(', ')})`,
    );
  });

  it.each(['emergencyCancel', 'emergencyResolve'] as const)(
    '%s matches its CHECK and the dashboards’ mirror',
    (list) => {
      const q = quoted(REASON_CODES[list]);
      expect(emergencies).toContain(`IN (${q})`);
      expect(mirror).toContain(`${list}: [${q}]`);
    },
  );
});

describe('the gate service requests’ lists (ADR 0047)', () => {
  it.each([
    'assistanceKind',
    'gateServiceWhen',
    'laneReason',
    'gateServiceClose',
  ] as const)('%s matches its CHECK and the dashboards’ mirror', (list) => {
    const q = quoted(REASON_CODES[list]);
    expect(services).toContain(`IN (${q})`);
    expect(mirror).toContain(`${list}: [${q}]`);
  });

  it('the when codes are the offsets; the minutes match their CHECK', () => {
    expect(Object.keys(WHEN_OFFSET_MINUTES)).toEqual([
      ...REASON_CODES.gateServiceWhen,
    ]);
    expect(services).toContain(`"eta_minutes" IN (${ETA_MINUTES.join(', ')})`);
  });

  it('accessibility is numbered A-, the rest S-', () => {
    expect(seriesOf('accessibility')).toEqual({
      series: 'accessibility',
      prefix: 'A',
    });
    for (const kind of ['suspicious', 'escort', 'lane'] as const)
      expect(seriesOf(kind)).toEqual({ series: 'service', prefix: 'S' });
  });
});

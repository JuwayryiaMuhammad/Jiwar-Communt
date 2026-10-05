import type { DispatchSettingsView } from './dispatch-settings.service';
import {
  OPEN_STATUSES,
  points,
  rank,
  scaleWeights,
  workloadOf,
  type Candidate,
  type OpenCount,
} from './workload';

/** The defaults of ADR 0033. */
const DEFAULTS: DispatchSettingsView = {
  autoDispatchEnabled: true,
  weightAssigned: 1,
  weightInProgress: 2,
  weightOnHold: 0,
  multiplierNormal: 1,
  multiplierUrgent: 1.5,
  multiplierEmergency: 3,
};

const load = (open: OpenCount[], settings = DEFAULTS) =>
  points(workloadOf(open, scaleWeights(settings)));

describe('workload', () => {
  it('is the sum of status weight × priority multiplier over the open tickets', () => {
    expect(
      load([
        { status: 'assigned', priority: 'normal', count: 2 }, // 2 × 1 × 1 = 2
        { status: 'in_progress', priority: 'urgent', count: 1 }, // 2 × 1.5 = 3
        { status: 'assigned', priority: 'emergency', count: 1 }, // 1 × 3 = 3
        { status: 'in_progress', priority: 'normal', count: 3 }, // 3 × 2 × 1 = 6
      ]),
    ).toBe(14);
  });

  it('weighs a ticket on the way like one in progress (ADR 0038)', () => {
    expect(load([{ status: 'en_route', priority: 'urgent', count: 2 }])).toBe(
      load([{ status: 'in_progress', priority: 'urgent', count: 2 }]),
    );
    expect(
      load([{ status: 'en_route', priority: 'normal', count: 1 }], {
        ...DEFAULTS,
        weightInProgress: 4.25,
      }),
    ).toBe(4.25);
  });

  it('is zero without tickets', () => {
    expect(load([])).toBe(0);
  });

  it('counts an on-hold ticket as zero, whatever its priority', () => {
    expect(
      load([
        { status: 'on_hold', priority: 'emergency', count: 5 },
        { status: 'on_hold', priority: 'normal', count: 1 },
      ]),
    ).toBe(0);
    // Until the manager says it weighs something.
    expect(
      load([{ status: 'on_hold', priority: 'urgent', count: 2 }], {
        ...DEFAULTS,
        weightOnHold: 0.5,
      }),
    ).toBe(1.5);
  });

  it('only assigned, en-route, in-progress and on-hold tickets are open', () => {
    expect([...OPEN_STATUSES]).toEqual([
      'assigned',
      'en_route',
      'in_progress',
      'on_hold',
    ]);
  });

  it('is exact in hundredths: no floating-point drift in a sum', () => {
    // 0.1 + 0.2 ≠ 0.3 in floating point; here the tenth is an integer count.
    const weights = { ...DEFAULTS, weightAssigned: 0.1, multiplierUrgent: 1.1 };
    const a = workloadOf(
      [{ status: 'assigned', priority: 'urgent', count: 3 }],
      scaleWeights(weights),
    );
    const b = workloadOf(
      [
        { status: 'assigned', priority: 'urgent', count: 1 },
        { status: 'assigned', priority: 'urgent', count: 2 },
      ],
      scaleWeights(weights),
    );
    expect(a).toBe(b);
    expect(a).toBe(3300); // 3 × 10 × 110 ten-thousandths: 0.33 points
    expect(points(a)).toBe(0.33);
  });

  it('changes with the settings', () => {
    expect(
      load([{ status: 'in_progress', priority: 'emergency', count: 1 }], {
        ...DEFAULTS,
        weightInProgress: 4,
        multiplierEmergency: 2.5,
      }),
    ).toBe(10);
  });
});

describe('choosing a technician', () => {
  const at = (iso: string) => new Date(iso);
  const c = (
    id: string,
    workload: number,
    lastAssignedAt: Date | null = null,
  ): Candidate => ({ id, workload, lastAssignedAt });

  it('prefers the lowest workload', () => {
    expect(
      rank([c('a', 30000), c('b', 10000), c('c', 20000)]).map((x) => x.id),
    ).toEqual(['b', 'c', 'a']);
  });

  it('breaks a tie with the oldest last assignment', () => {
    expect(
      rank([
        c('a', 10000, at('2026-10-02T10:00:00Z')),
        c('b', 10000, at('2026-10-01T10:00:00Z')),
        c('c', 10000, at('2026-10-03T10:00:00Z')),
      ]).map((x) => x.id),
    ).toEqual(['b', 'a', 'c']);
  });

  it('treats never assigned as the oldest of all', () => {
    expect(
      rank([
        c('a', 0, at('2020-01-01T00:00:00Z')),
        c('b', 0, null),
        c('c', 0, at('2026-01-01T00:00:00Z')),
      ]).map((x) => x.id),
    ).toEqual(['b', 'a', 'c']);
  });

  it('breaks a full tie with the id, so the answer never depends on input order', () => {
    const same = at('2026-10-01T10:00:00Z');
    const list = [c('c', 5, same), c('a', 5, same), c('b', 5, same)];
    expect(rank(list).map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(rank([...list].reverse()).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('workload outranks last assignment, and last assignment outranks id', () => {
    expect(
      rank([
        c('a', 20000, at('2020-01-01T00:00:00Z')),
        c('z', 10000, at('2026-10-01T00:00:00Z')),
        c('b', 10000, at('2026-09-01T00:00:00Z')),
      ]).map((x) => x.id),
    ).toEqual(['b', 'z', 'a']);
  });

  it('does not change its input', () => {
    const list = [c('b', 2), c('a', 1)];
    rank(list);
    expect(list.map((x) => x.id)).toEqual(['b', 'a']);
  });
});

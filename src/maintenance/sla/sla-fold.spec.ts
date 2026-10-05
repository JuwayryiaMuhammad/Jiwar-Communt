import type { SlaEventKind } from '@prisma/client';
import { elapsedMs, fold, type SlaEventLike } from './sla-fold';

const T0 = Date.UTC(2030, 0, 1, 8, 0, 0);
const MIN = 60_000;

/** Events at minute offsets from T0, numbered in order. */
function events(...rows: [SlaEventKind, number, number?][]): SlaEventLike[] {
  let target = 60;
  return rows.map(([kind, minute, newTarget], i) => {
    if (newTarget !== undefined) target = newTarget;
    return {
      seq: i + 1,
      kind,
      at: new Date(T0 + minute * MIN),
      targetMinutes: target,
    };
  });
}

const at = (minute: number) => new Date(T0 + minute * MIN);

describe('SLA fold', () => {
  it('a started clock is due at start + target', () => {
    expect(fold(events(['started', 0]))).toEqual({
      state: 'running',
      targetMinutes: 60,
      startedAt: at(0),
      dueAt: at(60),
      pausedAt: null,
      endedAt: null,
      lastSeq: 1,
    });
  });

  it('a pause stops the clock; a resume pushes the due time by the pause', () => {
    const paused = fold(events(['started', 0], ['paused', 20]));
    expect(paused).toMatchObject({
      state: 'paused',
      dueAt: null,
      pausedAt: at(20),
    });
    const resumed = fold(
      events(['started', 0], ['paused', 20], ['resumed', 50]),
    );
    expect(resumed).toMatchObject({
      state: 'running',
      dueAt: at(90),
      pausedAt: null,
    });
    expect(
      elapsedMs(
        events(['started', 0], ['paused', 20], ['resumed', 50]),
        at(70),
      ),
    ).toBe(40 * MIN);
  });

  it('a retarget is measured from the same start, pauses excluded', () => {
    const p = fold(
      events(
        ['started', 0],
        ['paused', 10],
        ['resumed', 40],
        ['retargeted', 45, 120],
      ),
    );
    expect(p).toMatchObject({
      state: 'running',
      targetMinutes: 120,
      dueAt: at(150),
    });
    // Retargeted while paused: no due time until it runs again.
    const q = fold(
      events(['started', 0], ['paused', 10], ['retargeted', 15, 30]),
    );
    expect(q).toMatchObject({
      state: 'paused',
      targetMinutes: 30,
      dueAt: null,
    });
  });

  it('met, breached and stopped end the clock', () => {
    for (const kind of ['met', 'breached', 'stopped'] as const)
      expect(fold(events(['started', 0], [kind, 30]))).toMatchObject({
        state: kind,
        dueAt: null,
        pausedAt: null,
        endedAt: at(30),
      });
    // Met from a pause (resolution at close): the time after completion
    // does not count.
    const met = events(['started', 0], ['paused', 30], ['met', 500]);
    expect(fold(met)).toMatchObject({ state: 'met', endedAt: at(500) });
    expect(elapsedMs(met, at(9999))).toBe(30 * MIN);
  });

  it('refuses a history the recorder never writes', () => {
    expect(() => fold([])).toThrow(/starts with/);
    expect(() => fold(events(['paused', 0]))).toThrow(/starts with/);
    expect(() =>
      fold(events(['started', 0], ['met', 5], ['paused', 6])),
    ).toThrow(/may follow/);
    expect(() => fold(events(['started', 0], ['resumed', 5]))).toThrow(
      /while running/,
    );
    expect(() =>
      fold(events(['started', 0], ['paused', 5], ['paused', 6])),
    ).toThrow(/while not running/);
  });

  it('orders by seq, whatever order the rows come in', () => {
    const rows = events(['started', 0], ['paused', 20], ['resumed', 50]);
    expect(fold([...rows].reverse())).toEqual(fold(rows));
  });
});

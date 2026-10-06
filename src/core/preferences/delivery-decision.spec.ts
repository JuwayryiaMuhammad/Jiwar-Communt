import {
  NOTIFICATION_CATEGORIES,
  DELIVERY_CHANNELS,
  type DeliveryClass,
} from './categories';
import {
  DEFAULT_PREFS,
  deliveryDecision,
  quietEnd,
  type DeliveryDecision,
  type DeliveryPrefs,
} from './delivery-decision';

const at = (iso: string) => new Date(iso);
const DAY = { start: '09:00', end: '17:00' };
const NIGHT = { start: '22:00', end: '07:00' };

type Pause = 'none' | 'timed' | 'expired' | 'indefinite';
/** `deliver`, `indefinite`, or the ISO instant the hold ends. */
type Expect = string;

/**
 * The quiet-hours × pause part of the decision, in UTC, worked out by hand:
 * [label, window, now, pause, soleRecord, expected]. A timed pause ends one
 * hour after `now`; an expired one ended a minute before it.
 */
const TIMING: [string, typeof DAY | null, string, Pause, boolean, Expect][] = [
  ['no quiet hours', null, '2026-10-06T12:00:00Z', 'none', false, 'deliver'],
  [
    'no quiet hours, timed pause',
    null,
    '2026-10-06T12:00:00Z',
    'timed',
    false,
    '2026-10-06T13:00:00.000Z',
  ],
  [
    'no quiet hours, expired pause',
    null,
    '2026-10-06T12:00:00Z',
    'expired',
    false,
    'deliver',
  ],
  [
    'no quiet hours, indefinite pause',
    null,
    '2026-10-06T12:00:00Z',
    'indefinite',
    false,
    'indefinite',
  ],
  [
    'no quiet hours, indefinite pause, sole record',
    null,
    '2026-10-06T12:00:00Z',
    'indefinite',
    true,
    'deliver',
  ],
  [
    'no quiet hours, timed pause, sole record',
    null,
    '2026-10-06T12:00:00Z',
    'timed',
    true,
    '2026-10-06T13:00:00.000Z',
  ],

  [
    'inside a day window',
    DAY,
    '2026-10-06T12:00:00Z',
    'none',
    false,
    '2026-10-06T17:00:00.000Z',
  ],
  [
    'inside a day window, sole record',
    DAY,
    '2026-10-06T12:00:00Z',
    'none',
    true,
    '2026-10-06T17:00:00.000Z',
  ],
  [
    'at the start of a day window',
    DAY,
    '2026-10-06T09:00:00Z',
    'none',
    false,
    '2026-10-06T17:00:00.000Z',
  ],
  [
    'at the end of a day window',
    DAY,
    '2026-10-06T17:00:00Z',
    'none',
    false,
    'deliver',
  ],
  ['after a day window', DAY, '2026-10-06T18:00:00Z', 'none', false, 'deliver'],
  [
    'before a day window',
    DAY,
    '2026-10-06T08:59:00Z',
    'none',
    false,
    'deliver',
  ],
  [
    'timed pause ending inside a day window',
    DAY,
    '2026-10-06T08:30:00Z',
    'timed',
    false,
    '2026-10-06T17:00:00.000Z',
  ],
  [
    'timed pause ending after a day window',
    DAY,
    '2026-10-06T16:30:00Z',
    'timed',
    false,
    '2026-10-06T17:30:00.000Z',
  ],
  [
    'indefinite pause inside a day window',
    DAY,
    '2026-10-06T12:00:00Z',
    'indefinite',
    false,
    'indefinite',
  ],
  [
    'indefinite pause inside a day window, sole record',
    DAY,
    '2026-10-06T12:00:00Z',
    'indefinite',
    true,
    '2026-10-06T17:00:00.000Z',
  ],
  [
    'indefinite pause outside a day window, sole record',
    DAY,
    '2026-10-06T18:00:00Z',
    'indefinite',
    true,
    'deliver',
  ],
  [
    'expired pause inside a day window',
    DAY,
    '2026-10-06T12:00:00Z',
    'expired',
    false,
    '2026-10-06T17:00:00.000Z',
  ],

  [
    'before midnight in a night window',
    NIGHT,
    '2026-10-06T23:00:00Z',
    'none',
    false,
    '2026-10-07T07:00:00.000Z',
  ],
  [
    'after midnight in a night window',
    NIGHT,
    '2026-10-07T03:00:00Z',
    'none',
    false,
    '2026-10-07T07:00:00.000Z',
  ],
  [
    'at the start of a night window',
    NIGHT,
    '2026-10-06T22:00:00Z',
    'none',
    false,
    '2026-10-07T07:00:00.000Z',
  ],
  [
    'at the end of a night window',
    NIGHT,
    '2026-10-07T07:00:00Z',
    'none',
    false,
    'deliver',
  ],
  [
    'a minute before the end of a night window',
    NIGHT,
    '2026-10-07T06:59:00Z',
    'none',
    false,
    '2026-10-07T07:00:00.000Z',
  ],
  [
    'midday, outside a night window',
    NIGHT,
    '2026-10-06T12:00:00Z',
    'none',
    false,
    'deliver',
  ],
  [
    'just before a night window',
    NIGHT,
    '2026-10-06T21:59:00Z',
    'none',
    false,
    'deliver',
  ],
  [
    'timed pause from before a night window into it',
    NIGHT,
    '2026-10-06T21:30:00Z',
    'timed',
    false,
    '2026-10-07T07:00:00.000Z',
  ],
  [
    'timed pause across midnight, still in the window',
    NIGHT,
    '2026-10-06T23:30:00Z',
    'timed',
    false,
    '2026-10-07T07:00:00.000Z',
  ],
  [
    'timed pause ending after a night window',
    NIGHT,
    '2026-10-07T06:30:00Z',
    'timed',
    false,
    '2026-10-07T07:30:00.000Z',
  ],
  [
    'timed pause, sole record, in a night window',
    NIGHT,
    '2026-10-06T23:00:00Z',
    'timed',
    true,
    '2026-10-07T07:00:00.000Z',
  ],
  [
    'indefinite pause in a night window',
    NIGHT,
    '2026-10-06T23:00:00Z',
    'indefinite',
    false,
    'indefinite',
  ],
  [
    'indefinite pause in a night window, sole record',
    NIGHT,
    '2026-10-06T23:00:00Z',
    'indefinite',
    true,
    '2026-10-07T07:00:00.000Z',
  ],
  [
    'indefinite pause after midnight, sole record',
    NIGHT,
    '2026-10-07T03:00:00Z',
    'indefinite',
    true,
    '2026-10-07T07:00:00.000Z',
  ],
  [
    'expired pause in a night window',
    NIGHT,
    '2026-10-07T03:00:00Z',
    'expired',
    false,
    '2026-10-07T07:00:00.000Z',
  ],
];

function prefsFor(
  window: typeof DAY | null,
  now: Date,
  pause: Pause,
  off: boolean,
  category: DeliveryClass['category'],
  channel: 'email' | 'push',
): DeliveryPrefs {
  return {
    ...DEFAULT_PREFS('UTC'),
    channels: off ? { [category]: { [channel]: false } } : {},
    quietHours: window,
    pause:
      pause === 'none'
        ? null
        : pause === 'indefinite'
          ? { until: null }
          : {
              until: new Date(
                now.getTime() + (pause === 'timed' ? 3_600_000 : -60_000),
              ),
            },
  };
}

function expected(
  critical: boolean,
  off: boolean,
  sole: boolean,
  timing: Expect,
): DeliveryDecision {
  if (critical) return { action: 'deliver' };
  if (off && !sole) return { action: 'skip' };
  if (timing === 'deliver') return { action: 'deliver' };
  if (timing === 'indefinite') return { action: 'hold', until: null };
  return { action: 'hold', until: new Date(timing) };
}

describe('deliveryDecision', () => {
  // Every combination: critical or not × channel × category on or off ×
  // every timing case above (quiet hours, crossing midnight, pause), each
  // in every category.
  for (const critical of [false, true])
    for (const channel of DELIVERY_CHANNELS)
      for (const off of [false, true])
        for (const [label, window, now, pause, sole, timing] of TIMING)
          it(`${critical ? 'critical' : 'normal'} · ${channel} · category ${off ? 'off' : 'on'} · ${label}`, () => {
            for (const category of NOTIFICATION_CATEGORIES) {
              const klass: DeliveryClass = {
                category,
                critical,
                soleRecord: sole,
              };
              const prefs = prefsFor(
                window,
                at(now),
                pause,
                off,
                category,
                channel,
              );
              expect(deliveryDecision(prefs, klass, channel, at(now))).toEqual(
                expected(critical, off, sole, timing),
              );
            }
          });

  it('a category turned off for one channel leaves the other', () => {
    const prefs: DeliveryPrefs = {
      ...DEFAULT_PREFS('UTC'),
      channels: { household: { email: false } },
    };
    const klass: DeliveryClass = { category: 'household', critical: false };
    const now = at('2026-10-06T12:00:00Z');
    expect(deliveryDecision(prefs, klass, 'email', now)).toEqual({
      action: 'skip',
    });
    expect(deliveryDecision(prefs, klass, 'push', now)).toEqual({
      action: 'deliver',
    });
    expect(
      deliveryDecision(prefs, { ...klass, category: 'parcels' }, 'email', now),
    ).toEqual({ action: 'deliver' });
  });

  it('the defaults deliver everything now', () => {
    const now = at('2026-10-06T03:00:00Z');
    for (const category of NOTIFICATION_CATEGORIES)
      for (const channel of DELIVERY_CHANNELS)
        expect(
          deliveryDecision(
            DEFAULT_PREFS('Africa/Cairo'),
            { category, critical: false },
            channel,
            now,
          ),
        ).toEqual({ action: 'deliver' });
  });

  it("reads quiet hours in the compound's time zone", () => {
    // 23:00 in Cairo (UTC+3 in October 2026, before the end of summer time).
    const prefs: DeliveryPrefs = {
      ...DEFAULT_PREFS('Africa/Cairo'),
      quietHours: NIGHT,
    };
    const klass: DeliveryClass = { category: 'maintenance', critical: false };
    expect(
      deliveryDecision(prefs, klass, 'email', at('2026-10-06T20:00:00Z')),
    ).toEqual({ action: 'hold', until: at('2026-10-07T04:00:00Z') });
    // 20:00 in Cairo: outside.
    expect(
      deliveryDecision(prefs, klass, 'email', at('2026-10-06T17:00:00Z')),
    ).toEqual({ action: 'deliver' });
  });

  it('a window that ends after the change to summer time ends at local 07:00', () => {
    // Egypt moves its clocks forward at local midnight on 24 April 2026:
    // 23:00 on the 23rd is UTC+2, 07:00 on the 24th is UTC+3.
    expect(quietEnd(NIGHT, 'Africa/Cairo', at('2026-04-23T21:00:00Z'))).toEqual(
      at('2026-04-24T04:00:00Z'),
    );
  });

  it('a window that ends after the change back to winter time ends at local 07:00', () => {
    // Back to UTC+2 at the end of 29 October 2026.
    expect(quietEnd(NIGHT, 'Africa/Cairo', at('2026-10-29T19:30:00Z'))).toEqual(
      at('2026-10-30T05:00:00Z'),
    );
  });

  it('a malformed or empty window holds nothing', () => {
    const now = at('2026-10-06T12:00:00Z');
    expect(quietEnd({ start: '12:00', end: '12:00' }, 'UTC', now)).toBeNull();
    expect(quietEnd({ start: '25:00', end: '07:00' }, 'UTC', now)).toBeNull();
  });
});

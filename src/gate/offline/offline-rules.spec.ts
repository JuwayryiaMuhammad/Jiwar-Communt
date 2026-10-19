import {
  actionHash,
  BATCH_MAX,
  FLAG_CLASS,
  FLAG_KINDS,
  parseUpload,
  quarantineBody,
  refusalFlag,
  SKEW_MS,
  whenOf,
} from './offline-rules';

// Instants written out, never read from a clock.
const T0 = new Date('2026-11-06T09:00:00.000Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;
const BATCH = '01a102b6-6253-74a0-92b1-a0c4e5f60718';
const BUNDLE = '01a102b6-6253-74a0-92b1-a0c4e5f60719';
const SUBJECT = '01a102b6-6253-74a0-92b1-a0c4e5f60720';
const id = (n: number) =>
  `01a102b6-6253-74a0-92b1-${n.toString(16).padStart(12, '0')}`;

const action = (n: number, over: Record<string, unknown> = {}) => ({
  clientId: id(n),
  seq: n,
  deviceTime: plus(n * MIN).toISOString(),
  bundleId: BUNDLE,
  type: 'entry',
  subjectType: 'visitor_pass',
  subjectId: SUBJECT,
  direction: 'in',
  via: 'code',
  ...over,
});

describe('an upload’s payload (ADR 0057)', () => {
  it('its batch and its actions, in sequence, each with its hash', () => {
    const parsed = parseUpload({
      batchId: BATCH,
      actions: [action(1), action(2, { direction: 'out', via: undefined })],
    });
    expect(parsed).toEqual({
      batchId: BATCH,
      actions: [
        expect.objectContaining({
          clientId: id(1),
          seq: 1,
          deviceTime: plus(MIN),
          direction: 'in',
          via: 'code',
          contentSha256: actionHash(action(1)),
        }),
        expect.objectContaining({ seq: 2, direction: 'out' }),
      ],
    });
  });

  it('every problem by field: never a guess', () => {
    expect(
      parseUpload({
        actions: [
          action(2),
          action(2, { clientId: id(3) }),
          action(4, { clientId: id(1), bundleId: 'x', type: 'teleport' }),
          action(5, {
            subjectType: 'resident',
            via: 'nfc',
            deviceTime: 'later',
          }),
          action(6, { clientId: id(2) }),
          'nope',
        ],
      }),
    ).toEqual({
      problems: [
        { field: 'batchId', code: 'FIELD_REQUIRED' },
        { field: 'actions.1.seq', code: 'INVALID_VALUE' },
        { field: 'actions.2.bundleId', code: 'INVALID_FORMAT' },
        { field: 'actions.2.type', code: 'INVALID_VALUE' },
        { field: 'actions.3.deviceTime', code: 'INVALID_FORMAT' },
        { field: 'actions.3.subjectType', code: 'INVALID_VALUE' },
        { field: 'actions.4.clientId', code: 'INVALID_VALUE' },
        { field: 'actions.5', code: 'INVALID_VALUE' },
      ],
    });
  });

  it('each subject by what it comes in by', () => {
    const problems = (over: Record<string, unknown>) =>
      (
        parseUpload({ batchId: BATCH, actions: [action(1, over)] }) as {
          problems?: unknown[];
        }
      ).problems ?? [];
    expect(problems({ subjectType: 'event_guest', via: 'list' })).toEqual([]);
    expect(problems({ subjectType: 'move_permit', via: 'plate' })).toEqual([]);
    expect(problems({ via: 'plate' })).toEqual([]);
    for (const over of [
      { subjectType: 'worker_engagement', via: 'list' },
      { subjectType: 'move_permit', via: 'code' },
      { via: 'nfc' },
    ])
      expect(problems(over)).toEqual([
        { field: 'actions.0.via', code: 'INVALID_VALUE' },
      ]);
    // An exit needs no `via`.
    expect(problems({ direction: 'out', via: undefined })).toEqual([]);
  });

  it('the other actions: what each carries, checked', () => {
    const one = (x: Record<string, unknown>) =>
      parseUpload({
        batchId: BATCH,
        actions: [
          {
            clientId: id(1),
            seq: 1,
            deviceTime: T0.toISOString(),
            bundleId: BUNDLE,
            ...x,
          },
        ],
      });
    expect(
      one({
        type: 'contractor',
        permitId: SUBJECT,
        direction: 'in',
        idLast4: ' ab12 ',
      }),
    ).toEqual({
      batchId: BATCH,
      actions: [expect.objectContaining({ idLast4: 'AB12' })],
    });
    expect(
      one({
        type: 'contractor',
        permitId: SUBJECT,
        direction: 'in',
        idLast4: 'A1',
      }),
    ).toEqual({
      problems: [{ field: 'actions.0.idLast4', code: 'INVALID_FORMAT' }],
    });
    expect(
      one({
        type: 'service_vehicle_in',
        plate: ' ab  123 ',
        kind: 'tanker',
        company: ' Nile  Water ',
        unitCode: 'B7',
      }),
    ).toEqual({
      batchId: BATCH,
      actions: [
        expect.objectContaining({
          plate: 'AB 123',
          company: 'Nile Water',
          unitCode: 'B7',
          facilityId: null,
        }),
      ],
    });
    expect(
      one({
        type: 'service_vehicle_in',
        plate: '!!',
        kind: 'rocket',
        company: '',
        unitCode: 'B7',
        facilityId: SUBJECT,
      }),
    ).toEqual({
      problems: [
        { field: 'actions.0.plate', code: 'INVALID_FORMAT' },
        { field: 'actions.0.kind', code: 'INVALID_VALUE' },
        { field: 'actions.0.company', code: 'INVALID_VALUE' },
        { field: 'actions.0.facilityId', code: 'INVALID_VALUE' },
      ],
    });
    expect(
      one({ type: 'material_entry', unitCode: 'B7', description: 'Cement' }),
    ).toEqual({
      batchId: BATCH,
      actions: [expect.objectContaining({ permitId: null })],
    });
    expect(
      one({
        type: 'patrol_scan',
        runId: SUBJECT,
        method: 'manual',
        checkpointId: SUBJECT,
        reasonCode: 'qr_damaged',
        lat: 30.1,
        lng: 31.2,
      }),
    ).toEqual({
      batchId: BATCH,
      actions: [expect.objectContaining({ payload: null, lat: 30.1 })],
    });
    expect(
      one({ type: 'patrol_scan', runId: SUBJECT, method: 'qr', lat: 30.1 }),
    ).toEqual({
      problems: [
        { field: 'actions.0.payload', code: 'INVALID_FORMAT' },
        { field: 'actions.0.lat', code: 'INVALID_VALUE' },
      ],
    });
  });

  it('a quarantined contractor kept no last four: it parses again without', () => {
    const body = {
      clientId: id(1),
      seq: 1,
      deviceTime: T0.toISOString(),
      bundleId: BUNDLE,
      type: 'contractor',
      permitId: SUBJECT,
      direction: 'in',
    };
    expect(parseUpload({ batchId: BATCH, actions: [body] })).toHaveProperty(
      'problems',
    );
    expect(
      parseUpload(
        { batchId: BATCH, actions: [body] },
        { fromQuarantine: true },
      ),
    ).toEqual({
      batchId: BATCH,
      actions: [expect.objectContaining({ idLast4: null })],
    });
    expect(
      quarantineBody(
        (
          parseUpload({
            batchId: BATCH,
            actions: [{ ...body, idLast4: 'AB12' }],
          }) as { actions: Parameters<typeof quarantineBody>[0][] }
        ).actions[0],
      ),
    ).not.toHaveProperty('idLast4');
  });

  it('one to BATCH_MAX actions', () => {
    expect(parseUpload({ batchId: BATCH, actions: [] })).toEqual({
      problems: [{ field: 'actions', code: 'INVALID_VALUE' }],
    });
    const many = Array.from({ length: BATCH_MAX + 1 }, (_, i) => action(i + 1));
    expect(parseUpload({ batchId: BATCH, actions: many })).toEqual({
      problems: [{ field: 'actions', code: 'INVALID_VALUE' }],
    });
  });

  it('the same action is the same hash, whatever the key order', () => {
    const a = action(1);
    const reordered = Object.fromEntries(Object.entries(a).reverse());
    expect(actionHash(reordered)).toBe(actionHash(a));
    expect(actionHash({ ...a, direction: 'out' })).not.toBe(actionHash(a));
  });
});

describe('when an action happened (ADR 0057)', () => {
  const bundle = { issuedAt: T0, validUntil: plus(12 * 60 * MIN) };
  const base = {
    previousDeviceTime: null,
    bundle,
    receivedAt: plus(13 * 60 * MIN),
    shiftEndedAt: null,
  };

  it('the device’s time when it holds', () => {
    expect(whenOf({ ...base, deviceTime: plus(60 * MIN) })).toEqual({
      occurredAt: plus(60 * MIN),
      flags: [],
      skewMs: null,
    });
  });

  it('clamped to the bundle’s issue and the receipt: clock_skew', () => {
    expect(whenOf({ ...base, deviceTime: plus(-SKEW_MS - MIN) })).toEqual({
      occurredAt: plus(-SKEW_MS),
      flags: ['clock_skew'],
      skewMs: -MIN,
    });
    expect(
      whenOf({ ...base, deviceTime: plus(14 * 60 * MIN) }).occurredAt,
    ).toEqual(base.receivedAt);
    // Two minutes of grace either way are no skew.
    expect(whenOf({ ...base, deviceTime: plus(-SKEW_MS) }).flags).toEqual([]);
  });

  it('going back more than two minutes from the action before: clock_skew', () => {
    expect(
      whenOf({
        ...base,
        deviceTime: plus(10 * MIN),
        previousDeviceTime: plus(13 * MIN),
      }).flags,
    ).toEqual(['clock_skew']);
    expect(
      whenOf({
        ...base,
        deviceTime: plus(10 * MIN),
        previousDeviceTime: plus(11 * MIN),
      }).flags,
    ).toEqual([]);
  });

  it('past the bundle’s validity: bundle_expired; past its shift’s end: shift_ended', () => {
    expect(
      whenOf({ ...base, deviceTime: plus(12 * 60 * MIN + SKEW_MS + MIN) })
        .flags,
    ).toEqual(['bundle_expired']);
    expect(
      whenOf({
        ...base,
        deviceTime: plus(60 * MIN),
        shiftEndedAt: plus(30 * MIN),
      }).flags,
    ).toEqual(['shift_ended']);
  });
});

describe('what a conflict is flagged as (ADR 0057)', () => {
  it('every kind has a class', () => {
    expect(Object.keys(FLAG_CLASS).sort()).toEqual([...FLAG_KINDS].sort());
  });

  it.each([
    [null, null],
    ['used', null],
    ['banned', 'credential_banned'],
    ['work_stopped', 'credential_banned'],
    ['expired', 'invalid_at_time'],
    ['outside_schedule', 'invalid_at_time'],
    ['cancelled', 'credential_revoked'],
    ['host_inactive', 'credential_revoked'],
    ['ended', 'credential_revoked'],
  ] as const)('%s → %s', (refusal, flag) => {
    expect(refusalFlag(refusal)).toBe(flag);
  });
});

import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  day,
  permitHelpers,
  type PermitBody,
  type PermitSetUp,
  type Who,
} from '../setup/permits';
import { clock, middayZone } from '../setup/compound-clock';
import { leakText } from '../setup/leak-text';

const HOUR = 3_600_000;

interface GatePermitBody {
  id: string;
  reference: string;
  kind: string;
  status: string;
  unitCode: string;
  hoursToday: { from: string; to: string } | null;
  works: {
    workers: {
      id: string;
      fullName: string | null;
      photo: { url: string } | null;
      removed: boolean;
      inside: boolean;
    }[];
  } | null;
  move: { truckPlate: string | null; inside: boolean } | null;
  event: {
    guestCount: number;
    guests: { id: string; fullName: string | null; inside: boolean }[] | null;
  } | null;
}

describe('Permits — at the gate (ADR 0049)', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  /** A compound with every day and hour open, a guard on duty. */
  async function court(name: string, zone?: string) {
    const c = await p.setUp(name, zone);
    await p.anyTime(c.manager);
    const guard = await p.guardOnDuty(c.c);
    return { ...c, guard };
  }

  /** An approved works permit from today, all day, with one worker. */
  async function approvedWorks(
    c: PermitSetUp,
    last4 = '4821',
  ): Promise<{ permit: PermitBody; workerId: string }> {
    const permit = await p.works(c.alice, c.home.id, {
      startsOn: day(0),
      endsOn: day(2),
      dailyHours: { from: '00:00', to: '23:59' },
    });
    const { worker } = await p.addWorker(c.alice, permit.id, {
      idLast4: last4,
    });
    await p.approve(c.manager, permit.id);
    return { permit, workerId: worker.id };
  }

  const entry = (guard: Who, body: Record<string, unknown>) =>
    p.http('post', '/gate/entries', guard.token, {
      direction: 'in',
      ...body,
    });
  const refusal = (res: { body: unknown }) =>
    (res.body as { code: string; params?: { reason?: string } }).params
      ?.reason ?? (res.body as { code: string }).code;

  it('the guard finds today’s permits by unit or reference, and opens one: faces, never the last four; audited on the shift', async () => {
    const c = await court('Gate Find Court');
    const { permit, workerId } = await approvedWorks(c, '7731');
    const pending = await p.works(c.alice, c.home.id);
    const found = await p
      .http('get', `/gate/unit-permits?unitCode=${c.home.code}`, c.guard.token)
      .expect(200);
    expect(found.headers['cache-control']).toBe('no-store');
    const list = (found.body as { data: GatePermitBody[] }).data;
    expect(list.map((x) => x.id)).toEqual([permit.id]);
    expect(list.map((x) => x.id)).not.toContain(pending.id);
    expect(list[0].works!.workers[0].photo).toBeNull();
    const byRef = (
      await p
        .http(
          'get',
          `/gate/unit-permits?reference=${encodeURIComponent(permit.reference.replace('-', '').toLowerCase())}`,
          c.guard.token,
        )
        .expect(200)
    ).body as { data: GatePermitBody[] };
    expect(byRef.data.map((x) => x.id)).toEqual([permit.id]);
    const detail = (
      await p
        .http('get', `/gate/unit-permits/${permit.id}`, c.guard.token)
        .expect(200)
    ).body as GatePermitBody;
    expect(detail).toMatchObject({
      reference: permit.reference,
      status: 'approved',
      hoursToday: { from: '00:00', to: '23:59' },
    });
    expect(detail.works!.workers).toEqual([
      expect.objectContaining({
        id: workerId,
        photo: expect.objectContaining({
          url: expect.any(String) as string,
        }) as object,
        removed: false,
        inside: false,
      }),
    ]);
    expect(leakText(detail)).not.toContain('7731');
    // A pending permit is not the gate's.
    await p
      .http('get', `/gate/unit-permits/${pending.id}`, c.guard.token)
      .expect(404);
    const audit = await p.v.x.asManager(c.c, () =>
      p.v.x.prisma.tenant.auditLog.findMany({
        where: { action: 'gate.permit_lookup', targetId: c.guard.shiftId },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(audit.map((a) => a.metadata)).toEqual([
      {
        by: 'unit',
        unitId: c.home.id,
        permitIds: [permit.id],
        matches: 1,
      },
      { by: 'reference', unitId: null, permitIds: [permit.id], matches: 1 },
      { by: 'id', permitIds: [permit.id], matches: 1 },
    ]);
    // One of the two, never both or neither.
    await p.http('get', '/gate/unit-permits', c.guard.token).expect(400);
    await p
      .http(
        'get',
        `/gate/unit-permits?unitCode=${c.home.code}&reference=W-1`,
        c.guard.token,
      )
      .expect(400);
  });

  it('a guard off shift learns nothing', async () => {
    const c = await court('Gate Off Shift Court');
    const { permit } = await approvedWorks(c);
    await p.http('post', '/gate/shifts/end', c.guard.token, {}).expect(200);
    for (const path of [
      `/gate/unit-permits?unitCode=${c.home.code}`,
      `/gate/unit-permits/${permit.id}`,
    ])
      expect(
        (await p.http('get', path, c.guard.token).expect(403)).body,
      ).toMatchObject({ code: 'NO_OPEN_SHIFT' });
  });

  it('a contractor comes in with their face and the last four of their ID; goes out without; the household is not pushed', async () => {
    const c = await court('Gate Worker Court');
    const { permit, workerId } = await approvedWorks(c);
    const base = { subjectType: 'permit_worker', subjectId: workerId };
    expect((await entry(c.guard, base).expect(400)).body).toMatchObject({
      fields: [{ field: 'idLast4', code: 'FIELD_REQUIRED' }],
    });
    const wrong = await entry(c.guard, { ...base, idLast4: '0000' }).expect(
      409,
    );
    expect(refusal(wrong)).toBe('id_mismatch');
    const ok = await entry(c.guard, { ...base, idLast4: '4821' }).expect(201);
    expect(ok.body).toMatchObject({
      subjectType: 'permit_worker',
      subjectId: workerId,
      direction: 'in',
      method: 'permit',
    });
    expect(
      (await entry(c.guard, { ...base, idLast4: '4821' }).expect(409)).body,
    ).toMatchObject({ code: 'ALREADY_INSIDE' });
    const inside = (
      await p.http('get', '/gate/inside', c.guard.token).expect(200)
    ).body as { data: Record<string, unknown>[] };
    const row = inside.data.find((d) => d.subjectId === workerId)!;
    expect(row).toMatchObject({
      kind: 'contractor',
      permitId: permit.id,
      permitReference: permit.reference,
    });
    expect(JSON.stringify(row)).not.toMatch(/Contractor Worker/);
    expect(
      (
        (
          await p
            .http('get', `/gate/unit-permits/${permit.id}`, c.guard.token)
            .expect(200)
        ).body as GatePermitBody
      ).works!.workers[0].inside,
    ).toBe(true);
    await p
      .http('post', '/gate/entries', c.guard.token, {
        ...base,
        direction: 'out',
      })
      .expect(201);
    expect(await p.notifications(c.c, c.alice.id)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'worker.entered' }),
      ]),
    );
  });

  it('refuses with a clear reason: not approved, revoked, removed', async () => {
    const c = await court('Gate Refusals Court');
    const pending = await p.works(c.alice, c.home.id, {
      startsOn: day(0),
      endsOn: day(1),
      dailyHours: { from: '00:00', to: '23:59' },
    });
    const { worker } = await p.addWorker(c.alice, pending.id);
    expect(
      refusal(
        await entry(c.guard, {
          subjectType: 'permit_worker',
          subjectId: worker.id,
          idLast4: '4821',
        }).expect(409),
      ),
    ).toBe('not_approved');
    const { permit, workerId } = await approvedWorks(c);
    await p
      .http(
        'post',
        `/permits/${permit.id}/workers/${workerId}/remove`,
        c.alice.token,
        {},
      )
      .expect(200);
    expect(
      refusal(
        await entry(c.guard, {
          subjectType: 'permit_worker',
          subjectId: workerId,
          idLast4: '4821',
        }).expect(409),
      ),
    ).toBe('worker_removed');
    const other = await approvedWorks(c);
    await p
      .decide(c.manager, other.permit.id, 'revoke', { reasonCode: 'complaint' })
      .expect(200);
    expect(
      refusal(
        await entry(c.guard, {
          subjectType: 'permit_worker',
          subjectId: other.workerId,
          idLast4: '4821',
        }).expect(409),
      ),
    ).toBe('revoked');
  });

  it('the compound’s hours and days off as they stand at each entry; the permit’s own hours; exits always (R8)', async () => {
    const c = await court('Gate Hours Court');
    const { workerId } = await approvedWorks(c);
    const base = {
      subjectType: 'permit_worker',
      subjectId: workerId,
      idLast4: '4821',
    };
    await entry(c.guard, base).expect(201);
    // Narrow the hours to exclude now: the next entry is refused.
    const now = clock().minute;
    const narrow =
      now >= 120
        ? { from: '00:00', to: hhmm(now - 60) }
        : { from: hhmm(now + 60), to: '23:59' };
    await p.setRules(c.manager, { workHours: narrow });
    // The one inside goes out whatever the hours.
    await p
      .http('post', '/gate/entries', c.guard.token, {
        ...base,
        direction: 'out',
        idLast4: undefined,
      })
      .expect(201);
    expect(refusal(await entry(c.guard, base).expect(409))).toBe(
      'outside_work_hours',
    );
    // Today a day off.
    await p.setRules(c.manager, {
      workHours: { from: '00:00', to: '23:59' },
      daysOff: [day(0)],
    });
    expect(refusal(await entry(c.guard, base).expect(409))).toBe('day_off');
    await p.setRules(c.manager, { daysOff: [] });
    await entry(c.guard, base).expect(201);
  });

  it('five wrong last-fours lock the guard out, even with the right one; the management unlocks from the permit (RB1)', async () => {
    const c = await court('Gate Lockout Court');
    const { permit, workerId } = await approvedWorks(c);
    const base = { subjectType: 'permit_worker', subjectId: workerId };
    for (let i = 0; i < 5; i += 1)
      expect(
        refusal(await entry(c.guard, { ...base, idLast4: '0000' }).expect(409)),
      ).toBe('id_mismatch');
    const key = '0192f1c2-7a4b-7c3d-8e9f-0a1b2c3d4e5f';
    expect(
      (
        await entry(c.guard, { ...base, idLast4: '4821' })
          .set('Idempotency-Key', key)
          .expect(429)
      ).body,
    ).toMatchObject({ code: 'PERMIT_ID_LOCKED', params: { scope: 'guard' } });
    const detail = (
      await p
        .http('get', `/staff/unit-permits/${permit.id}`, c.manager.token)
        .expect(200)
    ).body as { lockouts: { workerIds: string[]; guards: { id: string }[] } };
    expect(detail.lockouts).toEqual({
      workerIds: [],
      guards: [expect.objectContaining({ id: c.guard.id }) as object],
    });
    await p
      .http(
        'post',
        `/staff/unit-permits/${permit.id}/guards/${c.guard.id}/unlock`,
        c.manager.token,
        {},
      )
      .expect(200);
    // The same key runs again: the locked-out attempt left nothing behind.
    const ok = await entry(c.guard, { ...base, idLast4: '4821' })
      .set('Idempotency-Key', key)
      .expect(201);
    expect(ok.headers['idempotent-replayed']).toBeUndefined();
    const audit = await p.v.x.asManager(c.c, () =>
      p.v.x.prisma.tenant.auditLog.findMany({
        where: { action: 'unit_permit.lockout_cleared', targetId: permit.id },
      }),
    );
    expect(audit.map((a) => a.metadata)).toEqual([{ guardId: c.guard.id }]);
  });

  it('ten wrong last-fours in a day lock the worker out at every gate; unlocked from the permit', async () => {
    const c = await court('Gate Worker Lockout Court');
    const { permit, workerId } = await approvedWorks(c);
    const second = await p.guardOnDuty(c.c);
    const third = await p.guardOnDuty(c.c);
    const base = { subjectType: 'permit_worker', subjectId: workerId };
    for (const g of [c.guard, second])
      for (let i = 0; i < 4; i += 1)
        await entry(g, { ...base, idLast4: '0000' }).expect(409);
    await entry(third, { ...base, idLast4: '0000' }).expect(409);
    await entry(third, { ...base, idLast4: '0000' }).expect(409);
    expect(
      (await entry(third, { ...base, idLast4: '4821' }).expect(429)).body,
    ).toMatchObject({ params: { scope: 'worker' } });
    const detail = (
      await p
        .http('get', `/staff/unit-permits/${permit.id}`, c.manager.token)
        .expect(200)
    ).body as { lockouts: { workerIds: string[] } };
    expect(detail.lockouts.workerIds).toEqual([workerId]);
    await p
      .http(
        'post',
        `/staff/unit-permits/${permit.id}/workers/${workerId}/unlock`,
        c.manager.token,
        {},
      )
      .expect(200);
    await entry(third, { ...base, idLast4: '4821' }).expect(201);
  });

  it('an event’s guests: names shown from half an hour before; a removed guest refused', async () => {
    // Midday where the compound is: the event two hours from now is today's
    // (the gate shows today's permits), whatever hour the test runs.
    const c = await court('Gate Event Court', middayZone());
    const later = await p.event(c.alice, c.home.id, 3, {
      startsAt: new Date(Date.now() + 2 * HOUR).toISOString(),
      endsAt: new Date(Date.now() + 5 * HOUR).toISOString(),
    });
    const hidden = (
      await p
        .http('get', `/gate/unit-permits/${later.id}`, c.guard.token)
        .expect(200)
    ).body as GatePermitBody;
    expect(hidden.event).toMatchObject({ guestCount: 3, guests: null });
    expect(JSON.stringify(hidden)).not.toContain('Guest Number');
    expect(
      refusal(
        await entry(c.guard, {
          subjectType: 'event_guest',
          subjectId: later.event!.guests[0].id,
        }).expect(409),
      ),
    ).toBe('not_yet_valid');
    const soon = await p.event(c.alice, c.home.id, 3, {
      startsAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3 * HOUR).toISOString(),
    });
    const shown = (
      await p
        .http('get', `/gate/unit-permits/${soon.id}`, c.guard.token)
        .expect(200)
    ).body as GatePermitBody;
    expect(shown.event!.guests!.map((g) => g.fullName)).toEqual([
      'Guest Number 1',
      'Guest Number 2',
      'Guest Number 3',
    ]);
    const [first, second] = soon.event!.guests;
    const ok = await entry(c.guard, {
      subjectType: 'event_guest',
      subjectId: first.id,
    }).expect(201);
    expect(ok.body).toMatchObject({ method: 'permit' });
    await p
      .http(
        'post',
        `/permits/${soon.id}/guests/${second.id}/remove`,
        c.alice.token,
        {},
      )
      .expect(200);
    expect(
      refusal(
        await entry(c.guard, {
          subjectType: 'event_guest',
          subjectId: second.id,
        }).expect(409),
      ),
    ).toBe('guest_removed');
  });

  it('a move’s truck comes in within its window', async () => {
    const c = await court('Gate Move Court');
    const now = clock().minute;
    // A window of today around now (or the next day's first hours).
    const window =
      now < 1380
        ? {
            from: hhmm(Math.max(0, now - 30)),
            to: hhmm(Math.min(1439, now + 60)),
          }
        : { from: hhmm(now - 60), to: '23:59' };
    const move = await p.move(c.alice, c.home.id, { date: day(0), window });
    await p.approve(c.manager, move.id);
    const ok = await entry(c.guard, {
      subjectType: 'move_permit',
      subjectId: move.id,
    }).expect(201);
    expect(ok.body).toMatchObject({ method: 'permit' });
    // A works permit's id is not a truck.
    const { permit } = await approvedWorks(c);
    expect(
      (
        await entry(c.guard, {
          subjectType: 'move_permit',
          subjectId: permit.id,
        }).expect(404)
      ).body,
    ).toMatchObject({ code: 'GATE_SUBJECT_NOT_FOUND' });
  });
});

function hhmm(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

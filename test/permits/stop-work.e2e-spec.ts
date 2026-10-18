import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { day, permitHelpers, type PermitSetUp } from '../setup/permits';
import type { Who } from '../setup/safety';

interface PermitBody {
  id: string;
  reference: string;
  works: { workStopped: { since: string; reasonCode: string } | null } | null;
}

/**
 * ADR 0053, stop work: a guard on shift (a gate or a zone) or the permits'
 * staff stops the work of an approved works permit in force, with a code;
 * its workers are refused at the gate (`work_stopped`) until the management
 * resumes it, or the permit is revoked or cancelled. Exits are recorded.
 */
describe('Permits — stop work (ADR 0053)', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  /** A compound with every day and hour open, a guard on duty. */
  async function court(name: string) {
    const c = await p.setUp(name);
    await p.anyTime(c.manager);
    const guard = await p.guardOnDuty(c.c);
    return { ...c, guard };
  }

  /** An approved works permit from today, all day, with one worker. */
  async function approvedWorks(c: PermitSetUp) {
    const permit = await p.works(c.alice, c.home.id, {
      startsOn: day(0),
      endsOn: day(2),
      dailyHours: { from: '00:00', to: '23:59' },
    });
    const { worker } = await p.addWorker(c.alice, permit.id, {
      idLast4: '4821',
    });
    await p.approve(c.manager, permit.id);
    return { permit, workerId: worker.id };
  }

  const entry = (guard: Who, workerId: string, direction = 'in') =>
    p.http('post', '/gate/entries', guard.token, {
      subjectType: 'permit_worker',
      subjectId: workerId,
      direction,
      ...(direction === 'in' ? { idLast4: '4821' } : {}),
    });
  const stopAtGate = (guard: Who, id: string, reasonCode = 'safety_hazard') =>
    p.http('post', `/gate/unit-permits/${id}/stop-work`, guard.token, {
      reasonCode,
    });

  it('a guard stops the work: refused at the gate (work_stopped), shown on the permit, the household and the staff told; audited by code', async () => {
    const c = await court('Stop Work Court');
    const { permit, workerId } = await approvedWorks(c);
    const keeper = await p.staff(c.c, ['permits.manage']);
    const res = await stopAtGate(c.guard, permit.id).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      permitId: permit.id,
      reference: permit.reference,
      unitCode: c.home.code,
      workStopped: { reasonCode: 'safety_hazard' },
    });
    await entry(c.guard, workerId)
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({
          code: 'GATE_ENTRY_REFUSED',
          params: { reason: 'work_stopped' },
        }),
      );
    const mine = (await p.get(c.alice, permit.id)) as unknown as PermitBody;
    expect(mine.works?.workStopped).toMatchObject({
      reasonCode: 'safety_hazard',
    });
    const atGate = await p
      .http('get', `/gate/unit-permits/${permit.id}`, c.guard.token)
      .expect(200);
    expect(atGate.body).toMatchObject({
      works: { workStopped: { reasonCode: 'safety_hazard' } },
    });
    for (const who of [c.alice, keeper])
      expect(await p.told(c.c, who.id, permit.id)).toEqual(
        expect.arrayContaining([
          {
            kind: 'unit_permit.work_stopped',
            params: { reason: 'safety_hazard' },
          },
        ]),
      );
    const [row] = await auditReaders(h).tenant(c.c.tenantId, {
      action: 'permit_work.stopped',
      targetId: permit.id,
    });
    expect(row).toMatchObject({ actorId: c.guard.id });
    expect(row.metadata).toEqual({
      reasonCode: 'safety_hazard',
      side: 'guard',
      shiftId: c.guard.shiftId,
      recipients: 3,
    });
    // Stopped already; a code that is none.
    await stopAtGate(c.guard, permit.id)
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({ code: 'PERMIT_WORK_STOPPED' }),
      );
  });

  it('only an approved works permit in force; never off shift or without gate.operate', async () => {
    const c = await court('Stop Refused Court');
    const pending = await p.works(c.alice, c.home.id, {
      startsOn: day(0),
      endsOn: day(2),
      dailyHours: { from: '00:00', to: '23:59' },
    });
    await stopAtGate(c.guard, pending.id)
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({ code: 'PERMIT_NOT_ACTIVE' }),
      );
    const { permit } = await approvedWorks(c);
    await stopAtGate(c.guard, permit.id, 'boredom').expect(400);
    const offShift = await p.v.who(c.c, (await p.g.guard(c.c)).id, 'staff');
    await stopAtGate(offShift, permit.id)
      .expect(403)
      .expect((r) => expect(r.body).toMatchObject({ code: 'NO_OPEN_SHIFT' }));
    for (const who of [c.alice, c.manager])
      await stopAtGate(who, permit.id).expect(403);
  });

  it('the staff stop and resume; workers come in again; a worker inside always leaves; the guard never resumes', async () => {
    const c = await court('Stop Resume Court');
    const { permit, workerId } = await approvedWorks(c);
    await entry(c.guard, workerId).expect(201);
    await p
      .http(
        'post',
        `/staff/unit-permits/${permit.id}/stop-work`,
        c.manager.token,
        {
          reasonCode: 'noise_complaint',
        },
      )
      .expect(200)
      .expect((r) =>
        expect(r.body).toMatchObject({
          works: { workStopped: { reasonCode: 'noise_complaint' } },
        }),
      );
    await entry(c.guard, workerId, 'out').expect(201);
    await entry(c.guard, workerId).expect(409);
    await p
      .http(
        'post',
        `/staff/unit-permits/${permit.id}/resume-work`,
        c.guard.token,
        {},
      )
      .expect(403);
    await p
      .http(
        'post',
        `/staff/unit-permits/${permit.id}/resume-work`,
        c.manager.token,
        {},
      )
      .expect(200)
      .expect((r) =>
        expect(r.body).toMatchObject({ works: { workStopped: null } }),
      );
    expect(await p.told(c.c, c.alice.id, permit.id)).toEqual(
      expect.arrayContaining([
        { kind: 'unit_permit.work_resumed', params: {} },
      ]),
    );
    await entry(c.guard, workerId).expect(201);
    await p
      .http(
        'post',
        `/staff/unit-permits/${permit.id}/resume-work`,
        c.manager.token,
        {},
      )
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({ code: 'PERMIT_WORK_NOT_STOPPED' }),
      );
  });

  it('a revoke or a cancellation ends the stop with the permit', async () => {
    const c = await court('Stop End Court');
    const revoked = await approvedWorks(c);
    await stopAtGate(c.guard, revoked.permit.id).expect(200);
    await p
      .http(
        'post',
        `/staff/unit-permits/${revoked.permit.id}/revoke`,
        c.manager.token,
        {
          reasonCode: 'rules_broken',
        },
      )
      .expect(200);
    const cancelled = await approvedWorks(c);
    await stopAtGate(c.guard, cancelled.permit.id).expect(200);
    await p
      .http('post', `/permits/${cancelled.permit.id}/cancel`, c.alice.token, {})
      .expect(200);
    const stops = await p.inTx(c.c, (tx) =>
      tx.permitWorkStop.findMany({
        where: {
          permitId: { in: [revoked.permit.id, cancelled.permit.id] },
        },
        orderBy: { stoppedAt: 'asc' },
      }),
    );
    expect(stops.map((s) => [s.permitId, s.endKind, s.endedById])).toEqual([
      [revoked.permit.id, 'permit_revoked', c.manager.id],
      [cancelled.permit.id, 'permit_cancelled', c.alice.id],
    ]);
  });
});

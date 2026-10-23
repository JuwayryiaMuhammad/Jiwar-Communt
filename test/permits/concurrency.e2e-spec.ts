import { newId } from '../../src/core/common/uuid';
import { PEOPLE_DATA_SWEEP } from '../../src/gate/permits/permit-sweeps';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  day,
  permitHelpers,
  type PermitBody,
  type PermitSetUp,
  type Who,
} from '../setup/permits';
import {
  permitFileRow,
  permitRow,
  permitWorkerRow,
} from '../setup/permits-rows';

const ROUNDS = 5;
// eslint-disable-next-line no-restricted-syntax -- past instants only: the purge compares ends_at with now − 30 × 24 h
const DAY = 86_400_000;

/**
 * The permits' races (ADR 0049), each run for real with Promise.all: every
 * outcome is one of the allowed ones, and the database agrees.
 */
describe('Permits concurrency', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;
  let c: PermitSetUp;
  let gateA: Who & { gateId: string; shiftId: string };
  let gateB: Who & { gateId: string; shiftId: string };

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
    c = await p.setUp('Permits Race Court');
    await p.anyTime(c.manager);
    gateA = await p.guardOnDuty(c.c);
    gateB = await p.guardOnDuty(c.c);
  }, 180_000);

  afterAll(() => h.close());

  /** A fresh unit with its own primary: limits never cross rounds. */
  async function home() {
    const unit = await p.unit(c.c, 'R');
    return { unit, owner: await p.owner(c.c, unit.id) };
  }

  async function approvedWorker() {
    const { unit, owner } = await home();
    const permit = await p.works(owner, unit.id, {
      startsOn: day(0),
      endsOn: day(1),
      dailyHours: { from: '00:00', to: '23:59' },
    });
    const { worker } = await p.addWorker(owner, permit.id, {
      idLast4: '4821',
    });
    await p.approve(c.manager, permit.id);
    return { unit, owner, permit, workerId: worker.id };
  }

  const enter = (guard: Who, workerId: string) =>
    p.http('post', '/gate/entries', guard.token, {
      subjectType: 'permit_worker',
      subjectId: workerId,
      direction: 'in',
      idLast4: '4821',
    });
  const entries = (subjectId: string) =>
    p.v.inTx(c.c, (tx) => tx.gateEntry.count({ where: { subjectId } }));
  const reason = (res: { body: unknown }) =>
    (res.body as { code: string; params?: { reason?: string } }).params
      ?.reason ?? (res.body as { code: string }).code;

  it('R1: a worker entered at two gates at once: once', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { workerId } = await approvedWorker();
      const results = await Promise.all([
        enter(gateA, workerId),
        enter(gateB, workerId),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(reason(results.find((r) => r.status === 409)!)).toBe(
        'ALREADY_INSIDE',
      );
      expect(await entries(workerId)).toBe(1);
    }
  });

  it('R2: a revoke racing an entry: the entry is in before the revoke, or refused; never after', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { permit, workerId } = await approvedWorker();
      const [entry, revoke] = await Promise.all([
        enter(gateA, workerId),
        p.decide(c.manager, permit.id, 'revoke', { reasonCode: 'complaint' }),
      ]);
      expect(revoke.status).toBe(200);
      const row = await p.row(c.c, permit.id);
      if (entry.status === 201) {
        const [e] = await p.v.inTx(c.c, (tx) =>
          tx.gateEntry.findMany({ where: { subjectId: workerId } }),
        );
        expect(e.recordedAt.getTime()).toBeLessThanOrEqual(
          row.revokedAt!.getTime(),
        );
      } else {
        expect(reason(entry)).toBe('revoked');
        expect(await entries(workerId)).toBe(0);
      }
      // Out whoever is in; the next `in` is refused.
      if (entry.status === 201)
        await p
          .http('post', '/gate/entries', gateB.token, {
            subjectType: 'permit_worker',
            subjectId: workerId,
            direction: 'out',
          })
          .expect(201);
      expect(reason(await enter(gateB, workerId).expect(409))).toBe('revoked');
    }
  });

  it('R3: a material exit used at two gates at once: once', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { unit, owner } = await home();
      const exit = await p.exit(owner, unit.id, {
        validFrom: day(0),
        validUntil: day(0),
      });
      await p.approve(c.manager, exit.id);
      const results = await Promise.all(
        [gateA, gateB].map((g) =>
          p.http('post', `/gate/unit-permits/${exit.id}/use`, g.token, {}),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(reason(results.find((r) => r.status === 409)!)).toBe('used');
      const row = await p.row(c.c, exit.id);
      expect(row.status).toBe('used');
      const by = row.usedGateId === gateA.gateId ? gateA : gateB;
      expect([gateA.gateId, gateB.gateId]).toContain(row.usedGateId);
      expect(row.usedById).toBe(by.id);
      expect(
        await p.v.x.asManager(c.c, () =>
          p.v.x.prisma.tenant.auditLog.count({
            where: { action: 'unit_permit.used', targetId: exit.id },
          }),
        ),
      ).toBe(1);
    }
  });

  it('R4: workers added at once never pass thirty', async () => {
    const { unit, owner } = await home();
    const permit = await p.works(owner, unit.id);
    await p.v.inTx(c.c, async (tx) => {
      for (let i = 0; i < 27; i += 1)
        await permitWorkerRow(tx, {
          tenantId: c.c.tenantId,
          permitId: permit.id,
          addedById: owner.id,
          photoFileId: await permitFileRow(tx, c.c.tenantId),
        });
    });
    const bodies = await Promise.all(
      [0, 1, 2, 3, 4, 5].map(() => p.workerBody(owner)),
    );
    const results = await Promise.all(
      bodies.map((b) =>
        p.http('post', `/permits/${permit.id}/workers`, owner.token, b),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    for (const r of results.filter((x) => x.status !== 201))
      expect(r.body).toMatchObject({
        code: 'PERMIT_LIMIT_REACHED',
        params: { scope: 'workers', max: 30 },
      });
    expect(
      await p.v.inTx(c.c, (tx) =>
        tx.permitWorker.count({ where: { permitId: permit.id } }),
      ),
    ).toBe(30);
  });

  it('R5: guests added at once never pass the limit', async () => {
    const { unit, owner } = await home();
    const event = await p.event(owner, unit.id, 18);
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        p.http('post', `/permits/${event.id}/guests`, owner.token, {
          guests: [{ fullName: `Racing Guest ${i}` }],
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(
      await p.v.inTx(c.c, (tx) =>
        tx.permitGuest.count({
          where: { permitId: event.id, removedAt: null },
        }),
      ),
    ).toBe(20);
  });

  it('R6: a cancel racing a rejection: exactly one wins', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { unit, owner } = await home();
      const permit = await p.works(owner, unit.id);
      const [cancel, reject] = await Promise.all([
        p.http('post', `/permits/${permit.id}/cancel`, owner.token, {}),
        p.decide(c.manager, permit.id, 'reject', { reasonCode: 'other' }),
      ]);
      expect([cancel.status, reject.status].sort()).toEqual([200, 409]);
      const status = (await p.row(c.c, permit.id)).status;
      if (cancel.status === 200) {
        expect(status).toBe('cancelled');
        expect(reject.body).toMatchObject({
          code: 'PERMIT_NOT_PENDING',
          params: { status: 'cancelled' },
        });
      } else {
        expect(status).toBe('rejected');
        expect(cancel.body).toMatchObject({
          code: 'PERMIT_NOT_ACTIVE',
          params: { status: 'rejected' },
        });
      }
    }
  }, 60_000);

  it('R7: numbers stay distinct, and a unit’s limit holds, under concurrent requests', async () => {
    const units = await Promise.all([home(), home(), home()]);
    const made = await Promise.all(
      units.map(({ unit, owner }) => p.works(owner, unit.id)),
    );
    expect(new Set(made.map((m) => m.reference)).size).toBe(3);
    const { unit, owner } = await home();
    // One body, read first: the four requests race, not their set-up.
    const body = await p.worksBody(owner);
    const results = await Promise.all(
      [0, 1, 2, 3].map(() =>
        p.http('post', `/units/${unit.id}/permits/works`, owner.token, body),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);
    const refs = results
      .filter((r) => r.status === 201)
      .map((r) => (r.body as PermitBody).reference);
    expect(new Set(refs).size).toBe(3);
  });

  it('R9: the purge racing an exit: the exit is recorded, the worker purged', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { unit, owner } = await home();
      const { permitId, workerId } = await p.v.inTx(c.c, async (tx) => {
        const permitId = await permitRow(tx, {
          tenantId: c.c.tenantId,
          unitId: unit.id,
          requestedById: owner.id,
          data: {
            startsAt: new Date(Date.now() - 45 * DAY),
            endsAt: new Date(Date.now() - 40 * DAY),
            status: 'approved',
            decisionSource: 'manager',
            decidedById: c.manager.id,
            decidedAt: new Date(Date.now() - 46 * DAY),
          },
        });
        const workerId = await permitWorkerRow(tx, {
          tenantId: c.c.tenantId,
          permitId,
          addedById: owner.id,
          photoFileId: await permitFileRow(tx, c.c.tenantId),
        });
        // Still "inside" from back then: the gate's own row.
        await tx.gateEntry.create({
          data: {
            id: newId(),
            tenantId: c.c.tenantId,
            gateId: gateA.gateId,
            shiftId: gateA.shiftId,
            guardAccountId: gateA.id,
            subjectType: 'permit_worker',
            subjectId: workerId,
            unitId: unit.id,
            direction: 'in',
            method: 'permit',
            occurredAt: new Date(Date.now() - 2 * 3_600_000),
          },
        });
        return { permitId, workerId };
      });
      const [exit] = await Promise.all([
        p.http('post', '/gate/entries', gateA.token, {
          subjectType: 'permit_worker',
          subjectId: workerId,
          direction: 'out',
        }),
        p.sweep(PEOPLE_DATA_SWEEP),
      ]);
      expect(exit.status).toBe(201);
      expect((await p.row(c.c, permitId)).purgedAt).not.toBeNull();
    }
  });

  it('R10: stop work racing a worker’s entry (ADR 0053): the entry is in before the stop, or refused work_stopped; never after', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { permit, workerId } = await approvedWorker();
      const [entry, stop] = await Promise.all([
        enter(gateA, workerId),
        p.http(
          'post',
          `/gate/unit-permits/${permit.id}/stop-work`,
          gateB.token,
          {
            reasonCode: 'safety_hazard',
          },
        ),
      ]);
      expect(stop.status).toBe(200);
      const stopped = await p.v.inTx(c.c, (tx) =>
        tx.permitWorkStop.findFirstOrThrow({ where: { permitId: permit.id } }),
      );
      if (entry.status === 201) {
        const [e] = await p.v.inTx(c.c, (tx) =>
          tx.gateEntry.findMany({ where: { subjectId: workerId } }),
        );
        expect(e.recordedAt.getTime()).toBeLessThanOrEqual(
          stopped.stoppedAt.getTime(),
        );
        await p
          .http('post', '/gate/entries', gateB.token, {
            subjectType: 'permit_worker',
            subjectId: workerId,
            direction: 'out',
          })
          .expect(201);
      } else {
        expect(reason(entry)).toBe('work_stopped');
        expect(await entries(workerId)).toBe(0);
      }
      expect(reason(await enter(gateB, workerId).expect(409))).toBe(
        'work_stopped',
      );
    }
  });
});

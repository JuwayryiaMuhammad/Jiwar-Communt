import { GlobalDbService } from '../../src/core/database/global-db.service';
import { auditReaders } from '../setup/audit';
import { dbClock } from '../setup/compound-clock';
import {
  gateCompletionHelpers,
  type GuardExceptionBody,
  type StaffExceptionBody,
} from '../setup/gate-completion';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { leakText } from '../setup/leak-text';

const MINUTE = 60_000;
/** What the guard types about whoever waits: never in a trail. */
const NAME = 'Exception-Visitor Lindqvist';
const PLATE = 'ق ب ط 4417';
const ID_NUMBER = '29001011234567';

/**
 * ADR 0056, field exceptions: a guard on shift at a gate asks the on-duty
 * management to let in, once, someone the gate refused. The first answer
 * wins; nobody answering in time expires it; an approval lets one entry in
 * at its gate within its window; never past a lockdown or a ban; the
 * visitor's name and plate reach the deciders only.
 */
describe('Gate — field exceptions (ADR 0056)', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof gateCompletionHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof gateCompletionHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = gateCompletionHelpers(h);
    s = await g.setUp('Field Exceptions Court');
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  const entry = (
    as: typeof s.guard,
    subjectId: string,
    over: Record<string, unknown> = {},
  ) => g.entryRaw(as, 'field_exception', subjectId, over);

  describe('asked', () => {
    it('numbered, its deadline from the settings, every decider told with codes only', async () => {
      const x = await g.visitor(s.guard, s.unitCode, {
        visitorName: NAME,
        vehiclePlate: PLATE,
      });
      expect(x).toMatchObject({
        reference: expect.stringMatching(/^GX-\d{6}$/) as string,
        kind: 'visitor_without_pass',
        reasonCode: 'resident_unreachable',
        unitCode: s.unitCode,
        gateId: s.guard.gateId,
        status: 'pending',
        decidedAt: null,
        entryUntil: null,
        worker: null,
      });
      // The guard's view never names anyone.
      expect(x).not.toHaveProperty('visitorName');
      expect(
        new Date(x.answerBy).getTime() - new Date(x.raisedAt).getTime(),
      ).toBe(10 * MINUTE);
      expect(await g.told(s.c, s.manager.id, x.id)).toEqual([
        {
          kind: 'gate_exception.requested',
          params: {
            exceptionKind: 'visitor_without_pass',
            unitCode: s.unitCode,
            gateName: expect.any(String) as string,
          },
        },
      ]);
      // The deciders read who waits.
      expect(await g.staffView(s.manager, x.id)).toMatchObject({
        visitorName: NAME,
        vehiclePlate: PLATE,
        raisedBy: { id: s.guard.id },
        decidedBy: null,
      });
    });

    it('each kind asks for what it needs: a vehicle its plate, a worker the worker', async () => {
      const noPlate = await g
        .raiseRaw(s.guard, {
          kind: 'unregistered_vehicle',
          unitCode: s.unitCode,
        })
        .expect(400);
      expect((noPlate.body as { fields: unknown[] }).fields).toEqual([
        { field: 'vehiclePlate', code: 'FIELD_REQUIRED' },
      ]);
      const worker = await g
        .raiseRaw(s.guard, {
          kind: 'worker_outside_hours',
          unitCode: s.unitCode,
        })
        .expect(400);
      expect((worker.body as { fields: unknown[] }).fields).toEqual([
        { field: 'worker', code: 'FIELD_REQUIRED' },
        { field: 'unitCode', code: 'FIELD_NOT_ALLOWED' },
      ]);
      const reason = await g
        .raiseRaw(s.guard, {
          kind: 'visitor_without_pass',
          unitCode: s.unitCode,
          reasonCode: 'bribe',
        })
        .expect(400);
      expect((reason.body as { fields: unknown[] }).fields).toEqual([
        {
          field: 'reasonCode',
          code: 'INVALID_REASON_CODE',
          params: {
            allowed: [
              'resident_unreachable',
              'expected_by_resident',
              'regular_visitor',
              'urgent_service',
              'delivery_waiting',
              'emergency',
              'other',
            ],
          },
        },
      ]);
    });

    it('only by a guard on shift at a gate; a retry with its key asks once', async () => {
      const offDuty = await g.guard(s.c);
      expect(
        code(
          await g
            .raiseRaw(offDuty, {
              kind: 'visitor_without_pass',
              unitCode: s.unitCode,
            })
            .expect(403),
        ),
      ).toBe('NO_OPEN_SHIFT');
      const key = { 'Idempotency-Key': '0192e000-0000-7000-8000-00000000a001' };
      const body = { kind: 'visitor_without_pass', unitCode: s.unitCode };
      const one = await g.raiseRaw(s.guard, body, key).expect(201);
      const two = await g.raiseRaw(s.guard, body, key).expect(201);
      expect((two.body as GuardExceptionBody).id).toBe(
        (one.body as GuardExceptionBody).id,
      );
      expect(
        (await g.told(s.c, s.manager.id, (one.body as GuardExceptionBody).id))
          .length,
      ).toBe(1);
    });

    it('never past a lockdown, nor a ban (nothing written, the keepers told)', async () => {
      const locked = await g.lockdown(s.guard, {
        scope: 'gate',
        gateId: s.guard.gateId,
        reasonCode: 'drill',
      });
      try {
        expect(
          code(
            await g
              .raiseRaw(s.guard, {
                kind: 'visitor_without_pass',
                unitCode: s.unitCode,
              })
              .expect(409),
          ),
        ).toBe('LOCKDOWN_ACTIVE');
      } finally {
        await g.endLockdownRaw(s.manager, locked.id, {
          reasonCode: 'drill_over',
        });
      }
      await g.block(s.manager, { subject: 'plate', plate: 'ب ن 9911' });
      const before = await g.inTx(s.c, (tx) => tx.gateFieldException.count());
      expect(
        code(
          await g
            .raiseRaw(s.guard, {
              kind: 'unregistered_vehicle',
              unitCode: s.unitCode,
              vehiclePlate: 'ب ن 9911',
            })
            .expect(409),
        ),
      ).toBe('ENTRY_BLOCKED');
      expect(await g.inTx(s.c, (tx) => tx.gateFieldException.count())).toBe(
        before,
      );
      expect(
        await g.inTx(s.c, (tx) =>
          tx.blocklistMatch.count({ where: { source: 'field_exception' } }),
        ),
      ).toBeGreaterThan(0);
    });
  });

  describe('answered', () => {
    it('by a decider only; the first answer wins and the guard is told', async () => {
      const x = await g.visitor(s.guard, s.unitCode);
      const supervisor = await g.supervisor(s.c);
      await g.decideRaw(supervisor, x.id, { decision: 'approve' }).expect(403);
      await g.decideRaw(s.guard, x.id, { decision: 'approve' }).expect(403);
      const approved = await g.approve(s.manager, x.id);
      expect(approved).toMatchObject({
        status: 'approved',
        decidedBy: { id: s.manager.id },
        rejectReasonCode: null,
      });
      expect(
        new Date(approved.entryUntil!).getTime() -
          new Date(approved.decidedAt!).getTime(),
      ).toBe(15 * MINUTE);
      const again = await g
        .decideRaw(s.manager, x.id, { decision: 'reject', reasonCode: 'other' })
        .expect(409);
      expect(again.body).toMatchObject({
        code: 'GATE_EXCEPTION_DECIDED',
        params: { status: 'approved' },
      });
      expect(await g.told(s.c, s.guard.id, x.id)).toEqual([
        {
          kind: 'gate_exception.decided',
          params: { decision: 'approved', unitCode: s.unitCode },
        },
      ]);
    });

    it('a rejection says why from its list; an approval says nothing', async () => {
      const x = await g.visitor(s.guard, s.unitCode);
      expect(
        code(
          await g
            .decideRaw(s.manager, x.id, {
              decision: 'approve',
              reasonCode: 'other',
            })
            .expect(400),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(
        code(
          await g
            .decideRaw(s.manager, x.id, { decision: 'reject' })
            .expect(400),
        ),
      ).toBe('REASON_REQUIRED');
      const rejected = (
        await g
          .decideRaw(s.manager, x.id, {
            decision: 'reject',
            reasonCode: 'identity_unclear',
          })
          .expect(200)
      ).body as StaffExceptionBody;
      expect(rejected).toMatchObject({
        status: 'rejected',
        rejectReasonCode: 'identity_unclear',
        entryUntil: null,
      });
      expect((await entry(s.guard, x.id).expect(409)).body).toMatchObject({
        code: 'GATE_ENTRY_REFUSED',
        params: { reason: 'not_approved' },
      });
    });

    it('withdrawn by the guard while pending; answered afterwards: refused', async () => {
      const x = await g.visitor(s.guard, s.unitCode);
      const withdrawn = (
        await g
          .http(
            'post',
            `/gate/field-exceptions/${x.id}/withdraw`,
            s.guard.token,
          )
          .expect(200)
      ).body as GuardExceptionBody;
      expect(withdrawn.status).toBe('withdrawn');
      expect(
        (
          await g
            .decideRaw(s.manager, x.id, { decision: 'approve' })
            .expect(409)
        ).body,
      ).toMatchObject({ params: { status: 'withdrawn' } });
    });

    it('a guard at another gate never reads it', async () => {
      const x = await g.visitor(s.guard, s.unitCode);
      const elsewhere = await g.guardOnDuty(s.c);
      expect(
        code(
          await g
            .http('get', `/gate/field-exceptions/${x.id}`, elsewhere.token)
            .expect(404),
        ),
      ).toBe('GATE_EXCEPTION_NOT_FOUND');
    });
  });

  describe('expired', () => {
    it('unanswered by its deadline: read as expired, written once, the guard told once', async () => {
      const x = await g.visitor(s.guard, s.unitCode);
      await g.pastDeadline(x.id);
      expect((await g.follow(s.guard, x.id)).status).toBe('expired');
      expect((await g.row(s.c, x.id)).status).toBe('expired');
      expect(
        (
          await g
            .decideRaw(s.manager, x.id, { decision: 'approve' })
            .expect(409)
        ).body,
      ).toMatchObject({
        code: 'GATE_EXCEPTION_DECIDED',
        params: { status: 'expired' },
      });
      // The sweep finds it done.
      await g.sweepExceptions();
      expect(await g.told(s.c, s.guard.id, x.id)).toEqual([
        { kind: 'gate_exception.expired', params: { unitCode: s.unitCode } },
      ]);
      const [audit] = await read.tenant(s.c.tenantId, {
        action: 'gate_exception.expired',
        targetId: x.id,
      });
      expect(audit).toMatchObject({ actorType: 'system', actorId: null });
    });

    it('by the sweep when nobody reads it, once', async () => {
      const x = await g.visitor(s.guard, s.unitCode);
      await g.pastDeadline(x.id);
      await g.sweepExceptions();
      await g.sweepExceptions();
      expect((await g.row(s.c, x.id)).status).toBe('expired');
      expect(
        (await g.told(s.c, s.guard.id, x.id)).filter(
          (n) => n.kind === 'gate_exception.expired',
        ),
      ).toHaveLength(1);
    });

    it('an answer racing its deadline loses to it: by the database’s clock', async () => {
      const x = await g.visitor(s.guard, s.unitCode);
      await g.pastDeadline(x.id, 0);
      expect(
        (
          await g
            .decideRaw(s.manager, x.id, { decision: 'approve' })
            .expect(409)
        ).body,
      ).toMatchObject({ params: { status: 'expired' } });
    });
  });

  describe('the one entry', () => {
    it('at its gate, within its window, once; the exit as any', async () => {
      const x = await g.visitor(s.guard, s.unitCode);
      await g.approve(s.manager, x.id);
      const elsewhere = await g.guardOnDuty(s.c);
      expect((await entry(elsewhere, x.id).expect(409)).body).toMatchObject({
        params: { reason: 'wrong_gate' },
      });
      const inside = await entry(s.guard, x.id).expect(201);
      expect(inside.body).toMatchObject({
        subjectType: 'field_exception',
        subjectId: x.id,
        method: 'exception',
        unitCode: s.unitCode,
      });
      const used = await g.row(s.c, x.id);
      expect(used.usedEntryId).toBe((inside.body as { id: string }).id);
      await entry(s.guard, x.id, { direction: 'out' }).expect(201);
      expect((await entry(s.guard, x.id).expect(409)).body).toMatchObject({
        params: { reason: 'used' },
      });
    });

    it('past its window: refused as expired', async () => {
      const x = await g.visitor(s.guard, s.unitCode);
      await g.approve(s.manager, x.id);
      await g.pastEntryWindow(x.id);
      expect((await entry(s.guard, x.id).expect(409)).body).toMatchObject({
        params: { reason: 'expired' },
      });
    });

    it('never past a ban added after the approval, nor a lockdown', async () => {
      const plate = 'ك ل 5521';
      const x = await g.raise(s.guard, {
        kind: 'unregistered_vehicle',
        unitCode: s.unitCode,
        vehiclePlate: plate,
      });
      await g.approve(s.manager, x.id);
      const locked = await g.lockdown(s.guard, {
        scope: 'gate',
        gateId: s.guard.gateId,
        reasonCode: 'drill',
      });
      try {
        expect(code(await entry(s.guard, x.id).expect(409))).toBe(
          'LOCKDOWN_ACTIVE',
        );
      } finally {
        await g.endLockdownRaw(s.manager, locked.id, {
          reasonCode: 'drill_over',
        });
      }
      await g.block(s.manager, { subject: 'plate', plate });
      expect(code(await entry(s.guard, x.id).expect(409))).toBe(
        'ENTRY_BLOCKED',
      );
      expect((await g.row(s.c, x.id)).usedAt).toBeNull();
    });
  });

  describe('a worker outside their hours', () => {
    it('comes in as the worker, their schedule waived once', async () => {
      const w = await g.worker(s.c, s.alice, s.home.id, 'outside');
      const x = await g.raise(s.guard, {
        kind: 'worker_outside_hours',
        worker: { type: 'worker_engagement', id: w.engagementId },
      });
      expect(x).toMatchObject({
        unitCode: s.unitCode,
        worker: { type: 'worker_engagement', id: w.engagementId },
      });
      expect((await g.staffView(s.manager, x.id)).workerName).toBe(w.fullName);
      await g.approve(s.manager, x.id);
      const inside = await entry(s.guard, x.id).expect(201);
      expect(inside.body).toMatchObject({
        subjectType: 'worker_engagement',
        subjectId: w.engagementId,
        method: 'exception',
      });
      // The household knows its worker came, as always.
      expect(
        (await g.notifications(s.c, s.alice.id, 'worker.entered')).some(
          (n) => n.targetId === w.engagementId,
        ),
      ).toBe(true);
    });

    it('within their hours: nothing to ask', async () => {
      const w = await g.worker(s.c, s.alice, s.home.id, 'inside');
      expect(
        code(
          await g
            .raiseRaw(s.guard, {
              kind: 'worker_outside_hours',
              worker: { type: 'worker_engagement', id: w.engagementId },
            })
            .expect(409),
        ),
      ).toBe('GATE_EXCEPTION_NOT_NEEDED');
    });
  });

  describe('the settings', () => {
    it('the management sets the minutes; what was asked keeps its own', async () => {
      const before = await g.visitor(s.guard, s.unitCode);
      await g
        .http('patch', '/staff/gate/settings', s.manager.token, {
          exceptionAnswerMinutes: 4,
        })
        .expect(200);
      const after = await g.visitor(s.guard, s.unitCode);
      expect(
        new Date(after.answerBy).getTime() - new Date(after.raisedAt).getTime(),
      ).toBe(4 * MINUTE);
      expect((await g.follow(s.guard, before.id)).answerBy).toBe(
        before.answerBy,
      );
      const [changed] = await read.tenant(s.c.tenantId, {
        action: 'gate_settings.changed',
        targetId: s.c.tenantId,
      });
      expect(changed.changes).toEqual({
        exceptionAnswerMinutes: { from: 10, to: 4 },
      });
      await g
        .http('patch', '/staff/gate/settings', s.manager.token, {
          exceptionAnswerMinutes: 10,
        })
        .expect(200);
    });
  });

  describe('privacy', () => {
    it('the name, the plate and the ID number never reach the audit, a notification, the outbox or an idempotency record', async () => {
      const x = await g.raise(s.guard, {
        kind: 'unregistered_vehicle',
        unitCode: s.unitCode,
        visitorName: NAME,
        vehiclePlate: PLATE,
        idNumber: ID_NUMBER,
      });
      await g.approve(s.manager, x.id);
      const since = new Date(dbClock().getTime() - 60 * MINUTE);
      const rows = await g.inTx(s.c, async (tx) => ({
        audit: await tx.auditLog.findMany({
          where: { occurredAt: { gte: since } },
        }),
        notifications: await tx.notification.findMany({
          where: { createdAt: { gte: since } },
        }),
        keys: await tx.idempotencyKey.findMany({
          where: { createdAt: { gte: since } },
        }),
        // The outbox is global: this compound's messages.
        outbox: await h.moduleRef.get(GlobalDbService).outboxMessage.findMany({
          where: { tenantId: s.c.tenantId, createdAt: { gte: since } },
        }),
      }));
      const text = leakText(rows);
      for (const secret of [NAME, PLATE, PLATE.replace(/\s/g, ''), ID_NUMBER])
        expect(text).not.toContain(secret);
      const [raised] = await read.tenant(s.c.tenantId, {
        action: 'gate_exception.raised',
        targetId: x.id,
      });
      expect(raised.metadata).toMatchObject({
        kind: 'unregistered_vehicle',
        visitorName: true,
        withPlate: true,
      });
    });
  });
});

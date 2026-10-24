import { dbClock } from '../setup/compound-clock';
import {
  decisionAppealHelpers,
  type DecisionAppealBody,
  type DecisionAppealsSetUp,
} from '../setup/decision-appeals';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { neighboursHelpers } from '../setup/neighbours';
import { plate, sticker } from '../setup/vehicles';
import { day } from '../setup/facilities';

/**
 * ADR 0059: a resident appeals a staff decision about their unit to the
 * management, within 15 days, once; a manager who did not take it decides,
 * with a rationale; an overturn runs the decision's normal approval with
 * every check it makes, and what a check refuses is left to follow up —
 * never forced.
 */
describe('Decision appeals', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof decisionAppealHelpers>;
  let s: DecisionAppealsSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = decisionAppealHelpers(h);
    s = await d.setUp();
  });

  afterAll(() => h.close());

  const code = (res: { status: number; body: unknown }) => ({
    status: res.status,
    code: (res.body as { code?: string }).code,
    reason: (res.body as { params?: { reason?: string } }).params?.reason,
  });

  describe('a rejected permit', () => {
    it('the primary appeals; the manager who rejected it may not decide; another overturns it and it is approved', async () => {
      const permitId = await d.rejectedPermit(s.manager, s.alice, s.home.id);
      const lodged = await d.lodge(s.alice, 'permit_rejection', permitId, {
        grounds: 'The works fit the hours.',
      });
      expect(lodged).toMatchObject({
        reference: expect.stringMatching(/^AP-\d{6}$/) as string,
        kind: 'permit_rejection',
        subjectId: permitId,
        status: 'pending',
        mine: true,
        grounds: 'The works fit the hours.',
        decision: null,
        subject: { kind: 'works', status: 'rejected' },
      });
      // The deciders are told.
      expect(await d.told(s.c, s.decider.id, lodged.id)).toEqual([
        {
          kind: 'decision_appeal.lodged',
          params: { kind: 'permit_rejection' },
        },
      ]);
      expect(
        code(
          await d.decideRaw(s.manager, lodged.id, { outcome: 'overturned' }),
        ),
      ).toMatchObject({ status: 409, code: 'APPEAL_DECIDER_CONFLICT' });
      const decided = await d.decide(s.decider, lodged.id, {
        outcome: 'overturned',
        rationale: 'The hours were within the rules.',
      });
      expect(decided).toMatchObject({
        status: 'overturned',
        ownDecision: false,
        decision: {
          outcome: 'overturned',
          rationale: 'The hours were within the rules.',
          decidedBy: { roleKey: 'manager' },
          effect: 'applied',
          effectReason: null,
        },
      });
      const permit = await d.v.inTx(s.c, (tx) =>
        tx.unitPermit.findUniqueOrThrow({ where: { id: permitId } }),
      );
      expect(permit).toMatchObject({
        status: 'approved',
        rejectReason: 'outside_rules',
        appealOverturnedById: s.decider.id,
      });
      expect(permit.decisionAppealClosedAt).not.toBeNull();
      // Its requester is told as an approval tells them; the appellant of
      // the decision.
      const told = await d.told(s.c, s.alice.id, permitId);
      expect(told.map((t) => t.kind)).toContain('unit_permit.approved');
      expect(await d.told(s.c, s.alice.id, lodged.id)).toContainEqual({
        kind: 'decision_appeal.decided',
        params: { kind: 'permit_rejection', outcome: 'overturned' },
      });
      // Decided once.
      expect(
        code(await d.decideRaw(s.decider, lodged.id, { outcome: 'upheld' })),
      ).toMatchObject({ status: 409, code: 'DECISION_APPEAL_NOT_PENDING' });
      // The resident's appeals list: the management decided it, by role.
      const appeals = (
        await d.http('get', '/me/appeals', s.alice.token).expect(200)
      ).body as {
        data: { id: string; type: string; appeal: Record<string, unknown> }[];
      };
      expect(appeals.data.find((i) => i.id === lodged.id)).toMatchObject({
        type: 'decision_appeal',
        appeal: {
          state: 'overturned',
          decidedBy: 'management',
          deciderRole: { key: 'manager' },
        },
      });
    });

    it('an overturn runs the normal checks: the unit’s limit refuses it, left to follow up', async () => {
      const other = await d.setUp('Appeals Limit Court');
      const permitId = await d.rejectedPermit(
        other.manager,
        other.alice,
        other.home.id,
      );
      // Three live works permits now: the unit's limit.
      for (let i = 0; i < 3; i++) await d.works(other.alice, other.home.id);
      const lodged = await d.lodge(other.alice, 'permit_rejection', permitId);
      const decided = await d.decide(other.decider, lodged.id, {
        outcome: 'overturned',
      });
      expect(decided.decision).toMatchObject({
        effect: 'follow_up',
        effectReason: 'unit_limit',
      });
      expect(
        (
          await d.v.inTx(other.c, (tx) =>
            tx.unitPermit.findUniqueOrThrow({ where: { id: permitId } }),
          )
        ).status,
      ).toBe('rejected');
      // Followed up once.
      await d
        .http(
          'post',
          `/staff/decision-appeals/${lodged.id}/followed-up`,
          other.decider.token,
        )
        .expect(200);
      expect(
        code(
          await d.http(
            'post',
            `/staff/decision-appeals/${lodged.id}/followed-up`,
            other.decider.token,
          ),
        ),
      ).toMatchObject({ status: 409, code: 'DECISION_APPEAL_NO_FOLLOW_UP' });
    });

    it('the compound’s work rules refuse it now: left to follow up', async () => {
      const other = await d.setUp('Appeals Rules Court');
      const permitId = await d.rejectedPermit(
        other.manager,
        other.alice,
        other.home.id,
      );
      // The works' hours (09:00–17:00) are outside the compound's now.
      await d.setRules(other.manager, {
        workHours: { from: '18:00', to: '20:00' },
      });
      const lodged = await d.lodge(other.alice, 'permit_rejection', permitId);
      expect(
        (await d.decide(other.decider, lodged.id, { outcome: 'overturned' }))
          .decision,
      ).toMatchObject({ effect: 'follow_up', effectReason: 'work_rules' });
    });

    it('a banned plate on it refuses it: left to follow up', async () => {
      const other = await d.setUp('Appeals Ban Court');
      const move = await d.move(other.alice, other.home.id, {
        truckPlate: 'ب ن د ٧٧٣',
      });
      await d
        .decidePermit(other.manager, move.id, 'reject', {
          reasonCode: 'safety_concern',
        })
        .expect(200);
      await d
        .http('post', '/staff/security/blocklist', other.manager.token, {
          subject: 'plate',
          plate: 'بند773',
          kind: 'ban',
          reasonCode: 'trespassing',
        })
        .expect(201);
      const lodged = await d.lodge(other.alice, 'permit_rejection', move.id);
      expect(
        (await d.decide(other.decider, lodged.id, { outcome: 'overturned' }))
          .decision,
      ).toMatchObject({ effect: 'follow_up', effectReason: 'blocklisted' });
    });

    it('who may appeal, when, and once', async () => {
      const permitId = await d.rejectedPermit(s.manager, s.alice, s.home.id);
      // Another compound's resident: not found.
      const far = await d.setUp('Appeals Far Court');
      expect(
        code(await d.lodgeRaw(far.alice, 'permit_rejection', permitId)),
      ).toMatchObject({
        status: 404,
        code: 'DECISION_APPEAL_SUBJECT_NOT_FOUND',
      });
      // A member of the household who is not its primary: not theirs.
      const member = await d.v.family(s.c, s.home.id, s.alice);
      expect(
        code(await d.lodgeRaw(member, 'permit_rejection', permitId)),
      ).toMatchObject({ status: 403, code: 'DECISION_APPEAL_NOT_ALLOWED' });
      await d.lodge(s.alice, 'permit_rejection', permitId);
      expect(
        code(await d.lodgeRaw(s.alice, 'permit_rejection', permitId)),
      ).toMatchObject({ status: 409, code: 'DECISION_APPEAL_EXISTS' });
      // A decision that stands for the unit: nothing to appeal.
      const approved = await d.works(s.alice, s.home.id);
      await d.approve(s.manager, approved.id);
      expect(
        code(await d.lodgeRaw(s.alice, 'permit_rejection', approved.id)),
      ).toMatchObject({
        status: 409,
        code: 'DECISION_APPEAL_NOT_ELIGIBLE',
        reason: 'not_in_force',
      });
    });
  });

  describe('a rejected vehicle', () => {
    it('overturned with the sticker and the permit’s day: active, as an approval makes it', async () => {
      const vehicleId = await d.rejectedVehicle(s.manager, s.alice, s.home.id);
      const lodged = await d.lodge(s.alice, 'vehicle_rejection', vehicleId);
      const number = sticker();
      expect(
        (
          await d.decide(s.decider, lodged.id, {
            outcome: 'overturned',
            stickerNumber: number,
            permitValidUntil: day(365),
          })
        ).decision,
      ).toMatchObject({ effect: 'applied' });
      expect(
        await d.v.inTx(s.c, (tx) =>
          tx.vehicle.findUniqueOrThrow({ where: { id: vehicleId } }),
        ),
      ).toMatchObject({
        status: 'active',
        stickerNumber: number.toUpperCase(),
        rejectionReason: null,
        decidedById: s.decider.id,
      });
    });

    it('overturned without a sticker, or with one issued before: left to follow up', async () => {
      const first = await d.rejectedVehicle(s.manager, s.alice, s.home.id);
      const a = await d.lodge(s.alice, 'vehicle_rejection', first);
      expect(
        (await d.decide(s.decider, a.id, { outcome: 'overturned' })).decision,
      ).toMatchObject({ effect: 'follow_up', effectReason: 'needs_sticker' });
      const second = await d.rejectedVehicle(s.manager, s.alice, s.home.id);
      const taken = sticker();
      const third = await d.v.register(s.alice, s.home.id);
      await d.v
        .approveRaw(s.manager, third.id, { stickerNumber: taken })
        .then((r) => expect(r.status).toBe(200));
      const b = await d.lodge(s.alice, 'vehicle_rejection', second);
      expect(
        (
          await d.decide(s.decider, b.id, {
            outcome: 'overturned',
            stickerNumber: taken,
            permitValidUntil: day(30),
          })
        ).decision,
      ).toMatchObject({ effect: 'follow_up', effectReason: 'sticker_used' });
    });

    it('the 15 days run from the decision', async () => {
      const vehicleId = await d.rejectedVehicle(s.manager, s.alice, s.home.id);
      await d.v.inTx(s.c, (tx) =>
        tx.vehicle.update({
          where: { id: vehicleId },
          // eslint-disable-next-line no-restricted-syntax -- a real 16 × 24 h: the window is 15 × 24 h after the decision's instant, in ms
          data: { decidedAt: new Date(dbClock().getTime() - 16 * 86_400_000) },
        }),
      );
      expect(
        code(await d.lodgeRaw(s.alice, 'vehicle_rejection', vehicleId)),
      ).toMatchObject({ status: 409, code: 'DECISION_APPEAL_WINDOW_PASSED' });
    });

    it('a new plate while the appeal waits: the overturn finds it changed and does nothing (×3)', async () => {
      // A compound of its own: each new plate makes a pending vehicle.
      const own = await d.setUp('Appeals Plate Court');
      for (let i = 0; i < 3; i++) {
        const vehicleId = await d.rejectedVehicle(
          own.manager,
          own.alice,
          own.home.id,
        );
        const [lodge, replate] = await Promise.all([
          d.lodgeRaw(own.alice, 'vehicle_rejection', vehicleId),
          d.http('patch', `/vehicles/${vehicleId}`, own.alice.token, {
            plate: plate(),
          }),
        ]);
        expect(replate.status).toBe(200);
        if (lodge.status === 201) {
          const appeal = lodge.body as DecisionAppealBody;
          expect(
            (
              await d.decide(own.decider, appeal.id, {
                outcome: 'overturned',
                stickerNumber: sticker(),
                permitValidUntil: day(30),
              })
            ).decision,
          ).toMatchObject({ effect: 'none', effectReason: 'changed' });
        } else
          expect(code(lodge)).toMatchObject({
            status: 409,
            code: 'DECISION_APPEAL_NOT_ELIGIBLE',
            reason: 'not_in_force',
          });
      }
    });
  });

  describe('a rejected worker', () => {
    it('the requester is told of the rejection; the employer side appeals; an overturn is always reviewed again', async () => {
      const engagementId = await d.rejectedWorker(s.c, s.alice, s.home.id);
      expect(await d.told(s.c, s.alice.id, engagementId)).toEqual([
        {
          kind: 'worker.engagement_rejected',
          params: { reason: 'documents_invalid' },
        },
      ]);
      const lodged = await d.lodge(s.alice, 'worker_rejection', engagementId);
      expect(lodged.subject).toMatchObject({
        status: 'rejected',
        rejectReason: 'documents_invalid',
      });
      expect(
        (await d.decide(s.decider, lodged.id, { outcome: 'overturned' }))
          .decision,
      ).toMatchObject({ effect: 'follow_up', effectReason: 'needs_review' });
      expect(
        (
          await d.v.inTx(s.c, (tx) =>
            tx.workerEngagement.findUniqueOrThrow({
              where: { id: engagementId },
            }),
          )
        ).status,
      ).toBe('rejected');
    });

    it('upheld: the decision stands, nothing changes', async () => {
      const engagementId = await d.rejectedWorker(s.c, s.alice, s.home.id);
      const lodged = await d.lodge(s.alice, 'worker_rejection', engagementId);
      expect(
        await d.decide(s.decider, lodged.id, { outcome: 'upheld' }),
      ).toMatchObject({
        status: 'upheld',
        decision: { outcome: 'upheld', effect: 'none', effectReason: null },
      });
    });
  });

  describe('a neighbour notice', () => {
    it('its recipient appeals; an overturn withdraws it, as the unit then reads it', async () => {
      const n = neighboursHelpers(h);
      const ns = await n.setUp();
      const complaint = await n.complain(ns.c, ns.bob, ns.homeA.code);
      const noticeId = await n.noticed(ns.handler, complaint.id);
      const decider = await d.secondManager(ns.c);
      // Not the complainant's: only its recipients find it.
      expect(
        code(await d.lodgeRaw(ns.bob, 'neighbour_notice', noticeId)),
      ).toMatchObject({
        status: 404,
        code: 'DECISION_APPEAL_SUBJECT_NOT_FOUND',
      });
      const lodged = await d.lodge(ns.alice, 'neighbour_notice', noticeId);
      expect(
        (await d.decide(decider, lodged.id, { outcome: 'overturned' }))
          .decision,
      ).toMatchObject({ effect: 'applied' });
      const read = (
        await n
          .http('get', `/neighbour-notices/${noticeId}`, ns.alice.token)
          .expect(200)
      ).body as { withdrawnAt: string | null };
      expect(read.withdrawnAt).not.toBeNull();
    });
  });

  describe('withdrawn, and the races', () => {
    it('the appellant withdraws; the permit’s mark closes; a decision then is refused', async () => {
      const permitId = await d.rejectedPermit(s.manager, s.alice, s.home.id);
      const lodged = await d.lodge(s.alice, 'permit_rejection', permitId);
      const res = await d.withdrawRaw(s.alice, lodged.id).expect(200);
      expect(res.body).toMatchObject({ status: 'withdrawn' });
      expect(
        (
          await d.v.inTx(s.c, (tx) =>
            tx.unitPermit.findUniqueOrThrow({ where: { id: permitId } }),
          )
        ).decisionAppealClosedAt,
      ).not.toBeNull();
      expect(
        code(await d.decideRaw(s.decider, lodged.id, { outcome: 'upheld' })),
      ).toMatchObject({ status: 409, code: 'DECISION_APPEAL_NOT_PENDING' });
    });

    it('a decision and a withdrawal at once: exactly one of them (×3)', async () => {
      for (let i = 0; i < 3; i++) {
        const engagementId = await d.rejectedWorker(s.c, s.alice, s.home.id);
        const lodged = await d.lodge(s.alice, 'worker_rejection', engagementId);
        const [decided, withdrawn] = await Promise.all([
          d.decideRaw(s.decider, lodged.id, { outcome: 'upheld' }),
          d.withdrawRaw(s.alice, lodged.id),
        ]);
        expect([decided.status, withdrawn.status].sort()).toEqual([200, 409]);
        const row = await d.row(s.c, lodged.id);
        expect(row.status).toBe(
          decided.status === 200 ? 'upheld' : 'withdrawn',
        );
      }
    });

    it('two managers decide at once: one decision (×3)', async () => {
      const third = await d.secondManager(s.c);
      for (let i = 0; i < 3; i++) {
        const engagementId = await d.rejectedWorker(s.c, s.alice, s.home.id);
        const lodged = await d.lodge(s.alice, 'worker_rejection', engagementId);
        const results = await Promise.all([
          d.decideRaw(s.decider, lodged.id, { outcome: 'upheld' }),
          d.decideRaw(third, lodged.id, { outcome: 'overturned' }),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      }
    });
  });

  describe('who reads what', () => {
    it('the primary reads the unit’s appeal without the grounds; another unit does not find it', async () => {
      const vehicleId = await d.rejectedVehicle(s.manager, s.alice, s.home.id);
      const lodged = await d.lodge(s.alice, 'vehicle_rejection', vehicleId, {
        grounds: 'The plate was read wrong.',
      });
      const staff = (
        await d
          .http('get', `/staff/decision-appeals/${lodged.id}`, s.decider.token)
          .expect(200)
      ).body as DecisionAppealBody;
      expect(staff.grounds).toBe('The plate was read wrong.');
      const far = await d.setUp('Appeals Reader Court');
      expect(
        code(
          await d.http(
            'get',
            `/decision-appeals/${lodged.id}`,
            far.alice.token,
          ),
        ),
      ).toMatchObject({ status: 404, code: 'DECISION_APPEAL_NOT_FOUND' });
      // A resident never reaches the deciders' routes.
      expect(
        (
          await d.http(
            'get',
            `/staff/decision-appeals/${lodged.id}`,
            s.alice.token,
          )
        ).status,
      ).toBe(403);
    });
  });
});

import { auditReaders } from '../setup/audit';
import { boardAppealHelpers, type AppealBody } from '../setup/board-appeals';
import type { MotionBody } from '../setup/board-matters';
import { decisionAppealHelpers } from '../setup/decision-appeals';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0059 at the board (on ADR 0055): a decision appeal the management
 * upheld, taken on to the board, whose overturn applies the same domain
 * effect through the same checks; and a complaint about the management,
 * lodged as a board appeal at once, at most three open per owner, its
 * author's alone, its unit and grounds never the staff's.
 */
describe('The board — management appeals and complaints', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof boardAppealHelpers>;
  let d: ReturnType<typeof decisionAppealHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof boardAppealHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = boardAppealHelpers(h);
    d = decisionAppealHelpers(h);
    // o(0), o(1), o(2) sit; o(3)…o(9) own a unit each (its primary).
    s = await a.setUp(10, 3);
    await d.anyTime(s.manager);
  }, 240_000);

  afterAll(() => h.close());

  const o = (i: number) => s.owners[i];
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  const motionOf = (res: { body: unknown }) => res.body as MotionBody;
  const carry = async (appealId: string, outcome: 'overturn' | 'uphold') => {
    const m = motionOf(
      await a
        .proposeOn(o(0), appealId, { outcome, rationale: 'Decided.' })
        .expect(201),
    );
    await a.vote(o(0), m.id, 'for').expect(201);
    await a.vote(o(1), m.id, 'for').expect(201);
  };
  const complain = (as: { token: string }, unitId: string, over = {}) =>
    a.http('post', '/governance/management-complaints', as.token, {
      unitId,
      category: 'delay',
      requestNumber: 12,
      grounds: 'Nobody answered for a month.',
      ...over,
    });

  describe('a management decision taken to the board', () => {
    it('only once upheld; the board’s overturn approves the permit through the same checks', async () => {
      const decider = await d.secondManager(s.c);
      const owner = o(4);
      const permitId = await d.rejectedPermit(s.manager, owner, owner.unitId);
      const appeal = await d.lodge(owner, 'permit_rejection', permitId);
      // Pending at the management: nothing to take to the board.
      expect(
        code(
          await a
            .lodge(owner, appeal.id, { kind: 'management_appeal' })
            .expect(409),
        ),
      ).toBe('BOARD_APPEAL_NOT_ELIGIBLE');
      await d.decide(decider, appeal.id, { outcome: 'upheld' });
      const board = await a.appeal(owner, appeal.id, {
        kind: 'management_appeal',
      });
      expect(board).toMatchObject({
        kind: 'management_appeal',
        subject: { kind: 'permit_rejection', status: 'upheld' },
      });
      // The permit is marked again while the board has it.
      const marked = await d.v.inTx(s.c, (tx) =>
        tx.unitPermit.findUniqueOrThrow({ where: { id: permitId } }),
      );
      expect(marked.decisionAppealClosedAt).toBeNull();
      await carry(board.id, 'overturn');
      const permit = await d.v.inTx(s.c, (tx) =>
        tx.unitPermit.findUniqueOrThrow({ where: { id: permitId } }),
      );
      expect(permit).toMatchObject({
        status: 'approved',
        appealOverturnedById: null,
      });
      const staff = (
        await a
          .http(
            'get',
            `/staff/governance/board-appeals/${board.id}`,
            s.manager.token,
          )
          .expect(200)
      ).body as { effect: string; status: string };
      expect(staff).toMatchObject({ status: 'overturned', effect: 'applied' });
      expect((await d.row(s.c, appeal.id)).boardAppealClosedAt).not.toBeNull();
    });

    it('a vehicle overturned by the board needs a sticker: left to the management', async () => {
      const decider = await d.secondManager(s.c);
      const owner = o(5);
      const vehicleId = await d.rejectedVehicle(s.manager, owner, owner.unitId);
      const appeal = await d.lodge(owner, 'vehicle_rejection', vehicleId);
      await d.decide(decider, appeal.id, { outcome: 'upheld' });
      const board = await a.appeal(owner, appeal.id, {
        kind: 'management_appeal',
      });
      await carry(board.id, 'overturn');
      expect(
        (
          (
            await a
              .http(
                'get',
                `/staff/governance/board-appeals/${board.id}`,
                s.manager.token,
              )
              .expect(200)
          ).body as { effect: string }
        ).effect,
      ).toBe('follow_up');
    });
  });

  describe('a complaint about the management', () => {
    it('its author’s alone; the staff see neither its unit nor its grounds; overturned is founded, followed up', async () => {
      const owner = o(6);
      const res = await complain(owner, owner.unitId).expect(201);
      const filed = res.body as AppealBody;
      expect(filed).toMatchObject({
        kind: 'management_complaint',
        mine: true,
        grounds: 'Nobody answered for a month.',
        subject: { category: 'delay', requestNumber: 12 },
      });
      const staff = (
        await a
          .http(
            'get',
            `/staff/governance/board-appeals/${filed.id}`,
            s.manager.token,
          )
          .expect(200)
      ).body as Record<string, unknown>;
      expect(staff.unitCode).toBeNull();
      expect(JSON.stringify(staff)).not.toContain('Nobody answered');
      // Another owner of the compound does not find it.
      await a
        .http('get', `/governance/board-appeals/${filed.id}`, o(7).token)
        .expect(404);
      // The audit trail names no unit.
      const [lodged] = await auditReaders(h).tenant(s.c.tenantId, {
        action: 'governance_board_appeal.lodged',
        targetId: filed.id,
      });
      expect(lodged.changes).not.toHaveProperty('unitId');
      expect(JSON.stringify(lodged)).not.toContain(owner.unitId);
      await carry(filed.id, 'overturn');
      const decided = (
        await a
          .http(
            'get',
            `/staff/governance/board-appeals/${filed.id}`,
            s.manager.token,
          )
          .expect(200)
      ).body as { effect: string };
      expect(decided.effect).toBe('follow_up');
      await a
        .http(
          'post',
          `/staff/governance/board-appeals/${filed.id}/followed-up`,
          s.manager.token,
        )
        .expect(200);
    });

    it('an owner or the primary only, of a unit of theirs', async () => {
      expect(code(await complain(o(7), o(8).unitId).expect(403))).toBe(
        'BOARD_APPEAL_NOT_ALLOWED',
      );
    });

    it('at most three open per owner; a withdrawn one frees a place', async () => {
      const owner = o(8);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++)
        ids.push(
          ((await complain(owner, owner.unitId).expect(201)).body as AppealBody)
            .id,
        );
      const refused = await complain(owner, owner.unitId).expect(409);
      expect(refused.body).toMatchObject({
        code: 'MANAGEMENT_COMPLAINT_LIMIT',
        params: { max: 3 },
      });
      await a
        .http(
          'post',
          `/governance/board-appeals/${ids[0]}/withdraw`,
          owner.token,
        )
        .expect(200);
      await complain(owner, owner.unitId).expect(201);
    });

    it('two at once for the last place: one of them (×3)', async () => {
      const owner = o(9);
      for (let i = 0; i < 3; i++) {
        // Two open: one place left.
        const open = (
          await d.v.inTx(s.c, (tx) =>
            tx.governanceBoardAppeal.findMany({
              where: {
                appellantId: owner.id,
                kind: 'management_complaint',
                status: 'pending',
              },
              select: { id: true },
            }),
          )
        ).map((r) => r.id);
        for (const id of open.slice(0, Math.max(0, open.length - 2)))
          await a
            .http(
              'post',
              `/governance/board-appeals/${id}/withdraw`,
              owner.token,
            )
            .expect(200);
        while (
          (await d.v.inTx(s.c, (tx) =>
            tx.governanceBoardAppeal.count({
              where: {
                appellantId: owner.id,
                kind: 'management_complaint',
                status: 'pending',
              },
            }),
          )) < 2
        )
          await complain(owner, owner.unitId).expect(201);
        const results = await Promise.all([
          complain(owner, owner.unitId),
          complain(owner, owner.unitId),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      }
    });
  });
});

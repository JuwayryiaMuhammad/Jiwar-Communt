import { communityHelpers } from '../setup/community';
import { day } from '../setup/compound-clock';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { permitHelpers, type Who } from '../setup/permits';

interface MoveBody {
  id: string;
  reference: string;
  occupancyId: string;
  direction: string;
  status: string;
  plannedBySomeone: boolean;
  handoverReason: string | null;
  cancelReason: string | null;
  code?: string;
}

interface Detail {
  move: MoveBody;
  checklist: {
    key: string;
    side: string;
    done: boolean;
    reference: string | null;
  }[];
}

/** Moving in and out of a unit, and the checklist of each (ADR 0063). */
describe('Unit moves', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;
  let x: ReturnType<typeof communityHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
    x = communityHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  const http = (
    method: 'get' | 'post',
    path: string,
    who: Who,
    body?: object,
  ) =>
    h
      .http()
      [method](`${API}${path}`)
      .set('Authorization', `Bearer ${who.token}`)
      .send(body);
  const codeOf = (res: { body: unknown }) => (res.body as MoveBody).code;
  const asMove = (res: { body: unknown }) => res.body as MoveBody;

  type SetUp = Awaited<ReturnType<typeof p.setUp>>;
  /** The home's move-in, planned when its owner's occupancy began. */
  async function moveIn(s: SetUp): Promise<MoveBody> {
    const moves = (
      await http('get', `/units/${s.home.id}/moves`, s.alice).expect(200)
    ).body as MoveBody[];
    return moves.find((m) => m.direction === 'in')!;
  }
  const notice = (s: SetUp, who: Who = s.alice) =>
    http('post', `/units/${s.home.id}/moves/move-out`, who, {
      plannedOn: day(10),
    });
  const moveRow = (s: SetUp, id: string) =>
    x.asManager(s.c, () =>
      x.prisma.tenant.unitMove.findUniqueOrThrow({ where: { id } }),
    );

  it('a residing occupancy plans its move-in; each side ticks its own steps; a permit and a utilities request tick theirs; the management confirms', async () => {
    const s = await p.setUp('Moves Court');
    const mv = await moveIn(s);
    expect(mv).toMatchObject({ status: 'planned', plannedBySomeone: false });
    expect(mv.reference).toMatch(/^MV-\d{6}$/);
    const open = async (who: 'resident' | 'staff') =>
      (
        await (
          who === 'resident'
            ? http('get', `/units/${s.home.id}/moves/${mv.id}`, s.alice)
            : http('get', `/staff/moves/${mv.id}`, s.manager)
        ).expect(200)
      ).body as Detail;
    expect(
      (await open('resident')).checklist.map((c) => [c.key, c.side, c.done]),
    ).toEqual([
      ['guide_read', 'resident', false],
      ['keys_received', 'management', false],
      ['meters_read', 'management', false],
      ['move_permit', 'derived', false],
      ['utilities_requested', 'derived', false],
    ]);

    // Each side ticks its own, once.
    const tick = (step: string) =>
      http('post', `/units/${s.home.id}/moves/${mv.id}/steps`, s.alice, {
        step,
      });
    await tick('guide_read').expect(200);
    expect(codeOf(await tick('guide_read'))).toBe('MOVE_STEP_DONE');
    expect((await tick('keys_received')).status).toBe(400);
    await http('post', `/staff/moves/${mv.id}/steps`, s.manager, {
      step: 'keys_received',
    }).expect(200);

    // A move permit that way serves the move; approved, it ticks its step.
    const permit = await p.move(s.alice, s.home.id, { direction: 'in' });
    expect(permit.move).toMatchObject({ direction: 'in', moveId: mv.id });
    await p.approve(s.manager, permit.id);
    // So does the mover's request on the topic `utilities`.
    const topic = await x.asManager(s.c, () =>
      x.prisma.tenant.managementRequestTopic.findFirstOrThrow({
        where: { key: 'utilities' },
      }),
    );
    await http('post', '/management-requests', s.alice, {
      type: 'general',
      topicId: topic.id,
      unitId: s.home.id,
      body: 'Please switch the electricity and the water on.',
    }).expect(201);

    const after = await open('staff');
    expect(after.checklist.filter((c) => c.done).map((c) => c.key)).toEqual([
      'guide_read',
      'keys_received',
      'move_permit',
      'utilities_requested',
    ]);
    const ref = (key: string) =>
      after.checklist.find((c) => c.key === key)!.reference;
    expect(ref('move_permit')).toBe(permit.reference);
    expect(ref('utilities_requested')).toMatch(/^MR-\d{6}$/);

    await http('post', `/staff/moves/${mv.id}/done`, s.manager).expect(200);
    expect(
      codeOf(await http('post', `/staff/moves/${mv.id}/done`, s.manager)),
    ).toBe('MOVE_NOT_PLANNED');
    expect(await moveRow(s, mv.id)).toMatchObject({
      status: 'done',
      doneBy: s.manager.id,
    });
  });

  it('the residing primary gives notice, once; the management is told; with no clearance the handover takes a code', async () => {
    const s = await p.setUp('Move Out Court');
    const t = await x.resident(s.c, [s.home.id], 'tenant');
    const tenant = await p.who(s.c, t.id, 'resident');
    expect(codeOf(await notice(s, tenant))).toBe('MOVE_NOT_ALLOWED');
    const out = asMove(await notice(s).expect(201));
    expect(out).toMatchObject({ direction: 'out', plannedBySomeone: true });
    expect(codeOf(await notice(s))).toBe('MOVE_ALREADY_PLANNED');
    expect(await p.told(s.c, s.manager.id, out.id)).toEqual([
      { kind: 'unit_move.notice_given', params: { plannedOn: day(10) } },
    ]);

    await http('post', `/occupancies/${out.occupancyId}/end`, s.manager, {
      reasonCode: 'moved_out',
      reason: 'Moved away',
    }).expect(200);
    const refused = await http(
      'post',
      `/occupancies/${out.occupancyId}/handover`,
      s.manager,
      {},
    );
    expect([refused.status, codeOf(refused)]).toEqual([
      409,
      'MOVE_HANDOVER_REASON_REQUIRED',
    ]);
    // Refused whole: the handover was not recorded either.
    const occupancy = () =>
      x.asManager(s.c, () =>
        x.prisma.tenant.unitOccupancy.findUniqueOrThrow({
          where: { id: out.occupancyId },
        }),
      );
    expect((await occupancy()).handedOverAt).toBeNull();
    await http('post', `/occupancies/${out.occupancyId}/handover`, s.manager, {
      reasonCode: 'dues_settle_later',
    }).expect(200);
    expect((await occupancy()).handedOverAt).not.toBeNull();
    expect(await moveRow(s, out.id)).toMatchObject({
      status: 'done',
      handoverReason: 'dues_settle_later',
    });
  });

  it('with a clearance since the notice, the handover takes no code', async () => {
    const s = await p.setUp('Move Clear Court');
    const out = asMove(await notice(s).expect(201));
    await http('post', `/units/${s.home.id}/clearances`, s.alice).expect(201);
    const detail = (
      await http('get', `/staff/moves/${out.id}`, s.manager).expect(200)
    ).body as Detail;
    expect(
      detail.checklist.find((c) => c.key === 'clearance_issued'),
    ).toMatchObject({ done: true });
    expect(
      detail.checklist.find((c) => c.key === 'deposits_settled'),
    ).toMatchObject({ done: true });
    await http('post', `/occupancies/${out.occupancyId}/end`, s.manager, {
      reasonCode: 'moved_out',
      reason: 'Moved away',
    }).expect(200);
    await http(
      'post',
      `/occupancies/${out.occupancyId}/handover`,
      s.manager,
      {},
    ).expect(200);
    expect(await moveRow(s, out.id)).toMatchObject({
      status: 'done',
      handoverReason: null,
    });
  });

  it('a notice is withdrawn by its author only; an ended occupancy cancels its planned move-in', async () => {
    const s = await p.setUp('Move Cancel Court');
    const out = asMove(await notice(s).expect(201));
    const mv = await moveIn(s);
    const cancel = (id: string) =>
      http('post', `/units/${s.home.id}/moves/${id}/cancel`, s.alice, {
        reasonCode: 'plans_changed',
      });
    expect(codeOf(await cancel(mv.id))).toBe('MOVE_NOT_ALLOWED');
    expect(asMove(await cancel(out.id).expect(200))).toMatchObject({
      status: 'cancelled',
      cancelReason: 'plans_changed',
    });
    expect(codeOf(await cancel(out.id))).toBe('MOVE_NOT_PLANNED');
    await http('post', `/occupancies/${mv.occupancyId}/end`, s.manager, {
      reasonCode: 'data_correction',
      reason: 'Entered by mistake',
    }).expect(200);
    expect(await moveRow(s, mv.id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'occupancy_ended',
    });
  });

  it('a move only moves forward, a step is ticked once, a permit keeps its direction', async () => {
    const s = await p.setUp('Move Schema Court');
    const mv = await moveIn(s);
    await http('post', `/staff/moves/${mv.id}/steps`, s.manager, {
      step: 'meters_read',
    }).expect(200);
    await http('post', `/staff/moves/${mv.id}/done`, s.manager).expect(200);
    const permit = await p.move(s.alice, s.home.id, { direction: 'in' });
    const tx = <T>(fn: () => Promise<T>) => x.asManager(s.c, fn);
    await expect(
      tx(() =>
        x.prisma.tenant.unitMove.update({
          where: { id: mv.id },
          data: { status: 'planned', doneAt: null, doneBy: null },
        }),
      ),
    ).rejects.toThrow(/unit_moves/);
    await expect(
      tx(() => x.prisma.tenant.unitMove.delete({ where: { id: mv.id } })),
    ).rejects.toThrow(/unit_moves/);
    await expect(
      tx(() =>
        x.prisma.tenant.unitMoveStep.deleteMany({ where: { moveId: mv.id } }),
      ),
    ).rejects.toThrow();
    await expect(
      tx(() =>
        x.prisma.tenant.unitPermit.update({
          where: { id: permit.id },
          data: { moveDirection: 'out' },
        }),
      ),
    ).rejects.toThrow(/unit_permits/);
    // A new move permit without its direction is refused by the database
    // too: only the permits from before ADR 0063 are legacy.
    await expect(
      tx(() =>
        x.prisma.tenant.unitPermit.update({
          where: { id: permit.id },
          data: { legacyMove: true },
        }),
      ),
    ).rejects.toThrow(/unit_permits/);
  });

  it('race: two notices at once — one move is planned', async () => {
    for (let i = 0; i < 3; i++) {
      const s = await p.setUp(`Move Race Court ${i}`);
      const both = await Promise.all([notice(s), notice(s)]);
      expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(both.map(codeOf).filter(Boolean)).toEqual([
        'MOVE_ALREADY_PLANNED',
      ]);
      const planned = await x.asManager(s.c, () =>
        x.prisma.tenant.unitMove.count({
          where: { unitId: s.home.id, direction: 'out', status: 'planned' },
        }),
      );
      expect(planned).toBe(1);
    }
  });

  it('race: the handover against a clearance — never done without a clearance or a code', async () => {
    for (let i = 0; i < 3; i++) {
      const s = await p.setUp(`Move Handover Race ${i}`);
      const out = asMove(await notice(s).expect(201));
      const [cleared] = await Promise.all([
        http('post', `/units/${s.home.id}/clearances`, s.alice),
        http('post', `/occupancies/${out.occupancyId}/end`, s.manager, {
          reasonCode: 'moved_out',
          reason: 'Moved away',
        }),
      ]);
      const handover = await http(
        'post',
        `/occupancies/${out.occupancyId}/handover`,
        s.manager,
        {},
      );
      const row = await moveRow(s, out.id);
      if (handover.status === 200)
        // Done without a code only with a clearance on record.
        expect([row.status, row.handoverReason, cleared.status]).toEqual([
          'done',
          null,
          201,
        ]);
      else {
        expect(codeOf(handover)).toBe('MOVE_HANDOVER_REASON_REQUIRED');
        expect(row.status).toBe('planned');
      }
    }
  });
});

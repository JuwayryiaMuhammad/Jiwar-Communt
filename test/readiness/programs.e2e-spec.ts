import { err } from '../api/request';
import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  readinessHelpers,
  type ProgramRead,
  type ReadinessSetUp,
} from '../setup/readiness';

/**
 * ADR 0067: a readiness program for a season, an event or an emergency
 * over the days the compound states; its readiness computed on read; closed
 * once; copied to a new start once, every day moved alike, an owner who may
 * no longer own an item replaced by the copier.
 */
describe('Readiness — programs', () => {
  let h: HttpHarness;
  let r: ReturnType<typeof readinessHelpers>;
  let s: ReadinessSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    r = readinessHelpers(h);
    s = await r.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  const copy = (id: string, startsOn: string, key?: string) => {
    const req = r.http(
      'post',
      `/maintenance/readiness/programs/${id}/copy`,
      s.manager.token,
      { startsOn },
    );
    return key ? req.set('Idempotency-Key', key) : req;
  };

  it('states its days: the end on or after the start, a year and a day at most; a title of spaces is no title', async () => {
    const p = await r.program(s, {
      kind: 'event',
      title: '  Eid prayers  ',
      startsOn: day(10),
      endsOn: day(12),
    });
    expect(p).toMatchObject({
      kind: 'event',
      title: 'Eid prayers',
      startsOn: day(10),
      endsOn: day(12),
      copiedFromId: null,
      closedAt: null,
      readiness: {
        items: 0,
        done: 0,
        cancelled: 0,
        open: 0,
        percent: null,
        budget: '0.00',
      },
    });
    expect(
      err(
        await r
          .newProgram(s, { startsOn: day(10), endsOn: day(9) })
          .expect(400),
      ).fields,
    ).toEqual([{ field: 'endsOn', code: 'ENDS_BEFORE_START' }]);
    expect(
      err(
        await r
          .newProgram(s, { startsOn: day(10), endsOn: day(377) })
          .expect(400),
      ).fields,
    ).toEqual([
      { field: 'endsOn', code: 'INVALID_VALUE', params: { maxDays: 366 } },
    ]);
    await r.newProgram(s, { startsOn: day(10), endsOn: day(376) }).expect(201);
    expect(
      err(await r.newProgram(s, { title: '   ' }).expect(400)).fields,
    ).toEqual([
      { field: 'title', code: 'INVALID_LENGTH', params: { min: 1, max: 120 } },
    ]);
  });

  it('its readiness is what is done over what is not called off, and its budget the estimates that still count', async () => {
    const p = await r.program(s);
    const a = await r.item(s, p.id, {
      kind: 'estimate',
      estimateAmount: '12500.5',
    });
    const b = await r.item(s, p.id, { estimateAmount: '1000' });
    const c = await r.item(s, p.id, { kind: 'estimate', estimateAmount: '99' });
    await r.item(s, p.id);
    expect(a.estimateAmount).toBe('12500.50');
    await r.done(s, a.id).expect(200);
    await r
      .http(
        'post',
        `/maintenance/readiness/items/${c.id}/cancel`,
        s.manager.token,
        {
          reasonCode: 'out_of_budget',
        },
      )
      .expect(200);
    expect((await r.getProgram(s, p.id)).readiness).toEqual({
      items: 4,
      done: 1,
      cancelled: 1,
      open: 2,
      percent: 33,
      budget: '13500.50',
    });
    await r.done(s, b.id).expect(200);
    expect((await r.getProgram(s, p.id)).readiness.percent).toBe(66);
  });

  it('ends on or after its items’ days, and changes only while open; closed once, then nothing of it changes', async () => {
    const p = await r.program(s, { startsOn: day(30), endsOn: day(59) });
    const late = await r.item(s, p.id, { dueOn: day(50) });
    const patch = (body: object) =>
      r.http(
        'patch',
        `/maintenance/readiness/programs/${p.id}`,
        s.manager.token,
        body,
      );
    expect(err(await patch({ endsOn: day(49) }).expect(400)).fields).toEqual([
      {
        field: 'endsOn',
        code: 'READINESS_ITEMS_DUE_LATER',
        params: { dueOn: day(50) },
      },
    ]);
    expect(
      (await patch({ endsOn: day(50), title: 'Summer' }).expect(200))
        .body as ProgramRead,
    ).toMatchObject({ endsOn: day(50), title: 'Summer' });
    const closed = (
      await r
        .http(
          'post',
          `/maintenance/readiness/programs/${p.id}/close`,
          s.manager.token,
        )
        .expect(200)
    ).body as ProgramRead;
    expect(closed.closedAt).not.toBeNull();
    const refusals = await Promise.all([
      patch({ title: 'Winter' }),
      r.newItem(s, p.id),
      r.done(s, late.id),
      r.http(
        'post',
        `/maintenance/readiness/programs/${p.id}/close`,
        s.manager.token,
      ),
    ]);
    for (const res of refusals) {
      expect(res.status).toBe(409);
      expect(err(res).code).toBe('READINESS_PROGRAM_CLOSED');
    }
  });

  it('is listed latest start first, by kind and whether it is open', async () => {
    const t = await r.setUp(0);
    const early = await r.program(t, {
      kind: 'emergency',
      startsOn: day(5),
      endsOn: day(6),
    });
    const late = await r.program(t, {
      kind: 'emergency',
      startsOn: day(40),
      endsOn: day(41),
    });
    await r
      .http(
        'post',
        `/maintenance/readiness/programs/${early.id}/close`,
        t.manager.token,
      )
      .expect(200);
    const list = async (q: string) =>
      (
        (
          await r
            .http(
              'get',
              `/maintenance/readiness/programs?${q}`,
              t.manager.token,
            )
            .expect(200)
        ).body as { data: ProgramRead[] }
      ).data.map((p) => p.id);
    expect(await list('kind=emergency')).toEqual([late.id, early.id]);
    expect(await list('kind=emergency&open=true')).toEqual([late.id]);
    expect(await list('kind=emergency&open=false')).toEqual([early.id]);
  });

  describe('copies', () => {
    it('moves every day by as many days as the start; its tasks, estimates and campaigns come open again, a review and what was called off do not', async () => {
      const p = await r.program(s, { startsOn: day(30), endsOn: day(59) });
      const checklist = await r.checklist(s);
      const task = await r.item(s, p.id, {
        dueOn: day(25),
        estimateAmount: '50',
      });
      await r.done(s, task.id).expect(200);
      await r.item(s, p.id, {
        kind: 'inspection_campaign',
        checklistId: checklist.id,
        dueOn: day(28),
      });
      const contractId = await r.contract(s, day(40));
      await r.item(s, p.id, {
        kind: 'contract_review',
        contractId,
        dueOn: day(35),
      });
      const off = await r.item(s, p.id);
      await r
        .http(
          'post',
          `/maintenance/readiness/items/${off.id}/cancel`,
          s.manager.token,
          {
            reasonCode: 'not_needed',
          },
        )
        .expect(200);
      const c = (await copy(p.id, day(400)).expect(201)).body as ProgramRead & {
        reassignedItemIds: string[];
      };
      expect(c).toMatchObject({
        kind: p.kind,
        title: p.title,
        startsOn: day(400),
        endsOn: day(429),
        copiedFromId: p.id,
        reassignedItemIds: [],
        readiness: { items: 2, done: 0, open: 2 },
      });
      const items = await r.itemsOf(s, c.id);
      expect(
        items.map((i) => [i.kind, i.dueOn, i.state, i.estimateAmount]),
      ).toEqual([
        ['task', day(395), 'open', '50.00'],
        ['inspection_campaign', day(398), 'open', null],
      ]);
      expect(items[0].copiedFromId).toBe(task.id);
      expect(items[1].checklistId).toBe(checklist.id);
    });

    it('gives an owner who may no longer own an item to the copier, and lists them', async () => {
      const t = await r.setUp(1);
      const p = await r.program(t);
      const kept = await r.item(t, p.id, { ownerId: t.supervisor.id });
      const gone = await r.item(t, p.id, { ownerId: t.techs[0].id });
      await r.inTenant(t.c, (tx) =>
        tx.account.update({
          where: { id: t.techs[0].id },
          data: { status: 'inactive' },
        }),
      );
      const c = (
        await r
          .http(
            'post',
            `/maintenance/readiness/programs/${p.id}/copy`,
            t.manager.token,
            {
              startsOn: day(100),
            },
          )
          .expect(201)
      ).body as { id: string; reassignedItemIds: string[] };
      const items = await r.itemsOf(t, c.id);
      const of = (from: string) => items.find((i) => i.copiedFromId === from)!;
      expect(of(kept.id).ownerId).toBe(t.supervisor.id);
      expect(of(gone.id).ownerId).toBe(t.manager.id);
      expect(c.reassignedItemIds).toEqual([of(gone.id).id]);
      // Read again, the copy lists the same.
      const again = await r.inTenant(t.c, (tx) =>
        tx.readinessItem.count({ where: { programId: c.id } }),
      );
      expect(again).toBe(2);
    });

    it('starts from today; a copy to a start is made once — the same key replays it, another key is refused', async () => {
      const p = await r.program(s);
      expect(err(await copy(p.id, day(-1)).expect(400)).fields).toEqual([
        { field: 'startsOn', code: 'INVALID_VALUE', params: { from: day(0) } },
      ]);
      const first = (await copy(p.id, day(200), 'copy-key-1').expect(201))
        .body as { id: string };
      const replay = (await copy(p.id, day(200), 'copy-key-1').expect(201))
        .body as { id: string };
      expect(replay.id).toBe(first.id);
      expect(err(await copy(p.id, day(200)).expect(409))).toMatchObject({
        code: 'DUPLICATE_RESOURCE',
      });
    });

    it('races: two copies to one start at once leave one copy', async () => {
      for (let round = 0; round < 3; round++) {
        const p = await r.program(s);
        await r.item(s, p.id);
        const results = await Promise.all([
          copy(p.id, day(300)),
          copy(p.id, day(300)),
        ]);
        expect(results.map((x) => x.status).sort()).toEqual([201, 409]);
        expect(err(results.find((x) => x.status === 409)!).code).toBe(
          'DUPLICATE_RESOURCE',
        );
        const copies = await r.inTenant(s.c, (tx) =>
          tx.readinessProgram.findMany({ where: { copiedFromId: p.id } }),
        );
        expect(copies).toHaveLength(1);
        expect(
          await r.inTenant(s.c, (tx) =>
            tx.readinessItem.count({ where: { programId: copies[0].id } }),
          ),
        ).toBe(1);
      }
    });
  });
});

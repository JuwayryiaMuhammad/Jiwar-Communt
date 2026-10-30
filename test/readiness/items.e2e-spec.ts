import { ReadinessSweep } from '../../src/maintenance/readiness/readiness-sweep';
import { err } from '../api/request';
import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  readinessHelpers,
  type ItemRead,
  type ReadinessSetUp,
} from '../setup/readiness';
import { dateColumn } from '../../src/maintenance/schedules/local-dates';

/**
 * ADR 0067: a program's items — what each kind names and nothing else, an
 * owner who is an active staff member or the manager and is told, a day
 * from today by the program's last, done or called off once; the owner
 * marks their own done; one past its day is told to its owner once.
 */
describe('Readiness — items', () => {
  let h: HttpHarness;
  let r: ReturnType<typeof readinessHelpers>;
  let s: ReadinessSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    r = readinessHelpers(h);
    s = await r.setUp(2);
  }, 90_000);

  afterAll(() => h.close());

  const notices = (accountId: string, kind: string, targetId: string) =>
    r.inTenant(s.c, (tx) =>
      tx.notification.findMany({ where: { accountId, kind, targetId } }),
    );
  const cancel = (id: string, reasonCode: string) =>
    r.http(
      'post',
      `/maintenance/readiness/items/${id}/cancel`,
      s.manager.token,
      {
        reasonCode,
      },
    );

  it('names what its kind needs and nothing it does not; an estimate is more than 0, kept to the piastre', async () => {
    const p = await r.program(s);
    const refused = async (body: object) =>
      err(await r.newItem(s, p.id, body).expect(400)).fields;
    expect(await refused({ kind: 'estimate' })).toEqual([
      { field: 'estimateAmount', code: 'FIELD_REQUIRED' },
    ]);
    expect(await refused({ kind: 'contract_review' })).toEqual([
      { field: 'contractId', code: 'FIELD_REQUIRED' },
    ]);
    expect(await refused({ kind: 'inspection_campaign' })).toEqual([
      { field: 'checklistId', code: 'FIELD_REQUIRED' },
    ]);
    expect(
      await refused({
        kind: 'task',
        contractId: '0192a5f0-1c2b-7d3e-8f40-000000006701',
        checklistId: '0192a5f0-1c2b-7d3e-8f40-000000006702',
      }),
    ).toEqual([
      { field: 'contractId', code: 'FIELD_NOT_ALLOWED' },
      { field: 'checklistId', code: 'FIELD_NOT_ALLOWED' },
    ]);
    const checklist = await r.checklist(s);
    expect(
      await refused({
        kind: 'inspection_campaign',
        checklistId: checklist.id,
        estimateAmount: '10',
      }),
    ).toEqual([{ field: 'estimateAmount', code: 'FIELD_NOT_ALLOWED' }]);
    expect(await refused({ kind: 'estimate', estimateAmount: '0.00' })).toEqual(
      [{ field: 'estimateAmount', code: 'INVALID_VALUE' }],
    );
    expect(
      await refused({
        kind: 'inspection_campaign',
        checklistId: '0192a5f0-1c2b-7d3e-8f40-000000006703',
      }),
    ).toEqual([{ field: 'checklistId', code: 'CHECKLIST_NOT_AVAILABLE' }]);
    expect(
      await r.item(s, p.id, {
        kind: 'estimate',
        estimateAmount: '9999999999.99',
      }),
    ).toMatchObject({ kind: 'estimate', estimateAmount: '9999999999.99' });
    // A task may carry an estimate, and lose it; an estimate may not.
    const task = await r.item(s, p.id, { estimateAmount: '75.5' });
    const patch = (id: string, body: object) =>
      r.http(
        'patch',
        `/maintenance/readiness/items/${id}`,
        s.manager.token,
        body,
      );
    expect(
      (
        (await patch(task.id, { estimateAmount: null }).expect(200))
          .body as ItemRead
      ).estimateAmount,
    ).toBeNull();
    const est = await r.item(s, p.id, {
      kind: 'estimate',
      estimateAmount: '5',
    });
    expect(
      err(await patch(est.id, { estimateAmount: null }).expect(400)).fields,
    ).toEqual([{ field: 'estimateAmount', code: 'FIELD_REQUIRED' }]);
  });

  it('is owned by an active staff member or the manager, who is told the day only; never a resident', async () => {
    const p = await r.program(s);
    expect(
      err(await r.newItem(s, p.id, { ownerId: s.owner.id }).expect(400)).fields,
    ).toEqual([{ field: 'ownerId', code: 'READINESS_OWNER_NOT_ELIGIBLE' }]);
    const tech = s.techs[0];
    const i = await r.item(s, p.id, { ownerId: tech.id, dueOn: day(7) });
    const told = await notices(tech.id, 'readiness_item.assigned', p.id);
    expect(told).toHaveLength(1);
    expect(told[0].params).toEqual({ dueOn: day(7) });
    expect(JSON.stringify(told[0])).not.toContain(i.title);
    // Given to another, the other is told.
    const other = s.techs[1];
    await r
      .http('patch', `/maintenance/readiness/items/${i.id}`, s.manager.token, {
        ownerId: other.id,
      })
      .expect(200);
    expect(
      await notices(other.id, 'readiness_item.assigned', p.id),
    ).toHaveLength(1);
    // The manager owning their own item is not told about it.
    await r.item(s, p.id, { ownerId: s.manager.id });
    expect(
      await notices(s.manager.id, 'readiness_item.assigned', p.id),
    ).toEqual([]);
  });

  it('is due from today, by the program’s last day', async () => {
    const p = await r.program(s, { startsOn: day(30), endsOn: day(59) });
    expect(
      err(await r.newItem(s, p.id, { dueOn: day(-1) }).expect(400)).fields,
    ).toEqual([
      { field: 'dueOn', code: 'INVALID_VALUE', params: { from: day(0) } },
    ]);
    expect(
      err(await r.newItem(s, p.id, { dueOn: day(60) }).expect(400)).fields,
    ).toEqual([
      {
        field: 'dueOn',
        code: 'READINESS_DUE_AFTER_END',
        params: { endsOn: day(59) },
      },
    ]);
    // Before the season starts is when most is prepared.
    await r.newItem(s, p.id, { dueOn: day(0) }).expect(201);
    await r.newItem(s, p.id, { dueOn: day(59) }).expect(201);
  });

  it('is done or called off once, with a reason from the list', async () => {
    const p = await r.program(s);
    const a = await r.item(s, p.id);
    expect((await r.done(s, a.id).expect(200)).body).toMatchObject({
      state: 'done',
    });
    for (const res of [
      await r.done(s, a.id),
      await cancel(a.id, 'not_needed'),
    ]) {
      expect(res.status).toBe(409);
      expect(err(res)).toMatchObject({
        code: 'READINESS_ITEM_ENDED',
        params: { state: 'done' },
      });
    }
    const b = await r.item(s, p.id);
    expect(err(await cancel(b.id, 'bored').expect(400)).fields).toEqual([
      {
        field: 'reasonCode',
        code: 'INVALID_REASON_CODE',
        params: {
          allowed: [
            'not_needed',
            'covered_elsewhere',
            'out_of_budget',
            'other',
          ],
        },
      },
    ]);
    expect(
      (await cancel(b.id, 'covered_elsewhere').expect(200)).body,
    ).toMatchObject({
      state: 'cancelled',
      cancelReason: 'covered_elsewhere',
    });
    expect(err(await r.done(s, b.id).expect(409)).params).toEqual({
      state: 'cancelled',
    });
    expect(
      err(
        await r
          .http(
            'patch',
            `/maintenance/readiness/items/${b.id}`,
            s.manager.token,
            {
              title: 'Again',
            },
          )
          .expect(409),
      ).code,
    ).toBe('READINESS_ITEM_ENDED');
    // A decision is a contract review's only; a campaign is done by its inspections.
    const c = await r.item(s, p.id);
    expect(
      err(await r.done(s, c.id, { decision: 'renew' }).expect(400)).fields,
    ).toEqual([{ field: 'decision', code: 'FIELD_NOT_ALLOWED' }]);
    const checklist = await r.checklist(s);
    const camp = await r.item(s, p.id, {
      kind: 'inspection_campaign',
      checklistId: checklist.id,
    });
    expect(err(await r.done(s, camp.id).expect(409)).code).toBe(
      'READINESS_CAMPAIGN_AUTOMATIC',
    );
  });

  it('its owner sees their own open items and marks them done; another’s is not found', async () => {
    const p = await r.program(s);
    const tech = s.techs[0];
    const mine = await r.item(s, p.id, { ownerId: tech.id });
    const theirs = await r.item(s, p.id, { ownerId: s.techs[1].id });
    const listed = (
      (await r.http('get', '/staff/readiness-items', tech.token).expect(200))
        .body as {
        data: ItemRead[];
      }
    ).data.map((i) => i.id);
    expect(listed).toContain(mine.id);
    expect(listed).not.toContain(theirs.id);
    const ownDone = (id: string) =>
      r.http('post', `/staff/readiness-items/${id}/done`, tech.token, {});
    expect(err(await ownDone(theirs.id).expect(404)).code).toBe(
      'READINESS_ITEM_NOT_FOUND',
    );
    expect((await ownDone(mine.id).expect(200)).body).toMatchObject({
      state: 'done',
    });
    expect(
      (
        (await r.http('get', '/staff/readiness-items', tech.token).expect(200))
          .body as {
          data: ItemRead[];
        }
      ).data.map((i) => i.id),
    ).not.toContain(mine.id);
    // Without readiness.manage the program's routes are forbidden.
    await r
      .http('get', `/maintenance/readiness/programs/${p.id}`, tech.token)
      .expect(403);
  });

  it('past its day, its owner is told once; not when the program is closed, and again after a later day passes', async () => {
    const sweep = () => h.moduleRef.get(ReadinessSweep).run();
    const p = await r.program(s);
    const tech = s.techs[0];
    const late = await r.item(s, p.id, { ownerId: tech.id, dueOn: day(0) });
    const shut = await r.program(s);
    const lateShut = await r.item(s, shut.id, {
      ownerId: tech.id,
      dueOn: day(0),
    });
    await r.inTenant(s.c, (tx) =>
      tx.readinessItem.updateMany({
        where: { id: { in: [late.id, lateShut.id] } },
        data: { dueOn: dateColumn(day(-1)) },
      }),
    );
    await r
      .http(
        'post',
        `/maintenance/readiness/programs/${shut.id}/close`,
        s.manager.token,
      )
      .expect(200);
    await sweep();
    await sweep();
    const told = await notices(tech.id, 'readiness_item.overdue', p.id);
    expect(told).toHaveLength(1);
    expect(told[0].params).toEqual({ dueOn: day(-1) });
    expect(await notices(tech.id, 'readiness_item.overdue', shut.id)).toEqual(
      [],
    );
    // The sweep's mark stays, but for a later day.
    await expect(
      r.inTenant(s.c, (tx) =>
        tx.readinessItem.update({
          where: { id: late.id },
          data: { overdueNotifiedAt: null },
        }),
      ),
    ).rejects.toThrow(/keeps what it names/);
    // Moved to a later day, and that day passes: told again, once.
    await r
      .http(
        'patch',
        `/maintenance/readiness/items/${late.id}`,
        s.manager.token,
        {
          dueOn: day(1),
        },
      )
      .expect(200);
    await r.inTenant(s.c, (tx) =>
      tx.readinessItem.update({
        where: { id: late.id },
        data: { dueOn: dateColumn(day(-1)) },
      }),
    );
    await sweep();
    expect(await notices(tech.id, 'readiness_item.overdue', p.id)).toHaveLength(
      2,
    );
  });

  it('races: an item done twice at once is done once', async () => {
    for (let round = 0; round < 3; round++) {
      const p = await r.program(s);
      const i = await r.item(s, p.id);
      const results = await Promise.all([r.done(s, i.id), r.done(s, i.id)]);
      expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
      expect(err(results.find((x) => x.status === 409)!).code).toBe(
        'READINESS_ITEM_ENDED',
      );
    }
  });
});

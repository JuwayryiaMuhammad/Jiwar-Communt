import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { INCIDENT_ACTION_SWEEP } from '../../src/gate/incidents/incident-action-sweep';
import { err } from '../api/request';
import { auditReaders } from '../setup/audit';
import { dbClock, dbDate, day } from '../setup/compound-clock';
import { eraseNow } from '../setup/erasure';
import { buildExports, readArchive, stepUp } from '../setup/exports';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityOpsHelpers, type Who } from '../setup/security-ops';

interface ActionBody {
  id: string;
  incidentId: string;
  description: string | null;
  owner: { id: string };
  dueOn: string;
  state: string;
  overdue: boolean;
  doneNote: string | null;
  cancelReason: string | null;
}

/**
 * ADR 0087, corrective actions: an incident's actions with an owner and a
 * day, the owner told; done by their owner (no permission) or a keeper,
 * called off by a keeper; told once when overdue; the incident not closed
 * while one is open; what the account wrote erased and exported.
 */
describe('Corrective actions (ADR 0087)', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let tech: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Corrective Court');
    tech = await x.v.who(s.c, (await x.g.guard(s.c, 'technician')).id, 'staff');
  }, 180_000);

  afterAll(() => h.close());

  const m = () => s.manager.token;
  const incident = async (as: Who = s.manager) =>
    (
      await x
        .http('post', '/staff/security/incidents', as.token, {
          type: 'hazard',
          severity: 'medium',
          unitCode: s.home.code,
          occurredAt: new Date(dbClock().getTime() - 600_000).toISOString(),
          description: 'A loose cable by the pool',
        })
        .expect(201)
    ).body as { id: string; actions: Record<string, number> };
  const addRaw = (incidentId: string, body: object, token = m()) =>
    x.http(
      'post',
      `/staff/security/incidents/${incidentId}/actions`,
      token,
      body,
    );
  const add = async (incidentId: string, over: object = {}) =>
    (
      await addRaw(incidentId, {
        description: 'Cover the cable run',
        ownerId: tech.id,
        dueOn: day(7),
        ...over,
      }).expect(201)
    ).body as ActionBody;
  const closeRaw = (incidentId: string) =>
    x.http('post', `/staff/security/incidents/${incidentId}/close`, m(), {
      reasonCode: 'resolved',
      note: 'Closed by the office',
    });

  it('added with an owner and a day: the owner told, the incident counts it', async () => {
    const i = await incident();
    expect(i.actions).toEqual({ open: 0, done: 0, cancelled: 0 });
    const a = await add(i.id);
    expect(a).toMatchObject({
      incidentId: i.id,
      owner: { id: tech.id },
      dueOn: day(7),
      state: 'open',
      overdue: false,
    });
    expect(await x.told(s.c, tech.id, i.id)).toEqual([
      { kind: 'incident_action.assigned', params: { dueOn: day(7) } },
    ]);
    const got = (
      await x.http('get', `/staff/security/incidents/${i.id}`, m()).expect(200)
    ).body as { actions: Record<string, number> };
    expect(got.actions).toEqual({ open: 1, done: 0, cancelled: 0 });
    const list = (
      await x
        .http('get', `/staff/security/incidents/${i.id}/actions`, m())
        .expect(200)
    ).body as { data: ActionBody[] };
    expect(list.data.map((d) => d.id)).toEqual([a.id]);
  });

  it('refuses an owner who is not staff, a past or far day, and a closed incident', async () => {
    const i = await incident();
    const body = { description: 'Fix it', ownerId: tech.id, dueOn: day(3) };
    expect(
      err(await addRaw(i.id, { ...body, ownerId: s.alice.id }).expect(400))
        .fields,
    ).toEqual([{ field: 'ownerId', code: 'RESPONSIBLE_NOT_ELIGIBLE' }]);
    for (const dueOn of [day(-1), day(366)])
      expect(
        err(await addRaw(i.id, { ...body, dueOn }).expect(400)).fields,
      ).toMatchObject([{ field: 'dueOn', code: 'DAY_OUT_OF_RANGE' }]);
    await closeRaw(i.id).expect(200);
    expect(err(await addRaw(i.id, body).expect(409)).code).toBe(
      'INCIDENT_CLOSED',
    );
  });

  it('the incident does not close while an action is open; done or called off, it does', async () => {
    const i = await incident();
    const first = await add(i.id);
    const second = await add(i.id, { description: 'Retrain the night shift' });
    expect(err(await closeRaw(i.id).expect(409))).toMatchObject({
      code: 'INCIDENT_ACTIONS_OPEN',
      params: { open: 2 },
    });
    // The owner marks theirs done from their own list, with no permission.
    const mine = (
      await x.http('get', '/staff/incident-actions', tech.token).expect(200)
    ).body as { data: { id: string; incident: { reference: string } }[] };
    expect(mine.data.map((d) => d.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
    expect(mine.data[0].incident.reference).toMatch(/^I-\d{4,}$/);
    const done = (
      await x
        .http('post', `/staff/incident-actions/${first.id}/done`, tech.token, {
          note: 'Covered with a trunking',
        })
        .expect(200)
    ).body as ActionBody;
    expect(done).toMatchObject({
      state: 'done',
      doneNote: 'Covered with a trunking',
    });
    expect(
      err(
        await x
          .http(
            'post',
            `/staff/incident-actions/${first.id}/done`,
            tech.token,
            {},
          )
          .expect(409),
      ),
    ).toMatchObject({
      code: 'INCIDENT_ACTION_ENDED',
      params: { state: 'done' },
    });
    expect(err(await closeRaw(i.id).expect(409)).params).toEqual({ open: 1 });
    const cancelled = (
      await x
        .http(
          'post',
          `/staff/security/incident-actions/${second.id}/cancel`,
          m(),
          { reasonCode: 'superseded' },
        )
        .expect(200)
    ).body as ActionBody;
    expect(cancelled).toMatchObject({
      state: 'cancelled',
      cancelReason: 'superseded',
    });
    await closeRaw(i.id).expect(200);
  });

  it('another’s action is not found from the owner’s list; a resident is refused it', async () => {
    const i = await incident();
    const a = await add(i.id, { ownerId: s.manager.id });
    expect(
      err(
        await x
          .http('post', `/staff/incident-actions/${a.id}/done`, tech.token, {})
          .expect(404),
      ).code,
    ).toBe('INCIDENT_ACTION_NOT_FOUND');
    await x.http('get', '/staff/incident-actions', s.alice.token).expect(403);
  });

  it('changed while open: a new owner told, a later day a new chance; ended, it changes no more', async () => {
    const i = await incident();
    const a = await add(i.id);
    const changed = (
      await x
        .http('patch', `/staff/security/incident-actions/${a.id}`, m(), {
          ownerId: s.manager.id,
          dueOn: day(9),
        })
        .expect(200)
    ).body as ActionBody;
    expect(changed).toMatchObject({
      owner: { id: s.manager.id },
      dueOn: day(9),
    });
    await x
      .http('post', `/staff/security/incident-actions/${a.id}/done`, m(), {})
      .expect(200);
    expect(
      err(
        await x
          .http('patch', `/staff/security/incident-actions/${a.id}`, m(), {
            dueOn: day(10),
          })
          .expect(409),
      ).code,
    ).toBe('INCIDENT_ACTION_ENDED');
  });

  it('overdue: its owner and the keepers told once; a later day is a new chance', async () => {
    const i = await incident();
    const a = await add(i.id);
    await x.inTx(s.c, (tx) =>
      tx.incidentAction.update({
        where: { id: a.id },
        data: { dueOn: dbDate(day(-1)) },
      }),
    );
    const sweep = () =>
      h.moduleRef.get(SweepRunner).run(INCIDENT_ACTION_SWEEP, new Date());
    await sweep();
    await sweep();
    const overdue = async (who: string) =>
      (await x.told(s.c, who, i.id)).filter(
        (n) => n.kind === 'incident_action.overdue',
      );
    expect(await overdue(tech.id)).toEqual([
      { kind: 'incident_action.overdue', params: { dueOn: day(-1) } },
    ]);
    expect(await overdue(s.manager.id)).toHaveLength(1);
    const view = (
      await x
        .http('get', `/staff/security/incidents/${i.id}/actions`, m())
        .expect(200)
    ).body as { data: ActionBody[] };
    expect(view.data[0].overdue).toBe(true);
  });

  it('audited by ids, days and codes; the words as changed only', async () => {
    const i = await incident();
    const a = await add(i.id, { description: 'Secret words 4410' });
    const read = auditReaders(h);
    const [row] = await read.tenant(s.c.tenantId, {
      action: 'incident_action.created',
      targetId: a.id,
    });
    expect(row).toMatchObject({
      metadata: { incidentId: i.id },
      changes: {
        description: { changed: true },
        ownerId: { from: null, to: tech.id },
        dueOn: { from: null, to: day(7) },
      },
    });
    expect(JSON.stringify(row)).not.toContain('Secret words 4410');
  });

  it('erased: the words it wrote go, once, audited by id; its export holds its actions with its own words', async () => {
    const keeper = await x.staff(s.c, ['incidents.manage']);
    const i = await incident();
    const made = (
      await addRaw(
        i.id,
        { description: 'Keeper words 5512', ownerId: tech.id, dueOn: day(5) },
        keeper.token,
      ).expect(201)
    ).body as ActionBody;
    const email = (
      await x.inTx(s.c, (tx) =>
        tx.account.findUniqueOrThrow({ where: { id: keeper.id } }),
      )
    ).email!;
    await stepUp(h, keeper.token, email);
    const asked = await x
      .http('post', '/me/data-exports', keeper.token, {})
      .expect(201);
    await buildExports(h);
    const dl = await x
      .http(
        'get',
        `/me/data-exports/${(asked.body as { id: string }).id}/download`,
        keeper.token,
      )
      .expect(200);
    const archive = await readArchive((dl.body as { url: string }).url);
    expect(JSON.parse(archive.text('incidents/actions.json'))).toEqual([
      expect.objectContaining({
        owner: false,
        description: 'Keeper words 5512',
        doneNote: null,
        status: 'open',
      }),
    ]);
    await x
      .http('patch', `/accounts/${keeper.id}/status`, m(), {
        status: 'inactive',
      })
      .expect(200);
    await eraseNow(h, s.c, keeper.id);
    const row = await x.inTx(s.c, (tx) =>
      tx.incidentAction.findUniqueOrThrow({ where: { id: made.id } }),
    );
    expect(row).toMatchObject({
      description: null,
      textClearedAt: expect.any(Date) as Date,
      status: 'open',
    });
    const [cleared] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'incident_action.text_cleared',
      targetId: made.id,
    });
    expect(cleared.metadata).toEqual({
      incidentId: i.id,
      description: true,
      doneNote: false,
    });
  });
});

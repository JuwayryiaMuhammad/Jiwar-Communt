import { randomUUID } from 'node:crypto';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { at, day, permitHelpers, type PermitBody } from '../setup/permits';

describe('Permits — works by a contractor (ADR 0049)', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  const fields = (res: { body: unknown }) =>
    (res.body as { fields?: unknown }).fields;

  it('the primary asks: pending, numbered W-, the period at the compound’s midnights; the management is told, nobody else', async () => {
    const c = await p.setUp('Works Ask Court');
    const res = p.status(await p.worksRaw(c.alice, c.home.id), 201);
    expect(res.headers['cache-control']).toBe('no-store');
    const permit = res.body as PermitBody;
    expect(permit).toMatchObject({
      reference: expect.stringMatching(/^W-\d{4,}$/) as string,
      kind: 'works',
      status: 'pending',
      unitId: c.home.id,
      mine: true,
      decisionSource: null,
      move: null,
      materialExit: null,
      event: null,
      works: {
        workType: 'renovation',
        startsOn: day(1),
        endsOn: day(7),
        dailyHours: { from: '09:00', to: '17:00' },
        contractorCompany: 'Nile Builders',
        description: 'New kitchen tiles',
        workerCount: 0,
        workers: [],
      },
    });
    expect(new Date(permit.startsAt)).toEqual(at(day(1), 0));
    expect(new Date(permit.endsAt)).toEqual(at(day(8), 0));
    expect(await p.told(c.c, c.manager.id, permit.id)).toEqual([
      { kind: 'unit_permit.requested', params: { permitKind: 'works' } },
    ]);
    expect(await p.told(c.c, c.alice.id, permit.id)).toEqual([]);
  });

  it('only the primary asks: a member and a landlord are refused, another unit is not found', async () => {
    const c = await p.setUp('Works Who Court');
    const member = await p.family(c.c, c.home.id, c.alice);
    const rented = await p.unit(c.c, 'P2');
    const landlord = await p.landlord(c.c, rented.id);
    expect(
      p.status(await p.worksRaw(member, c.home.id), 403).body,
    ).toMatchObject({ code: 'PERMIT_NOT_ALLOWED' });
    // A landlord never lives there: never its primary.
    expect(
      p.status(await p.worksRaw(landlord, rented.id), 403).body,
    ).toMatchObject({ code: 'PERMIT_NOT_ALLOWED' });
    expect(
      p.status(await p.worksRaw(c.alice, rented.id), 404).body,
    ).toMatchObject({ code: 'UNIT_NOT_FOUND' });
  });

  it('the period and the hours fit the compound’s rules', async () => {
    const c = await p.setUp('Works Rules Court');
    const bad = async (over: Record<string, unknown>) =>
      fields(p.status(await p.worksRaw(c.alice, c.home.id, over), 400));
    expect(await bad({ startsOn: day(-1), endsOn: day(2) })).toEqual([
      {
        field: 'startsOn',
        code: 'DAY_OUT_OF_RANGE',
        params: { min: day(0), max: day(90) },
      },
    ]);
    expect(await bad({ startsOn: day(91), endsOn: day(92) })).toEqual([
      {
        field: 'startsOn',
        code: 'DAY_OUT_OF_RANGE',
        params: { min: day(0), max: day(90) },
      },
    ]);
    expect(await bad({ startsOn: day(5), endsOn: day(4) })).toEqual([
      { field: 'endsOn', code: 'ENDS_BEFORE_START' },
    ]);
    expect(await bad({ startsOn: day(1), endsOn: day(181) })).toEqual([
      { field: 'endsOn', code: 'PERIOD_TOO_LONG', params: { maxDays: 180 } },
    ]);
    expect(await bad({ dailyHours: { from: '08:00', to: '12:00' } })).toEqual([
      {
        field: 'dailyHours',
        code: 'OUTSIDE_WORK_HOURS',
        params: { from: '09:00', to: '17:00' },
      },
    ]);
    expect(await bad({ dailyHours: { from: '12:00', to: '11:00' } })).toEqual([
      { field: 'dailyHours.to', code: 'ENDS_BEFORE_START' },
    ]);
    // A period of days off only.
    await p.setRules(c.manager, { daysOff: [day(3), day(4)] });
    expect(await bad({ startsOn: day(3), endsOn: day(4) })).toEqual([
      { field: 'endsOn', code: 'NOT_A_WORK_DAY' },
    ]);
    expect(
      await bad({ workType: 'demolition', contractorCompany: '' }),
    ).toEqual(
      expect.arrayContaining([
        {
          field: 'workType',
          code: 'INVALID_VALUE',
          params: { allowed: ['renovation', 'finishing'] },
        },
        {
          field: 'contractorCompany',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 120 },
        },
      ]),
    );
  });

  it('three live works permits per unit; a cancelled one frees its place', async () => {
    const c = await p.setUp('Works Limit Court');
    const made: PermitBody[] = [];
    for (let i = 0; i < 3; i += 1) made.push(await p.works(c.alice, c.home.id));
    expect(
      p.status(await p.worksRaw(c.alice, c.home.id), 409).body,
    ).toMatchObject({
      code: 'PERMIT_LIMIT_REACHED',
      params: { scope: 'works', max: 3 },
    });
    await p
      .http('post', `/permits/${made[0].id}/cancel`, c.alice.token, {})
      .expect(200);
    p.status(await p.worksRaw(c.alice, c.home.id), 201);
  });

  it('a retry with the same Idempotency-Key replays: one permit', async () => {
    const c = await p.setUp('Works Retry Court');
    const key = randomUUID();
    const first = p.status(
      await p.worksRaw(c.alice, c.home.id, {}, { 'Idempotency-Key': key }),
      201,
    );
    const again = p.status(
      await p.worksRaw(c.alice, c.home.id, {}, { 'Idempotency-Key': key }),
      201,
    );
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect((again.body as PermitBody).id).toBe((first.body as PermitBody).id);
    expect(
      await p.v.inTx(c.c, (tx) =>
        tx.unitPermit.count({ where: { unitId: c.home.id } }),
      ),
    ).toBe(1);
  });

  it('the unit’s list: every permit for its primary, one’s own for anyone else; a stranger finds no unit', async () => {
    const c = await p.setUp('Works List Court');
    const permit = await p.works(c.alice, c.home.id);
    const member = await p.family(c.c, c.home.id, c.alice);
    const list = async (who: { token: string }) =>
      (
        (
          await p
            .http('get', `/units/${c.home.id}/permits`, who.token)
            .expect(200)
        ).body as { data: PermitBody[] }
      ).data;
    expect((await list(c.alice)).map((x) => x.id)).toEqual([permit.id]);
    expect(await list(member)).toEqual([]);
    const other = await p.setUp('Works Stranger Court');
    expect(
      (
        await p
          .http('get', `/units/${c.home.id}/permits`, other.alice.token)
          .expect(404)
      ).body,
    ).toMatchObject({ code: 'UNIT_NOT_FOUND' });
    // The member does not see the primary's permit by its id either.
    expect(
      (await p.http('get', `/permits/${permit.id}`, member.token).expect(404))
        .body,
    ).toMatchObject({ code: 'PERMIT_NOT_FOUND' });
    // Filters.
    const filtered = (
      (
        await p
          .http(
            'get',
            `/units/${c.home.id}/permits?kind=works&status=pending`,
            c.alice.token,
          )
          .expect(200)
      ).body as { data: PermitBody[] }
    ).data;
    expect(filtered.map((x) => x.id)).toEqual([permit.id]);
  });

  it('the requester cancels, with a reason or none; over is over', async () => {
    const c = await p.setUp('Works Cancel Court');
    const permit = await p.works(c.alice, c.home.id);
    expect(
      fields(
        await p
          .http('post', `/permits/${permit.id}/cancel`, c.alice.token, {
            reasonCode: 'bored',
          })
          .expect(400),
      ),
    ).toEqual([
      {
        field: 'reasonCode',
        code: 'INVALID_REASON_CODE',
        params: {
          allowed: [
            'plans_changed',
            'dates_changed',
            'contractor_changed',
            'other',
          ],
        },
      },
    ]);
    const done = (
      await p
        .http('post', `/permits/${permit.id}/cancel`, c.alice.token, {
          reasonCode: 'dates_changed',
        })
        .expect(200)
    ).body as PermitBody;
    expect(done).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'requester',
      cancelReason: 'dates_changed',
    });
    expect(
      (
        await p
          .http('post', `/permits/${permit.id}/cancel`, c.alice.token, {})
          .expect(409)
      ).body,
    ).toMatchObject({
      code: 'PERMIT_NOT_ACTIVE',
      params: { status: 'cancelled' },
    });
    const other = await p.works(c.alice, c.home.id);
    await p
      .http('post', `/permits/${other.id}/cancel`, c.alice.token, {})
      .expect(200);
  });
});

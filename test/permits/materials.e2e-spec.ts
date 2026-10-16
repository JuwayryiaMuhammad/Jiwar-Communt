import { randomUUID } from 'node:crypto';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { day, permitHelpers, type PermitBody } from '../setup/permits';

describe('Permits — materials in and out (ADR 0049)', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  async function court(name: string) {
    const c = await p.setUp(name);
    const guard = await p.guardOnDuty(c.c);
    return { ...c, guard };
  }
  const reason = (res: { body: unknown }) =>
    (res.body as { params?: { reason?: string } }).params?.reason;

  it('a material exit approved in advance goes out once, at any gate; the requester is told', async () => {
    const c = await court('Materials Out Court');
    const exit = await p.exit(c.alice, c.home.id, {
      validFrom: day(0),
      validUntil: day(1),
    });
    const use = (token = c.guard.token) =>
      p.http('post', `/gate/unit-permits/${exit.id}/use`, token, {});
    expect(reason(await use().expect(409))).toBe('not_approved');
    await p.approve(c.manager, exit.id);
    const done = await use().expect(200);
    expect(done.headers['cache-control']).toBe('no-store');
    expect(done.body).toMatchObject({
      status: 'used',
      materialExit: {
        items: [
          { name: 'Old tiles', quantity: 20 },
          { name: 'Cement bags', quantity: 4 },
        ],
        usedAt: expect.any(String) as string,
      },
    });
    const other = await p.guardOnDuty(c.c);
    expect(reason(await use(other.token).expect(409))).toBe('used');
    const row = await p.row(c.c, exit.id);
    expect(row).toMatchObject({
      status: 'used',
      usedById: c.guard.id,
      usedGateId: c.guard.gateId,
    });
    expect(await p.told(c.c, c.alice.id, exit.id)).toEqual([
      { kind: 'unit_permit.approved', params: { permitKind: 'material_exit' } },
      { kind: 'unit_permit.used', params: { permitKind: 'material_exit' } },
    ]);
    // Used is over: no cancel, no revoke.
    await p
      .http('post', `/permits/${exit.id}/cancel`, c.alice.token, {})
      .expect(409);
    await p
      .decide(c.manager, exit.id, 'revoke', { reasonCode: 'other' })
      .expect(409);
  });

  it('not before its first day; only a material exit is used', async () => {
    const c = await court('Materials Early Court');
    const exit = await p.exit(c.alice, c.home.id);
    await p.approve(c.manager, exit.id);
    expect(
      reason(
        await p
          .http('post', `/gate/unit-permits/${exit.id}/use`, c.guard.token, {})
          .expect(409),
      ),
    ).toBe('not_yet_valid');
    const works = await p.works(c.alice, c.home.id);
    await p
      .http('post', `/gate/unit-permits/${works.id}/use`, c.guard.token, {})
      .expect(404);
  });

  it('materials in: logged by the guard, for a unit and its works permit; read by the management', async () => {
    const c = await court('Materials In Court');
    const works: PermitBody = await p.works(c.alice, c.home.id);
    const key = randomUUID();
    const log = (body: Record<string, unknown>, headers = {}) =>
      p.http('post', '/gate/material-entries', c.guard.token, body, headers);
    const body = {
      unitCode: c.home.code,
      permitId: works.id,
      description: '  20 bags   of cement ',
    };
    const first = await log(body, { 'Idempotency-Key': key }).expect(201);
    expect(first.body).toMatchObject({
      unitCode: c.home.code,
      permitReference: works.reference,
      description: '20 bags of cement',
      guard: { id: c.guard.id },
    });
    // The same request again: the same answer, one entry.
    const again = await log(body, { 'Idempotency-Key': key }).expect(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    await log({ unitCode: c.home.code, description: 'Paint' }).expect(201);
    const other = await p.unit(c.c, 'P9');
    expect(
      (
        await log({
          unitCode: other.code,
          permitId: works.id,
          description: 'Wrong unit',
        }).expect(404)
      ).body,
    ).toMatchObject({ code: 'PERMIT_NOT_FOUND' });
    expect(
      (await log({ unitCode: 'NO-SUCH-UNIT', description: 'x' }).expect(404))
        .body,
    ).toMatchObject({ code: 'UNIT_NOT_FOUND' });
    const list = (
      (
        await p
          .http(
            'get',
            `/staff/material-entries?unitId=${c.home.id}`,
            c.manager.token,
          )
          .expect(200)
      ).body as { data: { description: string }[] }
    ).data;
    expect(list.map((e) => e.description)).toEqual([
      'Paint',
      '20 bags of cement',
    ]);
    // A guard off duty logs nothing.
    await p.http('post', '/gate/shifts/end', c.guard.token, {}).expect(200);
    expect(
      (await log({ unitCode: c.home.code, description: 'x' }).expect(403)).body,
    ).toMatchObject({ code: 'NO_OPEN_SHIFT' });
  });
});

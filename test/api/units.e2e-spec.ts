import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { uniqueSuffix } from '../setup/fixtures';
import { gateHelpers } from '../setup/gate';
import { keyPaths, listKeys } from './keys';
import { call, err } from './request';
import { buildWorld, type World } from './world';

const UNIT = ['building', 'code', 'createdAt', 'floor', 'id'];
const DETAIL = [...UNIT, 'areaSqm', 'closed', 'unitType'].sort();
const OCCUPANCY = [
  'endReason',
  'endedAt',
  'handedOverAt',
  'id',
  'isPrimary',
  'occupancyType',
  'resides',
  'startedAt',
  'status',
  'unitCode',
  'unitId',
];

describe('API v0 — units & occupancies', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  const manager = () => w.a.tokens.manager;
  const newUnit = async () =>
    (
      await call(w, 'POST', '/units', {
        token: manager(),
        body: { code: `U-${uniqueSuffix()}`, building: 'B2', floor: 3 },
      }).expect(201)
    ).body as { id: string };

  it('creates and lists units, newest first, a page at a time', async () => {
    const created = await call(w, 'POST', '/units', {
      token: manager(),
      body: { code: `U-${uniqueSuffix()}` },
    }).expect(201);
    expect(keyPaths(created.body)).toEqual(UNIT);
    const second = await newUnit();

    const page = await call(w, 'GET', '/units', {
      token: manager(),
      query: { limit: '1' },
    }).expect(200);
    expect(keyPaths(page.body)).toEqual(listKeys(UNIT));
    const first = page.body as { data: { id: string }[]; nextCursor: string };
    expect(first.data.map((u) => u.id)).toEqual([second.id]);
    const next = await call(w, 'GET', '/units', {
      token: manager(),
      query: { limit: '1', cursor: first.nextCursor },
    }).expect(200);
    expect(
      (next.body as { data: { id: string }[] }).data.map((u) => u.id),
    ).toEqual([(created.body as { id: string }).id]);

    // A resident sees only their own units.
    const mine = await call(w, 'GET', '/units', {
      token: w.a.tokens.owner,
    }).expect(200);
    expect(
      (mine.body as { data: { id: string }[] }).data.map((u) => u.id),
    ).toEqual([w.a.homeUnitId]);
  });

  it('the security supervisor lists every unit (units.directory), opens none, and stops with the permission; a guard lists none', async () => {
    const unit = await newUnit();
    const supervisor = await w.tokenFor(
      w.a,
      (await gateHelpers(h).guard(w.a, 'security_supervisor')).id,
      'staff',
    );
    const ids = async (token: string) => {
      const res = await call(w, 'GET', '/units', {
        token,
        query: { limit: '100' },
      }).expect(200);
      expect(keyPaths(res.body)).toEqual(listKeys(UNIT));
      return (res.body as { data: { id: string }[] }).data.map((u) => u.id);
    };

    // The compound's units as the manager lists them, B's never.
    const listed = await ids(supervisor);
    expect(listed).toEqual(await ids(manager()));
    expect(listed).toEqual(
      expect.arrayContaining([unit.id, w.a.homeUnitId, w.a.rentedUnitId]),
    );
    expect(listed).not.toContain(w.b.homeUnitId);

    // The list only: a unit's own routes stay units.read's.
    for (const path of [`/units/${unit.id}`, `/units/${unit.id}/household`]) {
      const res = await call(w, 'GET', path, { token: supervisor });
      expect({ status: res.status, code: err(res).code }).toEqual({
        status: 403,
        code: 'FORBIDDEN',
      });
    }
    const guard = await call(w, 'GET', '/units', { token: w.a.tokens.guard });
    expect({ status: guard.status, code: err(guard).code }).toEqual({
      status: 403,
      code: 'FORBIDDEN',
    });

    // Taken from the role, the list stops on the next request.
    const roles = await call(w, 'GET', '/roles', { token: manager() }).expect(
      200,
    );
    const role = (
      roles.body as {
        data: { id: string; key: string; permissions: string[] }[];
      }
    ).data.find((r) => r.key === 'security_supervisor')!;
    const held = role.permissions;
    expect(held).toContain('units.directory');
    await call(w, 'PUT', `/roles/${role.id}/permissions`, {
      token: manager(),
      body: { permissions: held.filter((p) => p !== 'units.directory') },
    }).expect(200);
    const after = await call(w, 'GET', '/units', { token: supervisor });
    expect({ status: after.status, code: err(after).code }).toEqual({
      status: 403,
      code: 'FORBIDDEN',
    });
    await call(w, 'PUT', `/roles/${role.id}/permissions`, {
      token: manager(),
      body: { permissions: held },
    }).expect(200);
  });

  it('a unit in detail: occupants for managers only', async () => {
    const asManager = await call(w, 'GET', `/units/${w.a.homeUnitId}`, {
      token: manager(),
    }).expect(200);
    expect(keyPaths(asManager.body)).toEqual(
      [
        ...DETAIL,
        'occupants',
        'occupants[].account',
        'occupants[].account.fullName',
        'occupants[].account.id',
        'occupants[].isPrimary',
        'occupants[].occupancyId',
        'occupants[].occupancyType',
        'occupants[].resides',
        'occupants[].startedAt',
        'reviewFlags',
        'reviewReasons',
      ].sort(),
    );
    const asOwner = await call(w, 'GET', `/units/${w.a.homeUnitId}`, {
      token: w.a.tokens.owner,
    }).expect(200);
    expect(keyPaths(asOwner.body)).toEqual(DETAIL);
    // Same compound, not their unit: not found.
    await call(w, 'GET', `/units/${w.a.homeUnitId}`, {
      token: w.a.tokens.tenant,
    }).expect(404);
  });

  it('units needing review, without the notes', async () => {
    const unit = await newUnit();
    const r = await w.helpers.resident(w.a, [unit.id]);
    await w.helpers.asManager(w.a, () =>
      w.helpers.residents.tagSeparation(unit.id, {
        code: 'separation',
        text: 'A private note',
      }),
    );
    const res = await call(w, 'GET', '/units/needing-review', {
      token: manager(),
    }).expect(200);
    expect(keyPaths(res.body)).toEqual(
      listKeys([
        'activeOccupants',
        'code',
        'flagId',
        'flaggedAt',
        'reason',
        'unitId',
      ]),
    );
    expect(JSON.stringify(res.body)).not.toContain('A private note');
    expect(r.id).toBeTruthy();

    // The unit's own page names the open flag: what a clear takes (ADR 0021).
    const flag = (
      res.body as { data: { unitId: string; flagId: string }[] }
    ).data.find((u) => u.unitId === unit.id)!;
    const detail = () =>
      call(w, 'GET', `/units/${unit.id}`, { token: manager() }).expect(200);
    const flagged = await detail();
    expect(flagged.body).toMatchObject({
      reviewReasons: ['separation'],
      reviewFlags: [{ id: flag.flagId, reason: 'separation' }],
    });
    expect(
      Object.keys(
        (flagged.body as { reviewFlags: object[] }).reviewFlags[0],
      ).sort(),
    ).toEqual(['flaggedAt', 'id', 'reason']);
    expect(JSON.stringify(flagged.body)).not.toContain('A private note');
    // Never to the residents, not even the unit's own.
    const asResident = await call(w, 'GET', `/units/${unit.id}`, {
      token: await w.tokenFor(w.a, r.id, 'resident'),
    }).expect(200);
    expect(asResident.body).not.toHaveProperty('reviewFlags');

    await call(w, 'POST', `/review-flags/${flag.flagId}/clear`, {
      token: manager(),
      body: { reasonCode: 'resolved' },
    }).expect(204);
    expect((await detail()).body).toMatchObject({
      reviewReasons: [],
      reviewFlags: [],
    });
  });

  it('the primary: set by the manager; closed mode, activation and details by the primary', async () => {
    const unit = await newUnit();
    const first = await w.helpers.resident(w.a, [unit.id]);
    const second = await w.helpers.resident(w.a, [unit.id]);
    const primary = await call(w, 'POST', `/units/${unit.id}/primary`, {
      token: manager(),
      body: { accountId: second.id },
    }).expect(200);
    expect(keyPaths(primary.body)).toEqual(OCCUPANCY);
    expect(primary.body).toMatchObject({ isPrimary: true });
    expect(first.id).toBeTruthy();

    const token = await w.tokenFor(w.a, second.id, 'resident');
    await call(w, 'POST', `/units/${unit.id}/closed-mode`, {
      token,
      body: { closed: true },
    }).expect(204);
    const detail = await call(w, 'GET', `/units/${unit.id}`, { token }).expect(
      200,
    );
    expect(detail.body).toMatchObject({ closed: true });

    const activation = await call(w, 'GET', `/units/${unit.id}/activation`, {
      token,
    }).expect(200);
    expect(activation.body).toEqual({ missing: ['unitType', 'areaSqm'] });
    await call(w, 'POST', `/units/${unit.id}/details`, {
      token,
      body: { step: 'areaSqm', value: '120.5' },
    }).expect(204);
    const again = await call(w, 'GET', `/units/${unit.id}/activation`, {
      token,
    }).expect(200);
    expect(again.body).toEqual({ missing: ['unitType'] });
  });

  it('occupancies: end, convert, residence, handover', async () => {
    const unit = await newUnit();
    await w.helpers.resident(w.a, [unit.id]);
    const tenant = await w.helpers.resident(w.a, [unit.id], 'tenant');
    const occupancyOf = async (accountId: string) =>
      (await w.helpers.occupancies(w.a, unit.id)).find(
        (o) => o.accountId === accountId && o.status === 'active',
      )!.id;

    const converted = await call(
      w,
      'POST',
      `/occupancies/${await occupancyOf(tenant.id)}/convert-to-owner`,
      { token: manager(), body: {} },
    ).expect(200);
    expect(keyPaths(converted.body)).toEqual(OCCUPANCY);
    expect(converted.body).toMatchObject({
      occupancyType: 'owner',
      resides: true,
    });
    const ownerNow = (converted.body as { id: string }).id;

    const landlord = await call(
      w,
      'POST',
      `/occupancies/${ownerNow}/residence`,
      {
        token: manager(),
        body: { resides: false },
      },
    ).expect(200);
    expect(landlord.body).toMatchObject({ resides: false });

    const ended = await call(w, 'POST', `/occupancies/${ownerNow}/end`, {
      token: manager(),
      body: { reasonCode: 'moved_out', reason: 'Sold the flat' },
    }).expect(200);
    expect(keyPaths(ended.body)).toEqual(OCCUPANCY);
    expect(ended.body).toMatchObject({
      status: 'ended',
      endReason: 'moved_out',
    });
    expect(JSON.stringify(ended.body)).not.toContain('Sold the flat');

    const handed = await call(w, 'POST', `/occupancies/${ownerNow}/handover`, {
      token: manager(),
    }).expect(200);
    expect(handed.body).toMatchObject({
      handedOverAt: expect.any(String) as string,
    });

    const missing = await call(w, 'POST', `/occupancies/${ownerNow}/end`, {
      token: manager(),
      body: {},
    });
    expect(missing.body).toMatchObject({ code: 'REASON_REQUIRED' });
  });
});

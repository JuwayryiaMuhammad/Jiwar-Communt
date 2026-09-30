import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { uniqueSuffix } from '../setup/fixtures';
import { keyPaths, listKeys } from './keys';
import { call } from './request';
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

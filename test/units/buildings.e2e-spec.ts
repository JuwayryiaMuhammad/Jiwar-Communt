import { err } from '../api/request';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { unitsHelpers, type Who } from '../setup/units';
import type { Compound } from '../setup/community';

/**
 * ADR 0072: the compound's buildings. A unit carries its building's name
 * and id, kept in step by a trigger whichever one a write sets; a building
 * is added ahead of its units or by the first unit that names it, never
 * renamed, and deleted only when no unit names it. The manager edits a
 * unit's building, floor, type and area, never its code.
 */
describe('Unit register — buildings and the unit edit', () => {
  let h: HttpHarness;
  let u: ReturnType<typeof unitsHelpers>;
  let c: Compound;
  let manager: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    u = unitsHelpers(h);
    ({ c, manager } = await u.setUp());
  }, 90_000);

  afterAll(() => h.close());

  it('a unit created with a new name brings its building; the next one of that name shares it', async () => {
    const name = `North ${uniqueSuffix()}`;
    const first = await u.newUnit(manager, { building: name, floor: 2 });
    expect(first.building).toBe(name);
    expect(first.buildingId).toEqual(expect.any(String));
    const second = await u.newUnit(manager, { building: name });
    expect(second.buildingId).toBe(first.buildingId);
    const listed = (await u.buildings(manager)).find((b) => b.name === name);
    expect(listed).toMatchObject({ id: first.buildingId, units: 2 });
    // By id: the name follows.
    const third = await u.newUnit(manager, { buildingId: first.buildingId });
    expect(third.building).toBe(name);
    // Not both.
    const both = await u
      .http('post', '/units', manager.token, {
        code: `U-${uniqueSuffix()}`,
        building: name,
        buildingId: first.buildingId,
      })
      .expect(400);
    expect(err(both).fields).toEqual([
      { field: 'buildingId', code: 'FIELD_NOT_ALLOWED' },
    ]);
  });

  it('a unit written by its text alone (the activation, a seed) gets the id too', async () => {
    const name = `Text ${uniqueSuffix()}`;
    const unit = await u.x.unit(c);
    await u.x.asManager(c, () =>
      u.x.prisma.tenant.unit.update({
        where: { id: unit.id },
        data: { building: `  ${name}  ` },
      }),
    );
    const stored = await u.row(c, unit.id);
    expect(stored.building).toBe(name);
    expect(stored.buildingId).toBe(
      (await u.buildings(manager)).find((b) => b.name === name)?.id,
    );
    // Blank text: no building at all.
    await u.x.asManager(c, () =>
      u.x.prisma.tenant.unit.update({
        where: { id: unit.id },
        data: { building: '   ' },
      }),
    );
    expect(await u.row(c, unit.id)).toMatchObject({
      building: null,
      buildingId: null,
    });
  });

  it('the manager moves a unit, sets its floor, type and area, clears them, and each change is audited; the code never changes', async () => {
    const from = await u.building(manager, `From ${uniqueSuffix()}`);
    const to = await u.building(manager, `To ${uniqueSuffix()}`);
    const unit = await u.newUnit(manager, { buildingId: from.id, floor: 1 });
    const moved = await u
      .edit(manager, unit.id, {
        buildingId: to.id,
        floor: 3,
        unitType: 'apartment',
        areaSqm: '120.5',
      })
      .expect(200);
    expect(moved.body).toMatchObject({
      id: unit.id,
      code: unit.code,
      building: to.name,
      buildingId: to.id,
      floor: 3,
      unitType: 'apartment',
      areaSqm: '120.50',
      closed: false,
    });
    expect(moved.body).not.toHaveProperty('occupants');
    const cleared = await u
      .edit(manager, unit.id, {
        buildingId: null,
        floor: null,
        unitType: null,
        areaSqm: null,
      })
      .expect(200);
    expect(cleared.body).toMatchObject({
      building: null,
      buildingId: null,
      floor: null,
      unitType: null,
      areaSqm: null,
    });
    const code = await u.edit(manager, unit.id, { code: 'NEW-1' }).expect(400);
    expect(err(code).fields).toEqual([
      { field: 'code', code: 'FIELD_NOT_ALLOWED' },
    ]);
    const zero = await u.edit(manager, unit.id, { areaSqm: '0' }).expect(400);
    expect(err(zero).fields).toEqual([
      { field: 'areaSqm', code: 'INVALID_NUMBER' },
    ]);
    // Nothing changed: nothing audited.
    await u.edit(manager, unit.id, {}).expect(200);
    const audits = await u.audits.tenant(c.tenantId, {
      action: 'unit.updated',
      targetId: unit.id,
    });
    expect(audits.map((a) => a.changes)).toEqual([
      {
        building: { from: from.name, to: to.name },
        floor: { from: 1, to: 3 },
        unitType: { from: null, to: 'apartment' },
        areaSqm: { from: null, to: '120.50' },
      },
      {
        building: { from: to.name, to: null },
        floor: { from: 3, to: null },
        unitType: { from: 'apartment', to: null },
        areaSqm: { from: '120.50', to: null },
      },
    ]);
  });

  it('a building of another compound, or none, is BUILDING_NOT_FOUND; a resident may not edit', async () => {
    const other = await u.setUp('Other Court');
    const theirs = await u.building(other.manager, `Theirs ${uniqueSuffix()}`);
    const unit = await u.newUnit(manager);
    expect(
      err(await u.edit(manager, unit.id, { buildingId: theirs.id }).expect(404))
        .code,
    ).toBe('BUILDING_NOT_FOUND');
    expect(
      err(
        await u
          .http('post', '/units', manager.token, {
            code: `U-${uniqueSuffix()}`,
            buildingId: theirs.id,
          })
          .expect(404),
      ).code,
    ).toBe('BUILDING_NOT_FOUND');
    const owner = await u.who(
      c,
      (await u.x.resident(c, [unit.id])).id,
      'resident',
    );
    await u.edit(owner, unit.id, { floor: 2 }).expect(403);
  });

  it('a name is taken once; a building no unit names is deleted, one a unit names is not', async () => {
    const name = `Twice ${uniqueSuffix()}`;
    const b = await u.building(manager, name);
    expect(b).toMatchObject({ name, units: 0 });
    expect(
      err(
        await u
          .http('post', '/buildings', manager.token, { name: ` ${name} ` })
          .expect(409),
      ).code,
    ).toBe('BUILDING_NAME_TAKEN');
    const unit = await u.newUnit(manager, { buildingId: b.id });
    const inUse = await u
      .http('delete', `/buildings/${b.id}`, manager.token)
      .expect(409);
    expect(err(inUse)).toMatchObject({
      code: 'BUILDING_IN_USE',
      params: { units: 1 },
    });
    await u.edit(manager, unit.id, { buildingId: null }).expect(200);
    await u.http('delete', `/buildings/${b.id}`, manager.token).expect(204);
    await u.http('delete', `/buildings/${b.id}`, manager.token).expect(404);
    // The name is free again.
    await u.building(manager, name);
  });

  it('the security supervisor lists the buildings (units.directory) and changes none; a resident lists none', async () => {
    const supervisor = await u.who(
      c,
      (await u.g.guard(c, 'security_supervisor')).id,
      'staff',
    );
    await u.http('get', '/buildings', supervisor.token).expect(200);
    await u
      .http('post', '/buildings', supervisor.token, { name: 'Nope' })
      .expect(403);
    const unit = await u.newUnit(manager);
    const owner = await u.who(
      c,
      (await u.x.resident(c, [unit.id])).id,
      'resident',
    );
    await u.http('get', '/buildings', owner.token).expect(403);
  });

  describe('races', () => {
    it.each([1, 2, 3])(
      'deleting a building while a unit moves into it: the unit is in it and the delete refused, or the building is gone and the move refused (%i)',
      async () => {
        const b = await u.building(manager, `Race ${uniqueSuffix()}`);
        const unit = await u.newUnit(manager);
        const [move, remove] = await Promise.all([
          u.edit(manager, unit.id, { buildingId: b.id }),
          u.http('delete', `/buildings/${b.id}`, manager.token),
        ]);
        const stored = await u.row(c, unit.id);
        if (move.status === 200) {
          expect(remove.status).toBe(409);
          expect(stored).toMatchObject({ buildingId: b.id, building: b.name });
        } else {
          expect([move.status, err(move).code]).toEqual([
            404,
            'BUILDING_NOT_FOUND',
          ]);
          expect(remove.status).toBe(204);
          expect(stored).toMatchObject({ buildingId: null, building: null });
        }
      },
    );

    it.each([1, 2, 3])(
      'two units naming one new building at once share one building (%i)',
      async () => {
        const name = `Same ${uniqueSuffix()}`;
        const [one, two] = await Promise.all([
          u.newUnit(manager, { building: name }),
          u.newUnit(manager, { building: name }),
        ]);
        expect(one.buildingId).toBe(two.buildingId);
        expect(
          (await u.buildings(manager)).filter((b) => b.name === name),
        ).toHaveLength(1);
      },
    );
  });
});

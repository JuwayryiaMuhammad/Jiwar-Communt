import { RolesService } from '../../src/core/access/roles.service';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import { HouseholdsService } from '../../src/community/households/households.service';
import { MemberPermissionsService } from '../../src/community/households/member-permissions.service';
import { dispatchHelpers } from '../setup/dispatch';
import { bornYearsAgo, nationalIdFor } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type Helpers = ReturnType<typeof dispatchHelpers>;
type SetUp = Awaited<ReturnType<Helpers['setUp']>>;

interface Reporter {
  id: string;
  fullName: string | null;
}

/**
 * ADR 0032 (B2 update): whom dispatch may open a ticket for in a unit. The
 * list and `REPORTER_NOT_ELIGIBLE` are one rule: everyone listed is
 * accepted as `reporterAccountId` there, and nobody else is.
 */
describe('Maintenance — who a ticket may be opened for in a unit', () => {
  let h: HttpHarness;
  let d: Helpers;
  let s: SetUp;
  /** The owner's home: the owner, a spouse, a relative without `tickets`, a child. */
  const home = {} as {
    spouse: { id: string; fullName: string };
    relative: { id: string };
  };
  /** A rented unit: a landlord who lives elsewhere, and the tenant. */
  const rented = {} as { unitId: string; landlord: string; tenant: string };

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
    const owner = { id: s.owner.id };
    const asOwner = <T>(fn: () => Promise<T>) =>
      d.x.as(s.c, { id: owner.id, type: 'resident' }, fn);

    const spouse = await d.x.joinFamily(s.c, s.unit.id, owner);
    home.spouse = { id: spouse.id, fullName: spouse.fullName };
    const relative = await d.x.joinFamily(s.c, s.unit.id, owner, {
      relation: 'sibling',
    });
    home.relative = { id: relative.id };
    await asOwner(() =>
      h.moduleRef
        .get(MemberPermissionsService)
        .revoke(relative.memberId, 'tickets', {
          code: 'no_longer_needed',
          text: 'Not theirs to report',
        }),
    );
    await asOwner(() =>
      h.moduleRef.get(HouseholdsService).addMinor(s.unit.id, {
        fullName: 'Young Reporter',
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(bornYearsAgo(12)),
        relation: 'child',
      }),
    );

    const unit = await d.x.unit(s.c);
    const landlord = await d.x.asManager(s.c, () =>
      d.x.residents.createResident({
        ...d.x.person('landlord'),
        units: [{ unitId: unit.id, occupancyType: 'owner', resides: false }],
      }),
    );
    const tenant = await d.x.resident(s.c, [unit.id], 'tenant');
    Object.assign(rented, {
      unitId: unit.id,
      landlord: landlord.id,
      tenant: tenant.id,
    });
  }, 120_000);

  afterAll(() => h.close());

  const read = (unitId: string, token = s.manager.token) =>
    d.http('get', `/maintenance/units/${unitId}/reporters`, token);
  const reporters = async (unitId: string) =>
    ((await read(unitId).expect(200)).body as { data: Reporter[] }).data;
  const openFor = async (unitId: string, reporterAccountId: string) =>
    d.http('post', '/maintenance/tickets', s.manager.token, {
      unitId,
      categoryId: await d.categoryId(s.c, 'general'),
      description: 'Called the office',
      reporterAccountId,
    });

  it('lists the occupants and the members who hold tickets: ids and names, nothing else', async () => {
    const res = await read(s.unit.id).expect(200);
    const body = res.body as { data: Reporter[]; nextCursor: null };
    expect(body.nextCursor).toBeNull();
    for (const r of body.data)
      expect(Object.keys(r).sort()).toEqual(['fullName', 'id']);
    expect(body.data.map((r) => r.id).sort()).toEqual(
      [s.owner.id, home.spouse.id].sort(),
    );
    expect(body.data.find((r) => r.id === home.spouse.id)?.fullName).toBe(
      home.spouse.fullName,
    );
    // By name, then id.
    expect(body.data.map((r) => r.fullName)).toEqual(
      [...body.data.map((r) => r.fullName)].sort((a, b) =>
        a! < b! ? -1 : a! > b! ? 1 : 0,
      ),
    );
    // No contact detail, no document, no relation, no minor.
    expect(res.text).not.toMatch(/phone|email|idDocument|birth|relation/i);
    expect(res.text).not.toContain('Young Reporter');
  });

  it('a landlord who lives elsewhere is not listed; the tenant is', async () => {
    expect((await reporters(rented.unitId)).map((r) => r.id)).toEqual([
      rented.tenant,
    ]);
  });

  it('the list is the eligibility rule: everyone listed is accepted, nobody else is', async () => {
    const accepted = async (unitId: string, id: string) =>
      (await openFor(unitId, id)).status === 201;
    for (const r of await reporters(s.unit.id))
      expect(await accepted(s.unit.id, r.id)).toBe(true);
    for (const r of await reporters(rented.unitId))
      expect(await accepted(rented.unitId, r.id)).toBe(true);

    const refused = [
      [s.unit.id, home.relative.id], // a member without `tickets`
      [rented.unitId, rented.landlord], // does not live there
      [rented.unitId, s.owner.id], // lives in another unit
      [s.unit.id, rented.tenant],
      [s.unit.id, s.supervisor.id], // staff
      [s.unit.id, s.manager.id],
    ];
    for (const [unitId, id] of refused) {
      const res = await openFor(unitId, id);
      expect(res.status).toBe(400);
      expect((res.body as { fields: unknown[] }).fields).toEqual([
        { field: 'reporterAccountId', code: 'REPORTER_NOT_ELIGIBLE' },
      ]);
      expect((await reporters(unitId)).map((r) => r.id)).not.toContain(id);
    }
  });

  it('a member given `tickets` back is listed again', async () => {
    const member = await d.inTenant(s.c, (tx) =>
      tx.householdMember.findFirstOrThrow({
        where: { unitId: s.unit.id, accountId: home.relative.id },
        select: { id: true },
      }),
    );
    await d.x.as(s.c, { id: s.owner.id, type: 'resident' }, () =>
      h.moduleRef.get(MemberPermissionsService).grant(member.id, 'tickets'),
    );
    expect((await reporters(s.unit.id)).map((r) => r.id)).toContain(
      home.relative.id,
    );
    expect((await openFor(s.unit.id, home.relative.id)).status).toBe(201);
  });

  it('an account that is no longer active is neither listed nor accepted', async () => {
    await d.x.asManager(s.c, () =>
      h.moduleRef
        .get(AccountsService)
        .updateStatus(rented.tenant, { status: 'inactive' }),
    );
    expect(await reporters(rented.unitId)).toEqual([]);
    const res = await openFor(rented.unitId, rented.tenant);
    expect((res.body as { fields: unknown[] }).fields).toEqual([
      { field: 'reporterAccountId', code: 'REPORTER_NOT_ELIGIBLE' },
    ]);
  });

  it('an unknown unit is UNIT_NOT_FOUND', async () => {
    const res = await read(s.manager.id).expect(404);
    expect(res.body).toMatchObject({ code: 'UNIT_NOT_FOUND' });
  });

  it('needs tickets.dispatch and residents.read together: neither alone is enough', async () => {
    // The supervisor dispatches but does not read residents.
    await read(s.unit.id, s.supervisor.token).expect(403);
    await read(s.unit.id, s.techs[0].token).expect(403);
    await read(s.unit.id, s.owner.token).expect(403);

    const roles = h.moduleRef.get(RolesService);
    const without = async (permission: string) => {
      const manager = await d.x.asManager(s.c, async () =>
        (await roles.list()).find((r) => r.key === 'manager')!,
      );
      await d.x.asManager(s.c, () =>
        roles.replacePermissions(
          manager.id,
          manager.permissions.filter((p) => p !== permission),
        ),
      );
      return () =>
        d.x.asManager(s.c, () =>
          roles.replacePermissions(manager.id, manager.permissions),
        );
    };
    for (const permission of ['residents.read', 'tickets.dispatch']) {
      const restore = await without(permission);
      try {
        await read(s.unit.id).expect(403);
      } finally {
        await restore();
      }
    }
    await read(s.unit.id).expect(200);
  });
});

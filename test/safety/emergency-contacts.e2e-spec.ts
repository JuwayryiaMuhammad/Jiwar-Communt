import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { safetyHelpers } from '../setup/safety';

interface Contacts {
  family: {
    accountId: string;
    name: string | null;
    role: string;
    isPrimary: boolean;
    phone: string | null;
  }[];
  gates: { gateId: string; name: string; role: string; phone: string }[];
  management: { role: string; phone: string }[];
}

/**
 * ADR 0047, C4: a unit's emergency contacts — the other people who live
 * there with their phones (for those who live there only), the gates in
 * service that have a phone, and the management's numbers when set.
 */
describe('Emergency contacts', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof safetyHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof safetyHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = safetyHelpers(h);
    s = await x.setUp('Contacts Court');
  }, 120_000);

  afterAll(() => h.close());

  const contacts = async (unitId: string, token: string) => {
    const res = await x
      .http('get', `/units/${unitId}/emergency-contacts`, token)
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    return res.body as Contacts;
  };
  const phoneOf = async (id: string) =>
    (await x.inTx(s.c, (tx) => tx.account.findUniqueOrThrow({ where: { id } })))
      .phone;

  it('the family: the other people who live there, the primary first, with their phones', async () => {
    const home = await x.unit(s.c);
    const owner = await x.owner(s.c, home.id);
    const member = await x.family(s.c, home.id, owner);
    const fromMember = await contacts(home.id, member.token);
    expect(fromMember.family).toEqual([
      {
        accountId: owner.id,
        name: expect.any(String) as string,
        role: 'owner',
        isPrimary: true,
        phone: await phoneOf(owner.id),
      },
    ]);
    const fromOwner = await contacts(home.id, owner.token);
    expect(fromOwner.family).toEqual([
      expect.objectContaining({
        accountId: member.id,
        role: 'member',
        isPrimary: false,
        phone: await phoneOf(member.id),
      }),
    ]);
  });

  it('a landlord gets the gates and the management, never the household', async () => {
    const rented = await x.unit(s.c);
    const landlord = await x.landlord(s.c, rented.id);
    const tenant = await x.tenant(s.c, rented.id);
    const fromLandlord = await contacts(rented.id, landlord.token);
    expect(fromLandlord.family).toEqual([]);
    expect(JSON.stringify(fromLandlord)).not.toContain(
      (await phoneOf(tenant.id))!,
    );
    // And the tenant's list has no landlord in it: they do not live there.
    expect((await contacts(rented.id, tenant.token)).family).toEqual([]);
  });

  it('the gates in service that have a phone, by name; the management’s numbers when set', async () => {
    const c = await x.x.compound(`Contacts gates ${uniqueSuffix()}`);
    const home = await x.unit(c);
    const owner = await x.owner(c, home.id);
    const manager = await x.who(c, c.managerId, 'manager');
    const gate = (name: string, phone?: string) =>
      x
        .http('post', '/gates', manager.token, {
          name,
          kind: 'mixed',
          ...(phone ? { phone } : {}),
        })
        .expect(201)
        .then((r) => r.body as { id: string });
    const north = await gate('North', '+20225550111');
    await gate('Back door');
    const closed = await gate('Closed', '+20225550112');
    await x
      .http('patch', `/gates/${closed.id}`, manager.token, {
        status: 'inactive',
      })
      .expect(200);
    const main = await gate('Main', '+20225550110');
    let got = await contacts(home.id, owner.token);
    expect(got.gates).toEqual([
      { gateId: main.id, name: 'Main', role: 'gate', phone: '+20225550110' },
      { gateId: north.id, name: 'North', role: 'gate', phone: '+20225550111' },
    ]);
    expect(got.management).toEqual([]);
    await x
      .http('patch', '/settings', manager.token, {
        officePhone: '+20225550101',
        emergencyPhone: '+20225550199',
      })
      .expect(200);
    got = await contacts(home.id, owner.token);
    expect(got.management).toEqual([
      { role: 'office', phone: '+20225550101' },
      { role: 'emergency', phone: '+20225550199' },
    ]);
    await x
      .http('patch', '/settings', manager.token, {
        dutyPhone: '+201000000555',
      })
      .expect(200);
    expect((await contacts(home.id, owner.token)).management).toEqual([
      { role: 'office', phone: '+20225550101' },
      { role: 'duty', phone: '+201000000555' },
      { role: 'emergency', phone: '+20225550199' },
    ]);
  });

  it('another unit is not found; staff have no route here', async () => {
    const other = await x.unit(s.c);
    await x.owner(s.c, other.id);
    const res = await x
      .http('get', `/units/${other.id}/emergency-contacts`, s.alice.token)
      .expect(404);
    expect(res.body).toMatchObject({ code: 'UNIT_NOT_FOUND' });
    const guard = await x.guardOnDuty(s.c);
    await x
      .http('get', `/units/${s.home.id}/emergency-contacts`, guard.token)
      .expect(403);
  });
});

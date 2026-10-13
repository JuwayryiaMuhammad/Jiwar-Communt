import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  neighboursHelpers,
  type NeighboursSetUp,
  type Who,
} from '../setup/neighbours';

/**
 * ADR 0042: when a household starts living in a unit, its primary is
 * greeted once with the compound's own text. The managers write it, in
 * English, Arabic or both, and may turn it off.
 */
describe('Neighbours — the welcome', () => {
  let h: HttpHarness;
  let n: ReturnType<typeof neighboursHelpers>;
  let s: NeighboursSetUp;
  let audit: ReturnType<typeof auditReaders>;

  const ENGLISH = {
    rulesEn: 'WELCOME-RULES quiet after 10 pm',
    officeHoursEn: 'WELCOME-HOURS 9 to 5',
    emergencyEn: 'WELCOME-EMERGENCY 122',
  };

  beforeAll(async () => {
    h = await createHttpHarness();
    n = neighboursHelpers(h);
    s = await n.setUp();
    audit = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  const put = (body: object, who: Who = s.manager) =>
    n.http('put', '/neighbours/welcome-template', who.token, body);
  const welcomes = (who: Who) =>
    n.notifications(s.c, who.id, 'neighbours.welcome');
  const fields = (res: { body: unknown }) =>
    (res.body as { fields: unknown[] }).fields;
  const sent = (unitId: string) =>
    n.x.asManager(s.c, () =>
      n.x.prisma.tenant.neighbourWelcome.findMany({ where: { unitId } }),
    );

  describe('the template', () => {
    it('starts on and empty: nobody is greeted until a manager writes it', async () => {
      expect(
        (
          await n
            .http('get', '/neighbours/welcome-template', s.manager.token)
            .expect(200)
        ).body,
      ).toMatchObject({ enabled: true, rulesEn: null, rulesAr: null });
      // The two households of the set-up moved in before any text existed.
      expect(await welcomes(s.alice)).toEqual([]);
      expect(
        (await n.http('get', '/neighbour-welcome', s.alice.token).expect(200))
          .body,
      ).toMatchObject({ available: false, rulesEn: null });
    });

    it('a language is whole or absent, and each text has its length', async () => {
      expect(
        fields(await put({ rulesEn: 'Only the rules' }).expect(400)),
      ).toEqual([
        { field: 'officeHoursEn', code: 'FIELD_REQUIRED' },
        { field: 'emergencyEn', code: 'FIELD_REQUIRED' },
      ]);
      expect(
        fields(await put({ ...ENGLISH, rulesAr: 'القواعد' }).expect(400)),
      ).toEqual([
        { field: 'officeHoursAr', code: 'FIELD_REQUIRED' },
        { field: 'emergencyAr', code: 'FIELD_REQUIRED' },
      ]);
      expect(
        fields(
          await put({ ...ENGLISH, emergencyEn: 'x'.repeat(1001) }).expect(400),
        ),
      ).toEqual([
        {
          field: 'emergencyEn',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 1000 },
        },
      ]);
    });

    it('the manager writes it; the audit says each text changed, never what it says', async () => {
      const res = await put(ENGLISH).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({
        enabled: true,
        ...ENGLISH,
        rulesAr: null,
      });
      const rows = await audit.tenant(s.c.tenantId, {
        action: 'neighbours.welcome_template_changed',
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].changes).toEqual({
        rulesEn: { changed: true },
        officeHoursEn: { changed: true },
        emergencyEn: { changed: true },
      });
      expect(JSON.stringify(rows)).not.toContain('WELCOME-');
      // The same again changes nothing and audits nothing.
      await put(ENGLISH).expect(200);
      expect(
        await audit.tenant(s.c.tenantId, {
          action: 'neighbours.welcome_template_changed',
        }),
      ).toHaveLength(1);
    });

    it('whoever has a unit reads it; the staff and other compounds do not', async () => {
      const family = await n.family(s.c, s.homeA.id, s.alice);
      for (const who of [s.alice, s.bob, family])
        expect(
          (await n.http('get', '/neighbour-welcome', who.token).expect(200))
            .body,
        ).toEqual({
          available: true,
          ...ENGLISH,
          rulesAr: null,
          officeHoursAr: null,
          emergencyAr: null,
        });
      await n.http('get', '/neighbour-welcome', s.handler.token).expect(403);
      await put(ENGLISH, s.handler).expect(403);
      await put(ENGLISH, s.alice).expect(403);
      const other = await n.setUp();
      expect(
        (
          await n
            .http('get', '/neighbour-welcome', other.alice.token)
            .expect(200)
        ).body,
      ).toMatchObject({ available: false, rulesEn: null });
    });
  });

  describe('who is greeted, and when', () => {
    it('the primary of a household that starts: once, by a notice that carries no text', async () => {
      const home = await n.unit(s.c, 'W');
      const primary = await n.owner(s.c, home.id);
      const rows = await welcomes(primary);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: 'neighbours.welcome',
        targetType: 'neighbour_welcome',
        params: {},
      });
      expect(JSON.stringify(rows)).not.toContain('WELCOME-');
      const [welcome] = await sent(home.id);
      expect(welcome).toMatchObject({ accountId: primary.id, unitId: home.id });
      expect(rows[0].targetId).toBe(welcome.id);
      const audited = await audit.tenant(s.c.tenantId, {
        action: 'neighbour_welcome.sent',
        targetId: welcome.id,
      });
      expect(audited[0].metadata).toEqual({
        unitId: home.id,
        occupancyId: welcome.occupancyId,
        accountId: primary.id,
      });
    });

    it('nobody else: not a second occupant, not a family member, not a landlord, not a neighbour', async () => {
      const home = await n.unit(s.c, 'W');
      const primary = await n.owner(s.c, home.id);
      const second = await n.owner(s.c, home.id);
      const family = await n.family(s.c, home.id, primary);
      const rented = await n.unit(s.c, 'W');
      const landlord = await n.landlord(s.c, rented.id);
      for (const who of [second, family, landlord, s.alice, s.bob])
        expect(await welcomes(who)).toEqual([]);
      expect(await sent(home.id)).toHaveLength(1);
      // A unit with only a landlord has no household yet.
      expect(await sent(rented.id)).toEqual([]);
      // Its tenant starts one.
      const tenant = await n.tenant(s.c, rented.id);
      expect(await welcomes(tenant)).toHaveLength(1);
      expect(await welcomes(landlord)).toEqual([]);
    });

    it('each household is greeted once: the next one in the same unit is greeted too', async () => {
      const home = await n.unit(s.c, 'W');
      const first = await n.tenant(s.c, home.id);
      expect(await welcomes(first)).toHaveLength(1);
      await n.moveOut(s.c, home.id, first);
      const next = await n.tenant(s.c, home.id);
      expect(await welcomes(next)).toHaveLength(1);
      expect(await welcomes(first)).toHaveLength(1);
      expect((await sent(home.id)).map((w) => w.accountId).sort()).toEqual(
        [first.id, next.id].sort(),
      );
    });

    it('a primary handed over inside a household that goes on is not a start', async () => {
      const home = await n.unit(s.c, 'W');
      const primary = await n.owner(s.c, home.id);
      const second = await n.owner(s.c, home.id);
      await n.x.asManager(s.c, () =>
        n.x.residents.setPrimary(home.id, second.id),
      );
      expect(await welcomes(second)).toEqual([]);
      expect(await welcomes(primary)).toHaveLength(1);
      expect(await sent(home.id)).toHaveLength(1);
    });

    it('an owner who moves into their own empty unit and becomes its primary starts one', async () => {
      const home = await n.unit(s.c, 'W');
      const landlord = await n.landlord(s.c, home.id);
      expect(await welcomes(landlord)).toEqual([]);
      const [occupancy] = await n.x.occupancies(s.c, home.id);
      await n.x.asManager(s.c, () =>
        n.x.residents.setResidence(occupancy.id, true),
      );
      // Living there, and not yet anyone's primary: still no household.
      expect(await welcomes(landlord)).toEqual([]);
      await n.x.asManager(s.c, () =>
        n.x.residents.setPrimary(home.id, landlord.id),
      );
      expect(await welcomes(landlord)).toHaveLength(1);
      // Made primary again: greeted once.
      await n.x.asManager(s.c, () =>
        n.x.residents.setPrimary(home.id, landlord.id),
      );
      expect(await welcomes(landlord)).toHaveLength(1);
    });

    it('turned off, or emptied, nobody is greeted; turned back on, the next household is', async () => {
      await put({ enabled: false }).expect(200);
      const quiet = await n.owner(s.c, (await n.unit(s.c, 'W')).id);
      expect(await welcomes(quiet)).toEqual([]);
      expect(
        (await n.http('get', '/neighbour-welcome', quiet.token).expect(200))
          .body,
      ).toMatchObject({ available: false, rulesEn: null });

      const cleared = await put({
        enabled: true,
        rulesEn: null,
        officeHoursEn: null,
        emergencyEn: null,
      }).expect(200);
      expect(cleared.body).toMatchObject({ enabled: true, rulesEn: null });
      const empty = await n.owner(s.c, (await n.unit(s.c, 'W')).id);
      expect(await welcomes(empty)).toEqual([]);

      await put({
        rulesAr: 'قواعد المجمع',
        officeHoursAr: 'من التاسعة إلى الخامسة',
        emergencyAr: 'الطوارئ ١٢٢',
      }).expect(200);
      const greeted = await n.owner(s.c, (await n.unit(s.c, 'W')).id);
      expect(await welcomes(greeted)).toHaveLength(1);
      expect(
        (await n.http('get', '/neighbour-welcome', greeted.token).expect(200))
          .body,
      ).toMatchObject({
        available: true,
        rulesEn: null,
        rulesAr: 'قواعد المجمع',
      });
      // Those who moved in while it was off are not greeted afterwards.
      expect(await welcomes(quiet)).toEqual([]);
    });
  });
});

import { err } from '../api/request';
import type { Compound } from '../setup/community';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { unitsHelpers, type Who } from '../setup/units';

type Hit = { type: string; id: string; title: string; subtitle: string | null };

/**
 * ADR 0072: the top bar's search. One field; results by kind, each kind
 * from a source the caller may read by its own list's permission: units
 * and buildings for whoever lists units, people for whoever lists them —
 * by name, or exactly by phone or email — never their details.
 */
describe('Unit register — the staff’s search', () => {
  let h: HttpHarness;
  let u: ReturnType<typeof unitsHelpers>;
  let c: Compound;
  let manager: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    u = unitsHelpers(h);
    ({ c, manager } = await u.setUp('Search Court'));
  }, 90_000);

  afterAll(() => h.close());

  const find = async (who: Who, q: string) =>
    (
      (
        await u
          .http(
            'get',
            `/staff/search?${new URLSearchParams({ q }).toString()}`,
            who.token,
          )
          .expect(200)
      ).body as { data: Hit[] }
    ).data;

  it('the manager finds a unit by part of its code and a building by name', async () => {
    const tag = uniqueSuffix().toUpperCase();
    const unit = await u.newUnit(manager, {
      code: `SR${tag}-1`,
      building: `Search ${tag}`,
    });
    const hits = await find(manager, `sr${tag.toLowerCase()}`);
    expect(hits).toEqual([
      {
        type: 'unit',
        id: unit.id,
        title: unit.code,
        subtitle: `Search ${tag}`,
      },
    ]);
    expect(
      (await find(manager, `Search ${tag}`)).filter(
        (x) => x.type === 'building',
      ),
    ).toEqual([
      {
        type: 'building',
        id: unit.buildingId,
        title: `Search ${tag}`,
        subtitle: null,
      },
    ]);
  });

  it('a resident by name or exactly by phone — the name and nothing more', async () => {
    const unit = await u.newUnit(manager);
    const r = await u.x.resident(c, [unit.id]);
    const byName = (await find(manager, r.fullName)).filter(
      (x) => x.type === 'resident',
    );
    expect(byName).toEqual([
      { type: 'resident', id: r.id, title: r.fullName, subtitle: null },
    ]);
    expect(
      (await find(manager, r.phone)).filter((x) => x.type === 'resident'),
    ).toEqual(byName);
    expect(JSON.stringify(byName)).not.toContain(r.email);
  });

  it('the security supervisor finds units, never people; a resident may not search here', async () => {
    const tag = uniqueSuffix().toUpperCase();
    const unit = await u.newUnit(manager, { code: `SV${tag}` });
    const r = await u.x.resident(c, [unit.id]);
    const supervisor = await u.who(
      c,
      (await u.g.guard(c, 'security_supervisor')).id,
      'staff',
    );
    expect((await find(supervisor, `SV${tag}`)).map((x) => x.type)).toEqual([
      'unit',
    ]);
    expect(
      (await find(supervisor, r.fullName)).filter((x) => x.type === 'resident'),
    ).toEqual([]);
    const owner = await u.who(c, r.id, 'resident');
    expect(
      err(await u.http('get', '/staff/search?q=SV', owner.token).expect(403))
        .code,
    ).toBe('FORBIDDEN');
  });

  it('another compound’s units are never found', async () => {
    const other = await u.setUp('Search Other Court');
    const tag = uniqueSuffix().toUpperCase();
    await u.newUnit(other.manager, { code: `OT${tag}` });
    expect(await find(manager, `OT${tag}`)).toEqual([]);
  });
});

import { WorkersService } from '../../src/community/workers/workers.service';
import { err } from '../api/request';
import type { Compound } from '../setup/community';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { unitsHelpers, type Who } from '../setup/units';

type Listed = {
  data: { id: string; code: string }[];
  nextCursor: string | null;
};

/**
 * ADR 0072: the unit register's reads. The list narrows by code and
 * building for anyone who lists units, and by where a unit stands and who
 * holds it for the manager only; the same filters export as CSV with
 * counts, never names; a unit's occupancy history is every place ever
 * held in it; the manager reads a unit's workers.
 */
describe('Unit register — the list, the CSV, the history, the workers', () => {
  let h: HttpHarness;
  let u: ReturnType<typeof unitsHelpers>;
  let c: Compound;
  let manager: Who;
  const tag = uniqueSuffix().toUpperCase();
  let owned: string;
  let rented: string;
  let closed: string;
  let buildingId: string;

  const codes = async (token: string, query: Record<string, string>) => {
    const qs = new URLSearchParams({ limit: '100', ...query }).toString();
    const res = await u.http('get', `/units?${qs}`, token).expect(200);
    return (res.body as Listed).data.map((x) => x.code).sort();
  };

  beforeAll(async () => {
    h = await createHttpHarness();
    u = unitsHelpers(h);
    ({ c, manager } = await u.setUp('Register Reads Court'));
    const b = await u.building(manager, `Reads ${tag}`);
    buildingId = b.id;
    const make = async (suffix: string) =>
      (
        await u.newUnit(manager, {
          code: `R${tag}-${suffix}`,
          buildingId: b.id,
        })
      ).id;
    await make('V');
    owned = await make('O');
    rented = await make('T');
    closed = await make('C');
    await u.x.resident(c, [owned]);
    await u.x.resident(c, [rented], 'tenant');
    await u.x.resident(c, [closed]);
    await u.x.asManager(c, () =>
      u.x.prisma.tenant.unit.update({
        where: { id: closed },
        data: { closedSince: new Date() },
      }),
    );
  }, 120_000);

  afterAll(() => h.close());

  it('narrows by part of the code (any case) and by building', async () => {
    expect(await codes(manager.token, { q: `r${tag.toLowerCase()}` })).toEqual([
      `R${tag}-C`,
      `R${tag}-O`,
      `R${tag}-T`,
      `R${tag}-V`,
    ]);
    expect(await codes(manager.token, { buildingId, q: '-V' })).toEqual([
      `R${tag}-V`,
    ]);
  });

  it('by where a unit stands and who holds it, for the manager', async () => {
    const mine = { q: `R${tag}` };
    expect(await codes(manager.token, { ...mine, status: 'vacant' })).toEqual([
      `R${tag}-V`,
    ]);
    expect(await codes(manager.token, { ...mine, status: 'occupied' })).toEqual(
      [`R${tag}-O`, `R${tag}-T`],
    );
    expect(await codes(manager.token, { ...mine, status: 'closed' })).toEqual([
      `R${tag}-C`,
    ]);
    expect(
      await codes(manager.token, { ...mine, occupancyType: 'tenant' }),
    ).toEqual([`R${tag}-T`]);
  });

  it('a staff role listing units (units.directory) and a resident may not filter by people', async () => {
    const supervisor = await u.who(
      c,
      (await u.g.guard(c, 'security_supervisor')).id,
      'staff',
    );
    expect(await codes(supervisor.token, { q: `R${tag}-V` })).toEqual([
      `R${tag}-V`,
    ]);
    const refused = await u
      .http('get', `/units?status=vacant&occupancyType=owner`, supervisor.token)
      .expect(400);
    expect(err(refused).fields).toEqual([
      { field: 'status', code: 'FIELD_NOT_ALLOWED' },
      { field: 'occupancyType', code: 'FIELD_NOT_ALLOWED' },
    ]);
    const own = await u.newUnit(manager);
    const owner = await u.who(
      c,
      (await u.x.resident(c, [own.id])).id,
      'resident',
    );
    await u.http('get', `/units?status=vacant`, owner.token).expect(400);
  });

  it('exports the same filters as CSV: counts, never names; a staff role may not', async () => {
    const res = await u
      .http('get', `/staff/units/export?q=R${tag}`, manager.token)
      .expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    const text = (res.text ?? (res.body as Buffer).toString('utf8')).replace(
      /^\uFEFF/,
      '',
    );
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toBe(
      'code,building,floor,unit_type,area_sqm,status,owners,tenants,residing',
    );
    expect(lines.slice(1)).toEqual([
      `R${tag}-C,Reads ${tag},,,,closed,1,0,1`,
      `R${tag}-O,Reads ${tag},,,,occupied,1,0,1`,
      `R${tag}-T,Reads ${tag},,,,occupied,0,1,1`,
      `R${tag}-V,Reads ${tag},,,,vacant,0,0,0`,
    ]);
    const supervisor = await u.who(
      c,
      (await u.g.guard(c, 'security_supervisor')).id,
      'staff',
    );
    await u.http('get', '/staff/units/export', supervisor.token).expect(403);
  });

  it('a building name a spreadsheet would run is defused in the CSV', async () => {
    const odd = await u.newUnit(manager, {
      code: `F${tag}`,
      building: `=SUM(${tag})`,
    });
    const res = await u
      .http('get', `/staff/units/export?q=F${tag}`, manager.token)
      .expect(200);
    const text = res.text ?? (res.body as Buffer).toString('utf8');
    expect(text).toContain(`'=SUM(${tag})`);
    expect(odd.building).toBe(`=SUM(${tag})`);
  });

  it('a unit’s history: every place held in it, live or ended, newest first; another compound’s unit is UNIT_NOT_FOUND', async () => {
    const unit = await u.newUnit(manager);
    const first = await u.x.resident(c, [unit.id]);
    const [occupancy] = await u.x.occupancies(c, unit.id);
    await u.x.asManager(c, () =>
      u.x.residents.endOccupancy(occupancy.id, {
        code: 'moved_out',
        text: 'Moved out',
      }),
    );
    const second = await u.x.resident(c, [unit.id], 'tenant');
    const res = await u
      .http('get', `/staff/units/${unit.id}/occupancy-history`, manager.token)
      .expect(200);
    const rows = (
      res.body as {
        data: {
          account: { id: string };
          occupancyType: string;
          status: string;
          endReason: string | null;
        }[];
      }
    ).data;
    expect(rows.map((r) => [r.account.id, r.occupancyType, r.status])).toEqual([
      [second.id, 'tenant', 'active'],
      [first.id, 'owner', 'ended'],
    ]);
    expect(rows[1].endReason).toBe('moved_out');
    const other = await u.setUp('History Other Court');
    const theirs = await u.newUnit(other.manager);
    expect(
      err(
        await u
          .http(
            'get',
            `/staff/units/${theirs.id}/occupancy-history`,
            manager.token,
          )
          .expect(404),
      ).code,
    ).toBe('UNIT_NOT_FOUND');
  });

  it('the manager reads a unit’s workers (workers.review), no other unit’s', async () => {
    const unit = await u.newUnit(manager);
    const elsewhere = await u.newUnit(manager);
    const primary = await u.who(
      c,
      (await u.x.resident(c, [unit.id])).id,
      'resident',
    );
    const otherPrimary = await u.who(
      c,
      (await u.x.resident(c, [elsewhere.id])).id,
      'resident',
    );
    const register = (who: Who, unitId: string) => {
      const p = u.x.person('worker');
      return u.x.as(c, { id: who.id, type: 'resident' }, () =>
        h.moduleRef.get(WorkersService).register(unitId, {
          fullName: p.fullName,
          idDocumentType: 'national_id',
          idDocumentNumber: p.idDocumentNumber,
          phone: p.phone,
          capacity: 'nanny',
          schedule: {
            days: [0, 1, 2, 3, 4, 5, 6],
            windows: [{ from: '08:00', to: '17:00' }],
          },
        }),
      );
    };
    const mine = await register(primary, unit.id);
    await register(otherPrimary, elsewhere.id);
    const res = await u
      .http('get', `/worker-engagements?unitId=${unit.id}`, manager.token)
      .expect(200);
    expect((res.body as Listed).data.map((e) => e.id)).toEqual([
      mine.engagementId,
    ]);
  });
});

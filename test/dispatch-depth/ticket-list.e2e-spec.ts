import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { SlaSweep } from '../../src/maintenance/sla/sla-sweep';
import { assetHelpers, type AssetSetUp } from '../setup/assets';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { rewind } from '../setup/sla';
import { today } from '../setup/compound-clock';
import { addDays } from '../../src/maintenance/schedules/local-dates';

/** An answer's body, as the assertions read it. */
type Body = {
  code: string;
  fields: { field: string; code: string }[];
  [key: string]: unknown;
};

interface Listed {
  data: { id: string; number: string }[];
}

/**
 * ADR 0076: the dispatch list's `buildingId` (a unit in it, or a common
 * area it names) and `q` (a ticket's number, or the start of a unit's code), on
 * both of the list's paths (the plain page and the SLA-flagged one), and
 * its CSV over a period of creation days: codes and numbers, never words.
 */
describe('Dispatch depth — the ticket list’s building, search and export', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof assetHelpers>;
  let s: AssetSetUp;
  let inTower: string;
  let inArea: string;
  let elsewhere: string;
  let otherCode: string;
  /** The building `s.building` names (ADR 0072): the unit's, by its trigger. */
  let buildingId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = assetHelpers(h);
    s = await a.setUp(1);
    inTower = await a.openTicket(s);
    buildingId = (
      await a.inTenant(s.c, (tx) =>
        tx.unit.findUniqueOrThrow({ where: { id: s.unit.id } }),
      )
    ).buildingId!;
    const area = await a.area(s, { building: s.building });
    const plumbing = await a.categoryId(s.c, 'plumbing');
    inArea = (
      (
        await a
          .http('post', '/maintenance/work-orders', s.supervisor.token, {
            commonAreaId: area.id,
            categoryId: plumbing,
            description: 'Riser leaks',
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    otherCode = `ZQ-${uniqueSuffix()}`;
    const other = await a.x.unit(s.c, otherCode);
    await a.inTenant(s.c, (tx) =>
      tx.unit.update({
        where: { id: other.id },
        data: { building: `Other ${uniqueSuffix()}` },
      }),
    );
    const owner = await a.x.resident(s.c, [other.id]);
    const token = await h.tokenFor({
      sub: owner.id,
      tid: s.c.tenantId,
      typ: 'resident',
    });
    elsewhere = (
      (
        await a
          .http('post', '/tickets', token, {
            unitId: other.id,
            categoryId: plumbing,
            description: 'Tap drips',
          })
          .expect(201)
      ).body as { id: string }
    ).id;
  }, 180_000);

  afterAll(() => h.close());

  const list = async (query: string) =>
    (
      (
        await a
          .http('get', `/maintenance/tickets?${query}`, s.supervisor.token)
          .expect(200)
      ).body as Listed
    ).data.map((t) => t.id);

  it('`buildingId`: the units’ tickets there and the work orders of the common areas it names; none elsewhere', async () => {
    const ids = await list(`buildingId=${buildingId}`);
    expect(ids).toEqual(expect.arrayContaining([inTower, inArea]));
    expect(ids).not.toContain(elsewhere);
  });

  it('`q`: a number with or without its prefix, or the start of a unit’s code in any case', async () => {
    const row = await a.ticketRow(s.c, elsewhere);
    const padded = `MT-${String(row.number).padStart(6, '0')}`;
    expect(await list(`q=${padded}`)).toContain(elsewhere);
    expect(await list(`q=${row.number}`)).toContain(elsewhere);
    const byCode = await list(`q=${otherCode.slice(0, 5).toLowerCase()}`);
    expect(byCode).toContain(elsewhere);
    expect(byCode).not.toContain(inTower);
    // A LIKE wildcard is a character, not a wildcard.
    expect(await list('q=%25')).toEqual([]);
  });

  it('the same filters on the SLA-flagged path: an overdue ticket found by its building', async () => {
    await a
      .http('patch', '/maintenance/sla-settings', s.manager.token, {
        slaEnabled: true,
      })
      .expect(200);
    // The pass opens a transaction a ticket at a time: the compound's
    // context only, never inside one (ADR 0034).
    const cls = h.moduleRef.get<ClsService<AppClsStore>>(ClsService);
    await cls.run(async () => {
      cls.set('tenantId', s.c.tenantId);
      await h.moduleRef.get(SlaSweep).pass();
    });
    await rewind(inTower, 10 * 24 * 60);
    await rewind(elsewhere, 10 * 24 * 60);
    const ids = await list(`overdue=true&buildingId=${buildingId}`);
    expect(ids).toContain(inTower);
    expect(ids).not.toContain(elsewhere);
  });

  it('exports the list over a period: codes and numbers, never the words', async () => {
    const to = today();
    const from = addDays(to, -30);
    const res = await a
      .http(
        'get',
        `/maintenance/tickets/export?from=${from}&to=${to}&buildingId=${buildingId}`,
        s.supervisor.token,
      )
      .buffer(true)
      .parse((r, done) => {
        let body = '';
        r.on('data', (c: Buffer) => (body += c.toString('utf8')));
        r.on('end', () => done(null, body));
      })
      .expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['cache-control']).toContain('no-store');
    const text = res.body as string;
    expect(text.split('\r\n')[0]).toContain(
      'number,status,priority,origin,kind,category_key,unit_code,building',
    );
    expect(text).toContain(s.unit.code);
    expect(text).not.toContain('Riser leaks');
    expect(text).not.toContain(otherCode);
  });

  it('refuses a period backwards or over a year', async () => {
    const back = await a
      .http(
        'get',
        '/maintenance/tickets/export?from=2026-05-01&to=2026-04-01',
        s.supervisor.token,
      )
      .expect(400);
    expect((back.body as Body).fields).toEqual([
      { field: 'to', code: 'INVALID_VALUE', params: { maxDays: 366 } },
    ]);
    await a
      .http(
        'get',
        '/maintenance/tickets/export?from=2025-01-01&to=2026-04-01',
        s.supervisor.token,
      )
      .expect(400);
  });
});

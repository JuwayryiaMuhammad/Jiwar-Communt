import { GlobalDbService } from '../../src/core/database/global-db.service';
import { COMPOUND_EXPORT_BUILD_SWEEP } from '../../src/core/reports/compound-exports.service';
import { EXPORT_TABLES } from '../../src/core/reports/export-tables';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { err } from '../api/request';
import { sessionOf } from '../api/world';
import { daysLater } from '../setup/compound-clock';
import { energyHelpers } from '../setup/energy';
import { readArchive } from '../setup/exports';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface ExportBody {
  id: string;
  status: string;
  tables: number | null;
  rows: number | null;
}

/**
 * ADR 0086: the compound's operational data as one archive — for the
 * manager, behind a fresh step-up, one at a time and once a day (two
 * requests meeting included); fixed tables and columns, never a person's
 * name, phone or email, a household's meter or a ticket's unit; audited.
 */
describe('Reports — the compound’s export', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof energyHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof energyHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    e = energyHelpers(h);
    s = await e.setUp(1);
  }, 120_000);

  afterAll(() => h.close());

  /** Opens the token's session for one sensitive action, as a code would. */
  const stepUp = (token: string) =>
    h.moduleRef.get(GlobalDbService).session.update({
      where: { id: sessionOf(token) },
      data: { stepUpUntil: daysLater(1) },
    });
  const request = (token = s.manager.token) =>
    e.http('post', '/staff/compound-exports', token, {});
  const build = async () => {
    const sweep = h.moduleRef.get(SweepRunner);
    while ((await sweep.run(COMPOUND_EXPORT_BUILD_SWEEP, new Date())) > 0);
  };

  it('needs the manager’s fresh step-up, then is built with the fixed tables and nobody’s data', async () => {
    await request(s.techs[0].token).expect(403);
    expect(err(await request().expect(403)).code).toBe('STEP_UP_REQUIRED');
    const household = await e.meter(s, { unitId: s.unit.id, kind: 'water' });
    const common = await e.meter(s, { kind: 'water' });
    await stepUp(s.manager.token);
    const asked = (await request().expect(201)).body as ExportBody;
    expect(asked.status).toBe('pending');
    // One at a time.
    await stepUp(s.manager.token);
    expect(err(await request().expect(409)).code).toBe(
      'COMPOUND_EXPORT_ACTIVE',
    );
    await build();
    const [ready] = (
      (
        await e
          .http('get', '/staff/compound-exports', s.manager.token)
          .expect(200)
      ).body as { data: ExportBody[] }
    ).data;
    expect(ready).toMatchObject({
      id: asked.id,
      status: 'ready',
      tables: EXPORT_TABLES.length,
    });
    const told = await e.inTenant(s.c, (tx) =>
      tx.notification.findMany({
        where: { accountId: s.manager.id, kind: 'compound_export.ready' },
      }),
    );
    expect(told.map((n) => n.targetId)).toContain(asked.id);
    const link = (
      await e
        .http(
          'get',
          `/staff/compound-exports/${asked.id}/download`,
          s.manager.token,
        )
        .expect(200)
    ).body as { url: string };
    const zip = await readArchive(link.url);
    expect(zip.names).toEqual(
      ['README.json', ...EXPORT_TABLES.map((t) => `${t.file}.csv`)].sort(),
    );
    const head = (file: string) =>
      zip.text(file).replace(/^﻿/, '').split('\r\n')[0];
    expect(head('units.csv')).toBe(
      'id,code,building_id,floor,unit_type,area_sqm',
    );
    expect(head('tickets.csv')).not.toContain('unit_id');
    expect(zip.text('meters.csv')).toContain(common.id);
    expect(zip.text('meters.csv')).not.toContain(household.id);
    expect(zip.text('units.csv')).toContain(s.unit.id);
    // Nobody: the owner's name, phone and email appear nowhere.
    const owner = await e.inTenant(s.c, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: s.owner.id } }),
    );
    const everything = zip.names.map((n) => zip.text(n)).join('\n');
    for (const value of [owner.fullName, owner.email, owner.phone])
      if (value) expect(everything).not.toContain(value);
    const audit = await e.inTenant(s.c, (tx) =>
      tx.auditLog.findMany({ where: { targetId: asked.id } }),
    );
    expect(audit.map((a) => a.action).sort()).toEqual([
      'compound_export.downloaded',
      'compound_export.ready',
      'compound_export.requested',
    ]);
  });

  it('once a day: another request is refused until the day has passed', async () => {
    await stepUp(s.manager.token);
    const refused = err(await request().expect(429));
    expect(refused.code).toBe('COMPOUND_EXPORT_RATE_LIMITED');
    expect(refused.params).toHaveProperty('retryAfter');
  });

  it('two requests at once: one export, the other refused', async () => {
    const t = await e.setUp(0);
    await stepUp(t.manager.token);
    const [x, y] = await Promise.all([
      request(t.manager.token),
      request(t.manager.token),
    ]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    const loser = x.status === 409 ? x : y;
    expect(['COMPOUND_EXPORT_ACTIVE', 'STEP_UP_REQUIRED']).toContain(
      err(loser).code,
    );
    const rows = await e.inTenant(t.c, (tx) => tx.compoundExport.count());
    expect(rows).toBe(1);
  });
});

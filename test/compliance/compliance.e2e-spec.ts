import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { COMPLIANCE_SWEEP } from '../../src/maintenance/compliance/compliance-sweep';
import { newId } from '../../src/core/common/uuid';
import { err } from '../api/request';
import {
  complianceHelpers,
  type ComplianceItemBody,
} from '../setup/compliance';
import { dbClock, dbDate, day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { marketFileRow } from '../setup/market-rows';

/**
 * ADR 0087, the compliance calendar: items with who answers for them, due
 * days that recur and are told ahead, completions with their evidence, the
 * vendors' papers read in, the status report, its CSV and the board's
 * section; the lead times as settings.
 */
describe('Compliance calendar (ADR 0087)', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof complianceHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof complianceHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = complianceHelpers(h);
    s = await x.setUp();
  }, 180_000);

  afterAll(() => h.close());

  const m = () => s.manager.token;
  const sweep = () =>
    h.moduleRef.get(SweepRunner).run(COMPLIANCE_SWEEP, new Date());
  const get = async (id: string) =>
    (await x.http('get', `/staff/compliance/items/${id}`, m()).expect(200))
      .body as ComplianceItemBody;

  it('an item: its first due day made with it, the responsible staff member told, its state today', async () => {
    const item = await x.create(m(), {
      kind: 'lift',
      title: 'Lift licence, tower A',
      authority: 'City engineering office',
      reference: 'LIC-2027/14',
      assetId: s.assetId,
      vendorId: s.vendorId,
      ownerId: s.tech.id,
      recurrenceMonths: 12,
      firstDueOn: day(200),
    });
    expect(item).toMatchObject({
      kind: 'lift',
      state: 'valid',
      recurrenceMonths: 12,
      leadDays: [60, 30, 7],
      ownLeadDays: false,
      vendor: { id: s.vendorId },
      owner: { id: s.tech.id },
      asset: { id: s.assetId },
      commonArea: null,
      current: { dueOn: day(200), status: 'open' },
      lastDone: null,
    });
    expect(item.occurrences).toHaveLength(1);
    expect(await x.told(s.c, s.tech.id, item.id)).toEqual([
      {
        kind: 'compliance_item.assigned',
        params: { complianceKind: 'lift', dueOn: day(200) },
      },
    ]);
  });

  it('refuses what it may not name: two subjects, nobody answering, a resident, a past or far day', async () => {
    const fields = async (body: Record<string, unknown>) =>
      err(await x.createRaw(m(), body).expect(400)).fields;
    expect(
      await fields({
        assetId: s.assetId,
        commonAreaId: s.areaId,
        ownerId: s.tech.id,
        firstDueOn: day(10),
      }),
    ).toEqual([{ field: 'commonAreaId', code: 'FIELD_NOT_ALLOWED' }]);
    expect(await fields({ firstDueOn: day(10) })).toEqual([
      { field: 'vendorId', code: 'FIELD_REQUIRED' },
    ]);
    expect(await fields({ ownerId: s.alice.id, firstDueOn: day(10) })).toEqual([
      { field: 'ownerId', code: 'RESPONSIBLE_NOT_ELIGIBLE' },
    ]);
    expect(
      await fields({ ownerId: s.tech.id, firstDueOn: day(-1) }),
    ).toMatchObject([{ field: 'firstDueOn', code: 'DAY_OUT_OF_RANGE' }]);
    await x
      .createRaw(m(), {
        vendorId: newId(),
        firstDueOn: day(10),
      })
      .expect(404);
  });

  it('done once: the next due day on the expiry it gave, its evidence filed; the archive keeps both', async () => {
    const item = await x.create(m(), {
      kind: 'insurance',
      title: 'Building insurance',
      vendorId: s.vendorId,
      recurrenceMonths: 12,
      firstDueOn: day(20),
    });
    const file = await x.files.ready(m(), 'compliance_evidence');
    const done = (
      await x
        .completeRaw(m(), item.current!.id, {
          doneOn: day(0),
          certificateNumber: 'POL 99/2027',
          expiresOn: day(380),
          note: 'Renewed with the same cover',
          fileIds: [file],
        })
        .expect(200)
    ).body as ComplianceItemBody;
    expect(done.current).toMatchObject({ dueOn: day(380), status: 'open' });
    expect(done.lastDone).toMatchObject({
      doneOn: day(0),
      expiresOn: day(380),
      certificateNumber: 'POL 99/2027',
    });
    expect(done.occurrences.map((o) => o.status)).toEqual(['open', 'done']);
    expect(done.occurrences[0].previousId).toBe(item.current!.id);
    expect(done.occurrences[1].evidence).toHaveLength(1);
    // Twice: the second finds it done.
    expect(
      err(
        await x
          .completeRaw(m(), item.current!.id, { doneOn: day(0) })
          .expect(409),
      ),
    ).toMatchObject({
      code: 'COMPLIANCE_OCCURRENCE_ENDED',
      params: { status: 'done' },
    });
  });

  it('the next due day: so many months on without an expiry; none for an item done once', async () => {
    const monthly = await x.create(m(), {
      kind: 'fire_system',
      ownerId: s.tech.id,
      recurrenceMonths: 1,
      firstDueOn: day(3),
    });
    const after = (
      await x
        .completeRaw(m(), monthly.current!.id, { doneOn: day(0) })
        .expect(200)
    ).body as ComplianceItemBody;
    expect(after.current?.dueOn).toBeDefined();
    expect(after.current!.dueOn > day(3)).toBe(true);
    const once = await x.create(m(), {
      kind: 'permit',
      ownerId: s.tech.id,
      firstDueOn: day(3),
    });
    const closed = (
      await x.completeRaw(m(), once.current!.id, { doneOn: day(0) }).expect(200)
    ).body as ComplianceItemBody;
    expect(closed).toMatchObject({ state: 'completed', current: null });
    expect(
      err(
        await x
          .completeRaw(m(), once.current!.id, {
            doneOn: day(1),
          })
          .expect(409),
      ).code,
    ).toBe('COMPLIANCE_OCCURRENCE_ENDED');
  });

  it('a completion’s day is not ahead, and an expiry comes after it', async () => {
    const item = await x.create(m(), {
      ownerId: s.tech.id,
      firstDueOn: day(5),
    });
    expect(
      err(
        await x
          .completeRaw(m(), item.current!.id, { doneOn: day(1) })
          .expect(400),
      ).fields,
    ).toMatchObject([{ field: 'doneOn', code: 'DAY_OUT_OF_RANGE' }]);
    expect(
      err(
        await x
          .completeRaw(m(), item.current!.id, {
            doneOn: day(0),
            expiresOn: day(0),
          })
          .expect(400),
      ).fields,
    ).toEqual([{ field: 'expiresOn', code: 'ENDS_BEFORE_START' }]);
  });

  it('each lead time told once, the shortest reached; a moved day starts again; a passed day once', async () => {
    const item = await x.create(m(), {
      kind: 'licence',
      ownerId: s.tech.id,
      firstDueOn: day(20),
    });
    const told = async () =>
      (await x.told(s.c, s.tech.id, item.id)).filter(
        (n) => n.kind !== 'compliance_item.assigned',
      );
    await sweep();
    await sweep();
    expect(await told()).toEqual([
      {
        kind: 'compliance.due_soon',
        params: { complianceKind: 'licence', dueOn: day(20), daysLeft: 20 },
      },
    ]);
    expect(
      (await x.told(s.c, s.manager.id, item.id)).map((n) => n.kind),
    ).toEqual(['compliance.due_soon']);
    await x
      .http('patch', `/staff/compliance/items/${item.id}`, m(), {
        nextDueOn: day(4),
      })
      .expect(200);
    await sweep();
    expect(
      (await told()).map((n) => (n.params as { daysLeft: number }).daysLeft),
    ).toEqual([20, 4]);
    await x.setDue(s.c, item.current!.id, day(-1));
    await sweep();
    await sweep();
    expect((await told()).map((n) => n.kind)).toEqual([
      'compliance.due_soon',
      'compliance.due_soon',
      'compliance.overdue',
    ]);
    expect((await get(item.id)).state).toBe('overdue');
  });

  it('retired once, with a code: its open due day called off, nothing changes after', async () => {
    const item = await x.create(m(), {
      ownerId: s.tech.id,
      firstDueOn: day(30),
    });
    const retired = (
      await x
        .http('post', `/staff/compliance/items/${item.id}/retire`, m(), {
          reasonCode: 'not_applicable',
        })
        .expect(200)
    ).body as ComplianceItemBody;
    expect(retired).toMatchObject({
      state: 'retired',
      retireReason: 'not_applicable',
      current: null,
    });
    expect(retired.occurrences[0].status).toBe('cancelled');
    for (const call of [
      x.http('post', `/staff/compliance/items/${item.id}/retire`, m(), {
        reasonCode: 'other',
      }),
      x.http('patch', `/staff/compliance/items/${item.id}`, m(), {
        title: 'Again',
      }),
      x.completeRaw(m(), item.current!.id, { doneOn: day(0) }),
    ])
      expect(err(await call.expect(409)).code).toBe('COMPLIANCE_ITEM_RETIRED');
  });

  it('the calendar holds the due days and the vendors’ papers expiring then, by day', async () => {
    const item = await x.create(m(), {
      ownerId: s.tech.id,
      firstDueOn: day(15),
    });
    const paperId = newId();
    await x.inTx(s.c, async (tx) => {
      const fileId = await marketFileRow(tx, s.c.tenantId, 'vendor_document');
      await tx.vendorDocument.create({
        data: {
          id: paperId,
          tenantId: s.c.tenantId,
          vendorId: s.vendorId,
          kind: 'insurance',
          fileId,
          expiresOn: dbDate(day(16)),
          addedById: s.manager.id,
          addedAt: dbClock(),
        },
      });
    });
    const cal = (
      await x
        .http(
          'get',
          `/staff/compliance/calendar?from=${day(14)}&to=${day(16)}`,
          m(),
        )
        .expect(200)
    ).body as {
      entries: { source: string; id: string; day: string; state: string }[];
    };
    const mine = cal.entries.filter(
      (e) => e.id === item.current!.id || e.id === paperId,
    );
    expect(mine).toEqual([
      expect.objectContaining({
        source: 'compliance',
        day: day(15),
        state: 'due_soon',
      }),
      expect.objectContaining({
        source: 'vendor_document',
        day: day(16),
        state: 'due_soon',
      }),
    ]);
    expect(
      err(
        await x
          .http(
            'get',
            `/staff/compliance/calendar?from=${day(0)}&to=${day(366)}`,
            m(),
          )
          .expect(400),
      ).fields,
    ).toEqual([
      { field: 'to', code: 'PERIOD_TOO_LONG', params: { maxDays: 366 } },
    ]);
  });

  it('the status report counts every kind with zeros, and its CSV lists the items soonest first; no-store', async () => {
    const res = await x
      .http('get', '/staff/compliance/report', m())
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const r = res.body as {
      totals: Record<string, number>;
      kinds: { kind: string; items: number }[];
      vendorPapers: Record<string, number>;
    };
    expect(r.kinds.map((k) => k.kind)).toEqual([
      'fire_system',
      'lift',
      'insurance',
      'licence',
      'permit',
      'other',
    ]);
    const items = await x.inTx(s.c, (tx) =>
      tx.complianceItem.count({ where: { retiredAt: null } }),
    );
    expect(r.totals.items).toBe(items);
    expect(
      r.totals.valid + r.totals.dueSoon + r.totals.overdue + r.totals.completed,
    ).toBe(items);
    expect(r.totals.overdue).toBeGreaterThanOrEqual(1);
    const csv = await x
      .http('get', '/staff/compliance/report/export', m())
      .expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toBe(
      '﻿kind,title,authority,reference,asset,common_area,vendor,state,due_on,last_done_on,expires_on',
    );
  });

  it('the lead times are settings: one to three, 1 to 365 days, the item’s own above them', async () => {
    expect(
      (await x.http('get', '/staff/compliance/settings', m()).expect(200)).body,
    ).toEqual({ leadDays: [60, 30, 7] });
    expect(
      (
        await x
          .http('put', '/staff/compliance/settings', m(), {
            leadDays: [14, 90, 14],
          })
          .expect(200)
      ).body,
    ).toEqual({ leadDays: [90, 14] });
    await x
      .http('put', '/staff/compliance/settings', m(), { leadDays: [] })
      .expect(400);
    await x
      .http('put', '/staff/compliance/settings', m(), { leadDays: [400] })
      .expect(400);
    const own = await x.create(m(), {
      ownerId: s.tech.id,
      leadDays: [3],
      firstDueOn: day(10),
    });
    expect(own).toMatchObject({
      leadDays: [3],
      ownLeadDays: true,
      state: 'valid',
    });
    await x
      .http('put', '/staff/compliance/settings', m(), {
        leadDays: [60, 30, 7],
      })
      .expect(200);
  });

  it('who keeps the calendar: the manager; a technician, a guard and an owner are refused', async () => {
    const guard = await x.v.who(s.c, (await x.g.guard(s.c)).id, 'staff');
    for (const who of [s.tech, guard, s.alice])
      await x.http('get', '/staff/compliance/items', who.token).expect(403);
  });

  it('the board’s overview has the compliance section: today’s counts, no title', async () => {
    const report = (
      await x.http('get', '/staff/compliance/report', m()).expect(200)
    ).body as { totals: unknown; vendorPapers: unknown };
    const { BoardMatters } =
      await import('../../src/core/board-matters/board-matters');
    const section = h.moduleRef
      .get(BoardMatters)
      .overview()
      .find(([name]) => name === 'compliance');
    expect(section).toBeDefined();
    const out = await x.v.x.asManager(s.c, () =>
      section![1]({ from: day(-6), to: day(0) }),
    );
    expect(out).toMatchObject({
      totals: report.totals,
      vendorPapers: report.vendorPapers,
    });
    expect(JSON.stringify(out)).not.toContain('Lift licence');
  });
});

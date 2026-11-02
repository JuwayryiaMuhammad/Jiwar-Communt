import { assetHelpers, type AssetSetUp } from '../setup/assets';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type Body = {
  code: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
};

interface CaseBody {
  id: string;
  status: string;
  categoryKey: string;
  buildingId: string;
  automatic: boolean;
  ticketCount: number;
  workOrder: { id: string; number: string } | null;
  tickets: { id: string; number: string }[];
}

/**
 * ADR 0081: a community case opens itself when a building's residents'
 * tickets of one category within the window reach the compound's number —
 * once, even when two land at the same time (the ticket counter's row lock
 * orders them) — and takes the next one while open; it has one work order
 * (two at once: one wins), and is resolved (the reporters told) or
 * dismissed once. A sensitive ticket of it shows only to the holders.
 */
describe('Maintenance analytics — community cases', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof assetHelpers>;
  let s: AssetSetUp;
  let plumbing: string;

  /** A unit in `building` with its own resident; their token. */
  async function household(building: string) {
    const unit = await a.x.unit(s.c, `CS-${uniqueSuffix()}`);
    await a.inTenant(s.c, (tx) =>
      tx.unit.update({ where: { id: unit.id }, data: { building } }),
    );
    const owner = await a.x.resident(s.c, [unit.id]);
    const token = await h.tokenFor({
      sub: owner.id,
      tid: s.c.tenantId,
      typ: 'resident',
    });
    return { unitId: unit.id, ownerId: owner.id, token };
  }

  const report = (who: { unitId: string; token: string }) =>
    a.http('post', '/tickets', who.token, {
      unitId: who.unitId,
      categoryId: plumbing,
      description: 'No water pressure',
    });

  const casesOf = (buildingName: string) =>
    a.inTenant(s.c, async (tx) => {
      const b = await tx.building.findFirstOrThrow({
        where: { name: buildingName },
      });
      return tx.maintenanceCase.findMany({
        where: { buildingId: b.id, categoryId: plumbing },
      });
    });

  const detail = async (id: string, token = s.supervisor.token) =>
    (await a.http('get', `/maintenance/cases/${id}`, token).expect(200))
      .body as CaseBody;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = assetHelpers(h);
    s = await a.setUp(1);
    plumbing = await a.categoryId(s.c, 'plumbing');
    await a
      .http('patch', '/maintenance/settings/analytics', s.manager.token, {
        caseMinTickets: 2,
      })
      .expect(200);
  }, 180_000);

  afterAll(() => h.close());

  it('below the number, no case', async () => {
    const tower = `Tower ${uniqueSuffix()}`;
    await report(await household(tower)).expect(201);
    expect(await casesOf(tower)).toEqual([]);
  });

  it('two tickets landing at once open one case with both; the dispatch and each reporter are told', async () => {
    const tower = `Tower ${uniqueSuffix()}`;
    const [x, y] = [await household(tower), await household(tower)];
    const [rx, ry] = await Promise.all([report(x), report(y)]);
    expect([rx.status, ry.status]).toEqual([201, 201]);
    const cases = await casesOf(tower);
    expect(cases).toHaveLength(1);
    const c = await detail(cases[0].id);
    expect(c).toMatchObject({
      status: 'open',
      categoryKey: 'plumbing',
      automatic: true,
      ticketCount: 2,
    });
    const ids = [
      (rx.body as { id: string }).id,
      (ry.body as { id: string }).id,
    ];
    expect(c.tickets.map((t) => t.id).sort()).toEqual(ids.sort());
    const notes = await a.inTenant(s.c, (tx) =>
      tx.notification.findMany({
        where: {
          kind: { in: ['maintenance_case.opened', 'ticket.case_linked'] },
        },
      }),
    );
    expect(
      notes
        .filter(
          (n) => n.kind === 'maintenance_case.opened' && n.targetId === c.id,
        )
        .map((n) => n.accountId),
    ).toEqual(expect.arrayContaining([s.manager.id, s.supervisor.id]));
    for (const who of [x, y])
      expect(
        notes.some(
          (n) => n.kind === 'ticket.case_linked' && n.accountId === who.ownerId,
        ),
      ).toBe(true);
    const opened = await a.inTenant(s.c, (tx) =>
      tx.auditLog.findMany({
        where: { action: 'maintenance_case.opened', targetId: c.id },
      }),
    );
    expect(opened).toHaveLength(1);
    expect(opened[0].metadata).toMatchObject({
      categoryKey: 'plumbing',
      ticketCount: 2,
      by: 'threshold',
    });
  });

  describe('an open case', () => {
    let tower: string;
    let caseId: string;

    beforeAll(async () => {
      tower = `Tower ${uniqueSuffix()}`;
      await report(await household(tower)).expect(201);
      await report(await household(tower)).expect(201);
      caseId = (await casesOf(tower))[0].id;
    });

    it('takes the next ticket of its category and building', async () => {
      const z = await household(tower);
      const id = ((await report(z).expect(201)).body as { id: string }).id;
      const c = await detail(caseId);
      expect(c.ticketCount).toBe(3);
      expect(c.tickets.map((t) => t.id)).toContain(id);
      expect(await casesOf(tower)).toHaveLength(1);
    });

    it('lists by status and building', async () => {
      const res = await a
        .http(
          'get',
          `/maintenance/cases?status=open&buildingId=${(await casesOf(tower))[0].buildingId}`,
          s.supervisor.token,
        )
        .expect(200);
      expect(
        (res.body as { data: { id: string }[] }).data.map((c) => c.id),
      ).toEqual([caseId]);
    });

    it('a sensitive ticket of it shows, and counts, only for the holders', async () => {
      const c = await detail(caseId);
      const one = c.tickets[0].id;
      await a
        .http(
          'put',
          `/maintenance/tickets/${one}/sensitivity`,
          s.manager.token,
          {
            sensitive: true,
            reasonCode: 'resident_privacy',
          },
        )
        .expect(204);
      const seen = await detail(caseId);
      expect(seen.tickets.map((t) => t.id)).not.toContain(one);
      expect(seen.ticketCount).toBe(c.ticketCount - 1);
      expect(
        (await detail(caseId, s.manager.token)).tickets.map((t) => t.id),
      ).toContain(one);
    });

    it('two work orders for it at once: one is its own, the other MAINTENANCE_CASE_HAS_WORK_ORDER', async () => {
      const area = await a.area(s, { kind: 'area' });
      const open = () =>
        a.http('post', '/maintenance/work-orders', s.supervisor.token, {
          commonAreaId: area.id,
          categoryId: plumbing,
          caseId,
          description: 'Check the riser',
        });
      const both = await Promise.all([open(), open()]);
      expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
      const lost = both.find((r) => r.status === 409)!;
      expect((lost.body as Body).code).toBe('MAINTENANCE_CASE_HAS_WORK_ORDER');
      const won = (both.find((r) => r.status === 201)!.body as { id: string })
        .id;
      expect((await detail(caseId)).workOrder?.id).toBe(won);
      const entry = await a.inTenant(s.c, (tx) =>
        tx.auditLog.findFirstOrThrow({
          where: { action: 'ticket.work_order_opened', targetId: won },
        }),
      );
      expect(entry.metadata).toMatchObject({ maintenanceCaseId: caseId });
    });

    it('resolved with a code, its reporters are told; closed once', async () => {
      const bad = await a
        .http(
          'post',
          `/maintenance/cases/${caseId}/resolve`,
          s.supervisor.token,
          {
            reasonCode: 'not_related',
          },
        )
        .expect(400);
      expect((bad.body as Body).code).toBe('VALIDATION_FAILED');
      const done = (
        await a
          .http(
            'post',
            `/maintenance/cases/${caseId}/resolve`,
            s.supervisor.token,
            {
              reasonCode: 'fixed',
            },
          )
          .expect(201)
      ).body as CaseBody;
      expect(done.status).toBe('resolved');
      const told = await a.inTenant(s.c, (tx) =>
        tx.notification.count({ where: { kind: 'ticket.case_resolved' } }),
      );
      expect(told).toBeGreaterThanOrEqual(3);
      const again = await a
        .http(
          'post',
          `/maintenance/cases/${caseId}/dismiss`,
          s.supervisor.token,
          {
            reasonCode: 'not_related',
          },
        )
        .expect(409);
      expect(again.body as Body).toMatchObject({
        code: 'MAINTENANCE_CASE_CLOSED',
        params: { status: 'resolved' },
      });
    });

    it('once closed, the next tickets count afresh: none joins the closed case', async () => {
      await report(await household(tower)).expect(201);
      const cases = await casesOf(tower);
      expect(cases.filter((c) => c.status === 'open')).toEqual([]);
      await report(await household(tower)).expect(201);
      const reopened = (await casesOf(tower)).filter(
        (c) => c.status === 'open',
      );
      expect(reopened).toHaveLength(1);
      expect(reopened[0].id).not.toBe(caseId);
    });
  });

  it('dismissed with a code; the residents are not told', async () => {
    const tower = `Tower ${uniqueSuffix()}`;
    await report(await household(tower)).expect(201);
    await report(await household(tower)).expect(201);
    const [c] = await casesOf(tower);
    const before = await a.inTenant(s.c, (tx) =>
      tx.notification.count({ where: { kind: 'ticket.case_resolved' } }),
    );
    await a
      .http('post', `/maintenance/cases/${c.id}/dismiss`, s.supervisor.token, {
        reasonCode: 'isolated_faults',
      })
      .expect(201);
    expect(
      await a.inTenant(s.c, (tx) =>
        tx.notification.count({ where: { kind: 'ticket.case_resolved' } }),
      ),
    ).toBe(before);
  });

  it('the technician may not read cases', async () => {
    await a.http('get', '/maintenance/cases', s.techs[0].token).expect(403);
  });
});

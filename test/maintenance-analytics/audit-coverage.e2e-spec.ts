import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { addDays } from '../../src/maintenance/schedules/local-dates';
import { auditReaders } from '../setup/audit';
import { assetHelpers, type AssetSetUp } from '../setup/assets';
import { M213_COVERAGE } from '../setup/audit-coverage-split';
import { today } from '../setup/compound-clock';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const MARKER = 'AUDIT-m213-secret';

/**
 * One scenario per entry of the maintenance analytics' catalog (ADR 0014,
 * 0081): actor, target and metadata — codes, ids and counts, never staff's
 * or residents' words.
 */
const covered = new Set<string>();

describe('Audit coverage — maintenance analytics and cases', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof assetHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: AssetSetUp;
  let plumbing: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = assetHelpers(h);
    read = auditReaders(h);
    s = await a.setUp(1);
    plumbing = await a.categoryId(s.c, 'plumbing');
  }, 180_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const rows = await read.tenant(s.c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(MARKER);
    covered.add(action);
    return rows[0];
  }

  it('ticket.sensitivity_changed — sensitive, the code and the origin', async () => {
    const id = await a.openTicket(s);
    await a
      .http('put', `/maintenance/tickets/${id}/sensitivity`, s.manager.token, {
        sensitive: true,
        reasonCode: 'legal',
      })
      .expect(204);
    expect((await single('ticket.sensitivity_changed', id)).metadata).toEqual({
      sensitive: true,
      reasonCode: 'legal',
      origin: 'resident',
    });
  });

  it('maintenance.analytics_settings_changed — each number, from and to', async () => {
    await a
      .http('patch', '/maintenance/settings/analytics', s.manager.token, {
        recurrenceMinTickets: 2,
        caseMinTickets: 2,
      })
      .expect(200);
    expect(
      (await single('maintenance.analytics_settings_changed', s.c.tenantId))
        .changes,
    ).toEqual({
      recurrenceMinTickets: { from: 3, to: 2 },
      caseMinTickets: { from: 3, to: 2 },
    });
  });

  describe('plan suggestions', () => {
    async function suggestion(): Promise<{ id: string; assetId: string }> {
      const assetId = await a.asset(s);
      for (let i = 0; i < 2; i++)
        await a
          .http('post', '/maintenance/work-orders', s.supervisor.token, {
            assetId,
            categoryId: plumbing,
            description: `${MARKER} seal`,
          })
          .expect(201);
      const row = await a.inTenant(s.c, (tx) =>
        tx.maintenancePlanSuggestion.findFirstOrThrow({ where: { assetId } }),
      );
      return { id: row.id, assetId };
    }

    it('plan_suggestion.accepted — the plan, whether made for it, the count', async () => {
      const { id, assetId } = await suggestion();
      const res = await a
        .http(
          'post',
          `/maintenance/plan-suggestions/${id}/accept`,
          s.manager.token,
          {
            plan: {
              assetId,
              title: `${MARKER} check`,
              trigger: 'calendar',
              every: 1,
              unit: 'month',
              anchorOn: addDays(today(), 7),
            },
          },
        )
        .expect(201);
      const planId = (res.body as { planId: string }).planId;
      expect((await single('plan_suggestion.accepted', id)).metadata).toEqual({
        planId,
        planCreated: true,
        ticketCount: 2,
      });
    });

    it('plan_suggestion.dismissed — the code', async () => {
      const { id } = await suggestion();
      await a
        .http(
          'post',
          `/maintenance/plan-suggestions/${id}/dismiss`,
          s.manager.token,
          { reasonCode: 'already_planned' },
        )
        .expect(201);
      expect((await single('plan_suggestion.dismissed', id)).metadata).toEqual({
        reasonCode: 'already_planned',
      });
    });
  });

  describe('community cases', () => {
    async function opened(): Promise<string> {
      const building = `Tower ${uniqueSuffix()}`;
      for (let i = 0; i < 2; i++) {
        const unit = await a.x.unit(s.c, `AC-${uniqueSuffix()}`);
        await a.inTenant(s.c, (tx) =>
          tx.unit.update({ where: { id: unit.id }, data: { building } }),
        );
        const owner = await a.x.resident(s.c, [unit.id]);
        const token = await h.tokenFor({
          sub: owner.id,
          tid: s.c.tenantId,
          typ: 'resident',
        });
        await a
          .http('post', '/tickets', token, {
            unitId: unit.id,
            categoryId: plumbing,
            description: `${MARKER} pressure`,
          })
          .expect(201);
      }
      return a.inTenant(
        s.c,
        async (tx) =>
          (
            await tx.maintenanceCase.findFirstOrThrow({
              where: {
                status: 'open',
                buildingId: (
                  await tx.building.findFirstOrThrow({
                    where: { name: building },
                  })
                ).id,
              },
            })
          ).id,
      );
    }

    it('maintenance_case.opened — the category, the building, the count, the ticket that tipped it', async () => {
      const id = await opened();
      const row = await single('maintenance_case.opened', id);
      expect(row.metadata).toMatchObject({
        categoryKey: 'plumbing',
        ticketCount: 2,
        by: 'threshold',
      });
      expect(Object.keys(row.metadata as object).sort()).toEqual(
        ['buildingId', 'by', 'categoryKey', 'ticketCount', 'ticketId'].sort(),
      );
    });

    it('maintenance_case.resolved — the code and the count', async () => {
      const id = await opened();
      await a
        .http('post', `/maintenance/cases/${id}/resolve`, s.supervisor.token, {
          reasonCode: 'work_planned',
        })
        .expect(201);
      expect((await single('maintenance_case.resolved', id)).metadata).toEqual({
        reasonCode: 'work_planned',
        ticketCount: 2,
      });
    });

    it('maintenance_case.dismissed — the code and the count', async () => {
      const id = await opened();
      await a
        .http('post', `/maintenance/cases/${id}/dismiss`, s.supervisor.token, {
          reasonCode: 'raised_in_error',
        })
        .expect(201);
      expect((await single('maintenance_case.dismissed', id)).metadata).toEqual(
        { reasonCode: 'raised_in_error', ticketCount: 2 },
      );
    });
  });

  describe('catalog completeness', () => {
    it('every entry of the maintenance analytics has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of M213_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...M213_COVERAGE].sort());
    });
  });
});

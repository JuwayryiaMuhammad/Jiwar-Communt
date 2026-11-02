import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { SLA_AT_RISK_SWEEP } from '../../src/maintenance/sla/sla-at-risk';
import { SlaSweep } from '../../src/maintenance/sla/sla-sweep';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { rewind, slaClocks } from '../setup/sla';

/** An answer's body, as the assertions read it. */
type Body = {
  code: string;
  fields: { field: string; code: string }[];
  [key: string]: unknown;
};

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;

const AT_RISK = ['ticket.sla_at_risk', 'ticket.sla_at_risk_emergency'];

/**
 * ADR 0076: the SLA's escalation levels. A running clock that used its
 * compound's share of its target at the ticket's priority (75 % by
 * default, 50–95 or none) is at risk: its technician and the dispatch are
 * told once per clock and cycle; the breach still tells the dispatch and
 * the managers (ADR 0034).
 */
describe('Dispatch depth — the SLA’s escalation levels', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
    await d
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
  }, 180_000);

  afterAll(() => h.close());

  const sweep = (now = new Date()) =>
    h.moduleRef.get(SweepRunner).run(SLA_AT_RISK_SWEEP, now);

  async function assigned(priority?: 'emergency'): Promise<string> {
    const id = await d.openTicket(s, priority ? { priority } : {});
    await d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: s.techs[0].id,
      })
      .expect(204);
    return id;
  }

  /** Moves the ticket `share` of its response target into the past. */
  async function used(id: string, share: number) {
    const response = (await slaClocks(id)).find(
      (c) => c.clock === 'response' && c.cycle === 1,
    )!;
    await rewind(id, Math.ceil(response.targetMinutes * share));
  }

  const warned = (accountId: string, ticketId: string) =>
    d.inTenant(s.c, (tx) =>
      tx.notification.findMany({
        where: { accountId, targetId: ticketId, kind: { in: AT_RISK } },
        select: { kind: true, params: true },
      }),
    );

  it('is 75 % at every priority until the manager says otherwise', async () => {
    const res = await d
      .http('get', '/maintenance/sla-settings', s.manager.token)
      .expect(200);
    expect((res.body as Body).atRiskPercent).toEqual({
      normal: 75,
      urgent: 75,
      emergency: 75,
    });
  });

  it('past the share: the technician and the dispatch are told once, the clock named', async () => {
    const id = await assigned();
    await used(id, 0.8);
    await sweep();
    await sweep();
    for (const who of [s.techs[0].id, s.supervisor.id])
      expect(await warned(who, id)).toEqual([
        {
          kind: 'ticket.sla_at_risk',
          params: expect.objectContaining({ clock: 'response' }) as unknown,
        },
      ]);
    expect(await warned(s.owner.id, id)).toEqual([]);
    const alerts = await d.inTenant(s.c, (tx) =>
      tx.ticketSlaAlert.findMany({ where: { ticketId: id } }),
    );
    expect(alerts.map((a) => [a.clock, a.level])).toContainEqual([
      'response',
      'at_risk',
    ]);
  });

  it('before the share, nothing', async () => {
    const id = await assigned();
    await used(id, 0.5);
    await sweep();
    expect(await warned(s.supervisor.id, id)).toEqual([]);
  });

  it('an emergency’s warning is critical', async () => {
    const id = await assigned('emergency');
    await used(id, 0.8);
    await sweep();
    expect((await warned(s.supervisor.id, id)).map((n) => n.kind)).toContain(
      'ticket.sla_at_risk_emergency',
    );
  });

  it('a share turned off warns of nothing at that priority; the change is audited by priority', async () => {
    await d
      .http('patch', '/maintenance/sla-settings/escalation', s.manager.token, {
        normal: null,
        urgent: 90,
      })
      .expect(200)
      .expect((r) =>
        expect((r.body as Body).atRiskPercent).toEqual({
          normal: null,
          urgent: 90,
          emergency: 75,
        }),
      );
    const audit = await d.inTenant(s.c, (tx) =>
      tx.auditLog.findFirstOrThrow({
        where: { action: 'maintenance.sla_escalation_changed' },
        orderBy: { occurredAt: 'desc' },
      }),
    );
    expect(audit.changes).toEqual({
      normal: { from: 75, to: null },
      urgent: { from: 75, to: 90 },
    });
    const id = await assigned();
    await used(id, 0.9);
    await sweep();
    expect(await warned(s.supervisor.id, id)).toEqual([]);
    await d
      .http('patch', '/maintenance/sla-settings/escalation', s.manager.token, {
        normal: 75,
      })
      .expect(200);
  });

  it('refuses a share outside 50–95, and is the manager’s', async () => {
    const res = await d
      .http('patch', '/maintenance/sla-settings/escalation', s.manager.token, {
        emergency: 40,
      })
      .expect(400);
    expect((res.body as Body).fields).toEqual([
      {
        field: 'emergency',
        code: 'INVALID_NUMBER',
        params: { min: 50, max: 95 },
      },
    ]);
    await d
      .http(
        'patch',
        '/maintenance/sla-settings/escalation',
        s.supervisor.token,
        {
          normal: 60,
        },
      )
      .expect(403);
  });

  it('race: two sweeps at once warn once', async () => {
    const id = await assigned();
    await used(id, 0.85);
    await Promise.all([sweep(), sweep()]);
    expect(await warned(s.supervisor.id, id)).toHaveLength(1);
  });
});

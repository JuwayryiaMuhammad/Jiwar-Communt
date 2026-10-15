import {
  EMERGENCY_ESCALATION_SWEEP,
  ESCALATION_INTERVAL_MS,
} from '../../src/gate/emergencies/emergency-escalation';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { safetyHelpers, type Who } from '../setup/safety';
import { rewindEmergency } from '../setup/safety-rows';

const MIN = 60_000;

/**
 * ADR 0047: an emergency nobody accepts within two minutes goes to the
 * management, once — a critical push to every `emergencies.manage` holder
 * and an audit row with how many were told. An accepted one never does; an
 * escalated one can still be accepted. The sweep runs every 30 seconds.
 * Reports are moved into the past (their own rows only), so the sweep runs
 * at the real time and touches nothing of other suites.
 */
describe('Emergencies — escalation', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof safetyHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof safetyHelpers>['setUp']>>;
  let guard: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = safetyHelpers(h);
    s = await x.setUp('Escalation Court');
    guard = await x.guardOnDuty(s.c);
  }, 120_000);

  afterAll(() => h.close());

  const sweep = () => x.sweep(EMERGENCY_ESCALATION_SWEEP);
  const row = (id: string) =>
    x.inTx(s.c, (tx) => tx.emergency.findUniqueOrThrow({ where: { id } }));
  async function unanswered(minutesAgo: number) {
    const home = await x.unit(s.c);
    const owner = await x.owner(s.c, home.id);
    const e = await x.report(owner, home.id, 'medical');
    await rewindEmergency(e.id, minutesAgo * MIN);
    return { owner, e };
  }

  it('runs every thirty seconds', () => {
    expect(
      h.moduleRef.get(SweepRunner).intervalOf(EMERGENCY_ESCALATION_SWEEP),
    ).toBe(ESCALATION_INTERVAL_MS);
  });

  it('two minutes without an answer: the management is told, once; the household sees it', async () => {
    const { owner, e } = await unanswered(2.1);
    const fresh = await unanswered(1.5);
    await sweep();
    await sweep();
    expect(await x.told(s.c, s.manager.id, e.id)).toEqual([
      { kind: 'emergency.escalated', params: { emergencyType: 'medical' } },
    ]);
    // The guard who could have answered is not told again.
    expect((await x.told(s.c, guard.id, e.id)).map((n) => n.kind)).toEqual([
      'emergency.reported',
    ]);
    expect(await x.told(s.c, s.manager.id, fresh.e.id)).toEqual([]);
    expect((await row(fresh.e.id)).escalatedAt).toBeNull();
    const seen = await x.follow(owner, e.id);
    expect(seen.timeline.map((t) => t.step)).toEqual([
      'reported',
      'security_notified',
      'management_notified',
    ]);
    const rows = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'emergency.escalated',
      targetId: e.id,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: 'system' });
    expect(rows[0].metadata).toEqual({ reason: 'timeout', recipients: 1 });
  });

  it('an accepted one is never escalated; an escalated one can still be accepted', async () => {
    const accepted = await unanswered(5);
    await x
      .http('post', `/gate/emergencies/${accepted.e.id}/accept`, guard.token, {
        etaMinutes: 5,
      })
      .expect(200);
    const late = await unanswered(3);
    await sweep();
    expect((await row(accepted.e.id)).escalatedAt).toBeNull();
    expect((await row(late.e.id)).escalationReason).toBe('timeout');
    await x
      .http('post', `/gate/emergencies/${late.e.id}/accept`, guard.token, {
        etaMinutes: 2,
      })
      .expect(200);
    // Cancelled now, the responder is told (the management was told before).
    await x
      .http('post', `/emergencies/${late.e.id}/cancel`, late.owner.token, {})
      .expect(200);
    expect((await x.told(s.c, guard.id, late.e.id)).map((n) => n.kind)).toEqual(
      ['emergency.reported', 'emergency.cancelled'],
    );
  });

  it('cancelled after escalation with nobody on the way: the management is told too', async () => {
    const { owner, e } = await unanswered(4);
    await sweep();
    await x
      .http('post', `/emergencies/${e.id}/cancel`, owner.token, {})
      .expect(200);
    expect((await x.told(s.c, s.manager.id, e.id)).map((n) => n.kind)).toEqual([
      'emergency.escalated',
      'emergency.cancelled',
    ]);
  });

  it('two sweeps at once escalate once', async () => {
    const { e } = await unanswered(3);
    await Promise.all([sweep(), sweep(), sweep()]);
    expect(await x.told(s.c, s.manager.id, e.id)).toHaveLength(1);
    expect(
      await auditReaders(h).tenant(s.c.tenantId, {
        action: 'emergency.escalated',
        targetId: e.id,
      }),
    ).toHaveLength(1);
  });

  it('an accept racing the sweep: never escalated after it was accepted', async () => {
    for (let round = 0; round < 3; round++) {
      const { e } = await unanswered(3);
      const [acc] = await Promise.all([
        x.http('post', `/gate/emergencies/${e.id}/accept`, guard.token, {
          etaMinutes: 5,
        }),
        sweep(),
      ]);
      expect(acc.status).toBe(200);
      const r = await row(e.id);
      if (r.escalatedAt)
        expect(r.escalatedAt.getTime()).toBeLessThanOrEqual(
          r.acceptedAt!.getTime(),
        );
    }
  });
});

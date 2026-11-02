import { HELP_ESCALATION_SWEEP } from '../../src/maintenance/help/help-requests.service';
import { fieldTeamHelpers } from '../setup/field-team';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const MINUTE = 60_000;

/**
 * ADR 0078: two calls at once, two takers, a taking against a call-off
 * and against the escalation sweep. One live call per technician (their
 * help lock); every write takes the call's row; the sweep takes it with
 * SKIP LOCKED and judges again.
 */
describe('A technician’s call for help — concurrency', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof fieldTeamHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof fieldTeamHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = fieldTeamHelpers(h);
    s = await x.setUp('Field Help Race Court');
  }, 120_000);

  afterAll(() => h.close());

  const call = (token: string) =>
    x.http('post', '/maintenance/help-requests', token, {
      kind: 'extra_hands',
    });
  const take = (token: string, id: string) =>
    x.http('post', `/staff/field-team/help-requests/${id}/take`, token, {});

  it('two calls at once: one is made, the other refused as live', async () => {
    for (let i = 0; i < 5; i++) {
      const tech = await x.technician(s.c);
      const res = await Promise.all([call(tech.token), call(tech.token)]);
      expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
      const live = await x.v.inTx(s.c, (tx) =>
        tx.technicianHelpRequest.count({ where: { requesterId: tech.id } }),
      );
      expect(live).toBe(1);
    }
  });

  it('two takers: one takes it, the other is refused', async () => {
    for (let i = 0; i < 5; i++) {
      const tech = await x.technician(s.c);
      const id = ((await call(tech.token).expect(201)).body as { id: string })
        .id;
      const res = await Promise.all([
        take(s.boss.token, id),
        take(s.manager.token, id),
      ]);
      expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(
        (await x.told(s.c, tech.id, id)).filter(
          (t) => t.kind === 'technician_help.taken',
        ),
      ).toHaveLength(1);
    }
  });

  it('a taking against a call-off: one wins', async () => {
    for (let i = 0; i < 5; i++) {
      const tech = await x.technician(s.c);
      const id = ((await call(tech.token).expect(201)).body as { id: string })
        .id;
      const [taken, cancelled] = await Promise.all([
        take(s.boss.token, id),
        x.http('post', `/maintenance/help-requests/${id}/cancel`, tech.token),
      ]);
      const row = await x.v.inTx(s.c, (tx) =>
        tx.technicianHelpRequest.findUniqueOrThrow({ where: { id } }),
      );
      // A call-off may follow a taking: both may answer 200.
      expect(row.status).toBe(cancelled.status === 200 ? 'cancelled' : 'taken');
      expect([200, 409]).toContain(taken.status);
    }
  });

  it('a taking against the escalation sweep: escalated at most once, never after it was taken', async () => {
    for (let i = 0; i < 5; i++) {
      const tech = await x.technician(s.c);
      const id = ((await call(tech.token).expect(201)).body as { id: string })
        .id;
      const [taken] = await Promise.all([
        take(s.boss.token, id),
        x.sweep(HELP_ESCALATION_SWEEP, new Date(Date.now() + 16 * MINUTE)),
      ]);
      expect(taken.status).toBe(200);
      const row = await x.v.inTx(s.c, (tx) =>
        tx.technicianHelpRequest.findUniqueOrThrow({ where: { id } }),
      );
      const escalated = (await x.told(s.c, s.c.managerId, id)).filter(
        (t) => t.kind === 'technician_help.escalated',
      );
      expect(escalated).toHaveLength(row.escalatedAt ? 1 : 0);
      if (row.escalatedAt)
        expect(row.escalatedAt.getTime()).toBeLessThanOrEqual(
          row.takenAt!.getTime(),
        );
    }
  });
});

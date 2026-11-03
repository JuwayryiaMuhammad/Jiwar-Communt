import { err } from '../api/request';
import { dbClock, day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityOpsHelpers } from '../setup/security-ops';

interface SafetyBody {
  from: string;
  to: string;
  incidents: Record<string, number | string | null>;
  observations: Record<string, number | null>;
  actions: Record<string, number | null>;
  drills: Record<string, number | null>;
}

/**
 * ADR 0087: the safety KPIs over the compound's days (30 by default, 366
 * at most), aggregated in SQL — the safety incidents and the last injury,
 * the observations' closure rate, the corrective actions and the drills —
 * and drills as a readiness item kind, done with their outcome and
 * headcount. The incidents report covers a year too.
 */
describe('Safety KPIs and drills (ADR 0087)', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Safety KPI Court');
  }, 180_000);

  afterAll(() => h.close());

  const m = () => s.manager.token;
  const incident = async (type: string) =>
    (
      await x
        .http('post', '/staff/security/incidents', m(), {
          type,
          severity: 'low',
          unitCode: s.home.code,
          occurredAt: new Date(dbClock().getTime() - 60_000).toISOString(),
          description: 'Seen on the round',
        })
        .expect(201)
    ).body as { id: string };
  const kpis = async (q = '') =>
    (await x.http('get', `/staff/security/reports/safety${q}`, m()).expect(200))
      .body as SafetyBody;

  it('a drill: its type on making it, its outcome and headcount on its done; no other kind takes them', async () => {
    const program = (
      await x
        .http('post', '/maintenance/readiness/programs', m(), {
          kind: 'emergency',
          title: 'Fire readiness',
          startsOn: day(0),
          endsOn: day(30),
        })
        .expect(201)
    ).body as { id: string };
    const item = (path: string, body: object) =>
      x.http(
        'post',
        `/maintenance/readiness/programs/${program.id}/items`,
        m(),
        {
          title: path,
          ownerId: s.manager.id,
          dueOn: day(0),
          ...body,
        },
      );
    expect(
      err(await item('No type', { kind: 'drill' }).expect(400)).fields,
    ).toEqual([{ field: 'drillType', code: 'FIELD_REQUIRED' }]);
    expect(
      err(await item('A task', { kind: 'task', drillType: 'fire' }).expect(400))
        .fields,
    ).toEqual([{ field: 'drillType', code: 'FIELD_NOT_ALLOWED' }]);
    const drill = (
      await item('Evacuation drill', {
        kind: 'drill',
        drillType: 'evacuation',
      }).expect(201)
    ).body as { id: string; drillType: string };
    expect(drill.drillType).toBe('evacuation');
    const done = (id: string, body: object) =>
      x.http('post', `/maintenance/readiness/items/${id}/done`, m(), body);
    expect(err(await done(drill.id, {}).expect(400)).fields).toEqual([
      { field: 'outcome', code: 'FIELD_REQUIRED' },
      { field: 'participants', code: 'FIELD_REQUIRED' },
    ]);
    const ended = (
      await done(drill.id, {
        outcome: 'issues_found',
        participants: 42,
        minutes: 9,
      }).expect(200)
    ).body as Record<string, unknown>;
    expect(ended).toMatchObject({
      state: 'done',
      drillOutcome: 'issues_found',
      drillParticipants: 42,
      drillMinutes: 9,
    });
    const task = (await item('A task', { kind: 'task' }).expect(201)).body as {
      id: string;
    };
    expect(
      err(await done(task.id, { outcome: 'passed' }).expect(400)).fields,
    ).toEqual([{ field: 'outcome', code: 'FIELD_NOT_ALLOWED' }]);
  });

  it('counts the period’s safety incidents, the observations’ closure, the actions and the drills', async () => {
    const before = await kpis();
    const injury = await incident('injury');
    const hazard = await incident('hazard');
    await incident('near_miss');
    await incident('security_breach');
    await x
      .http('post', `/staff/security/incidents/${hazard.id}/close`, m(), {
        reasonCode: 'resolved',
        note: 'Fixed',
      })
      .expect(200);
    const action = (
      await x
        .http('post', `/staff/security/incidents/${injury.id}/actions`, m(), {
          description: 'A handrail on the stairs',
          ownerId: s.manager.id,
          dueOn: day(3),
        })
        .expect(201)
    ).body as { id: string };
    await x
      .http(
        'post',
        `/staff/security/incident-actions/${action.id}/done`,
        m(),
        {},
      )
      .expect(200);
    const after = await kpis();
    const delta = (k: keyof SafetyBody, f: string) =>
      (after[k] as Record<string, number>)[f] -
      (before[k] as Record<string, number>)[f];
    expect(delta('incidents', 'reported')).toBe(3);
    expect(delta('incidents', 'injuries')).toBe(1);
    expect(delta('incidents', 'nearMisses')).toBe(1);
    expect(delta('incidents', 'hazards')).toBe(1);
    expect(after.incidents.lastInjuryOn).toBe(day(0));
    expect(after.incidents.daysWithoutInjury).toBe(0);
    expect(delta('observations', 'reported')).toBe(2);
    expect(delta('observations', 'closed')).toBe(1);
    expect(after.observations.closureRatePct).toBe(
      Math.floor(
        ((after.observations.closed as number) * 100) /
          (after.observations.reported as number),
      ),
    );
    expect(delta('actions', 'opened')).toBe(1);
    expect(delta('actions', 'done')).toBe(1);
    expect(delta('actions', 'doneOnTime')).toBe(1);
    expect(after.drills).toMatchObject({
      held: 1,
      issuesFound: 1,
      participants: 42,
    });
  });

  it('a year at most, for the KPIs and the incidents report; the violations report keeps 31 days', async () => {
    await kpis(`?from=${day(-365)}&to=${day(0)}`);
    expect(
      err(
        await x
          .http(
            'get',
            `/staff/security/reports/safety?from=${day(-366)}&to=${day(0)}`,
            m(),
          )
          .expect(400),
      ).fields,
    ).toEqual([
      { field: 'to', code: 'PERIOD_TOO_LONG', params: { maxDays: 366 } },
    ]);
    await x
      .http(
        'get',
        `/staff/security/reports/incidents?from=${day(-365)}&to=${day(0)}`,
        m(),
      )
      .expect(200);
  });

  it('read by the incidents’ keepers and the guards’ reports; a guard is refused; no-store', async () => {
    const guard = await x.v.who(s.c, (await x.g.guard(s.c)).id, 'staff');
    await x
      .http('get', '/staff/security/reports/safety', guard.token)
      .expect(403);
    const supervisor = await x.supervisor(s.c);
    const res = await x
      .http('get', '/staff/security/reports/safety', supervisor.token)
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

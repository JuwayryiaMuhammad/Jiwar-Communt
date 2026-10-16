import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityHelpers, type Who } from '../setup/security';

interface Section {
  data: { id: string }[];
  total: number;
}
interface WorkBody {
  onShift: boolean;
  tasks: Section;
  gateServiceQueue: Section | null;
  myGateServices: Section | null;
  parkingReports: Section | null;
}

/**
 * ADR 0050: a guard's work in one place — the guards' tasks, the gate
 * services residents asked for (ADR 0047) and the wrong-parking reports
 * (ADR 0045) — as their own routes show them. The guard role closes
 * parking reports; turning one into a fine stays `fines.issue`.
 */
describe('My work', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityHelpers>['setUp']>>;
  let supervisor: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityHelpers(h);
    s = await x.setUp('My Work Court');
    supervisor = await x.supervisor(s.c);
  }, 120_000);

  afterAll(() => h.close());

  const work = async (as: Who) =>
    (await x.http('get', '/gate/my-work', as.token).expect(200))
      .body as WorkBody;
  const ids = (section: Section | null) => section?.data.map((d) => d.id);

  it('off shift: my own tasks and the parking reports; no gate services', async () => {
    const guard = await x.guard(s.c);
    const mine = (
      await x
        .http('post', '/staff/security/tasks', supervisor.token, {
          kind: 'custom',
          title: 'Mine',
          guardId: guard.id,
        })
        .expect(201)
    ).body as { id: string };
    const w = await work(guard);
    expect(w.onShift).toBe(false);
    expect(ids(w.tasks)).toEqual([mine.id]);
    expect(w.tasks.total).toBe(1);
    expect(w.gateServiceQueue).toBeNull();
    expect(w.myGateServices).toBeNull();
    expect(w.parkingReports).not.toBeNull();
  });

  it('on shift: my post’s tasks, the open requests and mine, the open reports — each acted on through its own routes', async () => {
    const gateId = (await x.g.gate(s.c)).id;
    const guard = await x.guard(s.c);
    await x.start(guard, { gateId });
    const post = (
      await x
        .http('post', '/staff/security/tasks', supervisor.token, {
          kind: 'custom',
          title: 'The gate’s',
          gateId,
        })
        .expect(201)
    ).body as { id: string };
    const places = await x.places(s.alice);
    const escort = (
      await x
        .http('post', '/escort-requests', s.alice.token, {
          unitId: s.home.id,
          fromPlaceId: places.main_gate.id,
          toPlaceId: places.clubhouse.id,
          when: 'now',
        })
        .expect(201)
    ).body as { id: string };
    const report = (
      await x
        .http('post', '/parking-reports', s.alice.token, {
          plate: 'ABC 123',
          location: 'Visitor area B',
        })
        .expect(201)
    ).body as { id: string };

    let w = await work(guard);
    expect(w.onShift).toBe(true);
    expect(ids(w.tasks)).toContain(post.id);
    expect(ids(w.gateServiceQueue)).toContain(escort.id);
    expect(ids(w.myGateServices)).toEqual([]);
    expect(ids(w.parkingReports)).toContain(report.id);
    expect(w.parkingReports!.total).toBeGreaterThanOrEqual(1);

    await x
      .http('post', `/gate/gate-services/${escort.id}/accept`, guard.token, {
        etaMinutes: 5,
      })
      .expect(200);
    w = await work(guard);
    expect(ids(w.gateServiceQueue)).not.toContain(escort.id);
    expect(ids(w.myGateServices)).toEqual([escort.id]);

    // The guard closes a report; a fine is not theirs to issue.
    expect(
      (
        await x.http(
          'post',
          `/staff/parking-reports/${report.id}/convert`,
          guard.token,
          {},
        )
      ).status,
    ).toBe(403);
    await x
      .http('post', `/staff/parking-reports/${report.id}/close`, guard.token, {
        reasonCode: 'resolved',
      })
      .expect(200);
    w = await work(guard);
    expect(ids(w.parkingReports)).not.toContain(report.id);
    await x.endRaw(guard).expect(200);
  });

  it('without parking_reports.handle there are no reports to show', async () => {
    const narrow = await x.staff(s.c, ['gate.operate']);
    const w = await work(narrow);
    expect(w.parkingReports).toBeNull();
  });
});

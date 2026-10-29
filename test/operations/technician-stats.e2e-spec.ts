import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { operationsHelpers, type OperationsSetUp } from '../setup/operations';

interface Stats {
  technicianId: string;
  completed: number;
  meanHoursToComplete: number | null;
  sentBack: number;
  ratings: number;
  meanRating: number | null;
  inHand: number;
}

/**
 * ADR 0065: how a technician works — completions, time to complete, what
 * came back, the SLA met, the residents' ratings averaged only from three
 * — read by the technician for themselves and by dispatch for everyone.
 */
describe('Operations — technician performance', () => {
  let h: HttpHarness;
  let o: ReturnType<typeof operationsHelpers>;
  let s: OperationsSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    o = operationsHelpers(h);
    s = await o.setUp(2);
  }, 90_000);

  afterAll(() => h.close());

  const done = async (tech = 0) => {
    const id = await o.startedTicket(s, tech);
    await o
      .http('post', `/technician/tickets/${id}/complete`, s.techs[tech].token)
      .expect(204);
    return id;
  };
  const confirm = (id: string, technicianRating: number) =>
    o
      .http('post', `/tickets/${id}/confirm`, s.owner.token, {
        rating: 5,
        technicianRating,
      })
      .expect(204);
  const mine = async (tech = 0) =>
    (
      await o
        .http(
          'get',
          `/technician/stats?from=${day(-1)}&to=${day(0)}`,
          s.techs[tech].token,
        )
        .expect(200)
    ).body as Stats;

  it('completions, what came back and the time it took; ratings averaged only from three', async () => {
    const one = await done();
    const two = await done();
    await confirm(one, 4);
    await confirm(two, 2);
    const rejected = await done();
    await o
      .http('post', `/tickets/${rejected}/reject`, s.owner.token, {
        reasonCode: 'not_fixed',
        reason: 'Still leaking',
      })
      .expect(204);
    await o.startedTicket(s);
    let stats = await mine();
    expect(stats).toMatchObject({
      technicianId: s.techs[0].id,
      completed: 3,
      sentBack: 1,
      ratings: 2,
      // Two ratings would point at the residents who gave them.
      meanRating: null,
    });
    expect(stats.meanHoursToComplete).not.toBeNull();
    expect(stats.inHand).toBeGreaterThanOrEqual(2);
    await confirm(await done(), 3);
    stats = await mine();
    expect(stats).toMatchObject({ ratings: 3, meanRating: 3 });
  });

  it('dispatch reads everyone’s and one’s; a technician only their own', async () => {
    await done(1);
    const all = (
      await o
        .http('get', '/maintenance/technicians/stats', s.supervisor.token)
        .expect(200)
    ).body as { data: Stats[] };
    const ids = all.data.map((x) => x.technicianId);
    expect(ids).toEqual(
      expect.arrayContaining([s.techs[0].id, s.techs[1].id]) as unknown,
    );
    const second = (
      await o
        .http(
          'get',
          `/maintenance/technicians/${s.techs[1].id}/stats`,
          s.supervisor.token,
        )
        .expect(200)
    ).body as Stats;
    expect(second.completed).toBe(1);
    await o
      .http('get', '/maintenance/technicians/stats', s.techs[0].token)
      .expect(403);
    await o
      .http(
        'get',
        `/maintenance/technicians/${s.owner.id}/stats`,
        s.supervisor.token,
      )
      .expect(404);
  });
});

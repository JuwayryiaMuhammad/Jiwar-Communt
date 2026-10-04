import { DRAIN_BATCH } from '../../src/maintenance/dispatch/dispatch-sweep';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0033: turning automatic dispatch on starts a bounded pass over the
 * queue, after the change committed and one transaction per ticket, so
 * enabling has an effect at once instead of at the next sweep.
 */
describe('Dispatch — turning it on drains the queue', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  type Setup = Awaited<ReturnType<typeof d.setUp>>;

  /** A compound with automatic dispatch off, technicians available, tickets queued. */
  async function queued(technicians: number, tickets: number) {
    const s = await d.setUp(technicians);
    const category = await d.categoryId(s.c, 'general');
    await d
      .http(
        'put',
        `/maintenance/categories/${category}/specialties`,
        s.manager.token,
        { specialtyIds: [] },
      )
      .expect(204);
    for (const t of s.techs) await d.setAvailability(s.c, t.id, 'available');
    const ids: string[] = [];
    for (let i = 0; i < tickets; i++) ids.push(await d.openTicket(s));
    return { s, ids };
  }

  const enable = (s: Setup, body: object = { autoDispatchEnabled: true }) =>
    d.http('patch', '/maintenance/dispatch-settings', s.manager.token, body);

  const counts = (s: Setup) =>
    d.inTenant(s.c, async (tx) => ({
      assigned: await tx.ticket.count({ where: { status: 'assigned' } }),
      waiting: await tx.ticket.count({ where: { status: 'new' } }),
    }));

  /** The drain runs after the response: wait for it to settle. */
  async function settled(s: Setup, assigned: number) {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const c = await counts(s);
      if (c.assigned >= assigned) return c;
      if (Date.now() > deadline) return c;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const enabledAttempts = (s: Setup) =>
    d.inTenant(s.c, (tx) =>
      tx.ticketDispatchAttempt.count({
        where: { trigger: 'enabled', outcome: 'assigned' },
      }),
    );

  it('queued tickets are assigned without waiting for the sweep, each by the "enabled" trigger', async () => {
    const { s, ids } = await queued(2, 6);
    expect(await counts(s)).toEqual({ assigned: 0, waiting: 6 });

    const res = await enable(s).expect(200);
    expect(res.body).toMatchObject({ autoDispatchEnabled: true });

    expect(await settled(s, 6)).toEqual({ assigned: 6, waiting: 0 });
    expect(await enabledAttempts(s)).toBe(6);
    // Spread over the two technicians by the engine's own choice.
    const rows = await Promise.all(ids.map((id) => d.ticketRow(s.c, id)));
    const perTech = new Map<string | null, number>();
    for (const r of rows)
      perTech.set(r.technicianId, (perTech.get(r.technicianId) ?? 0) + 1);
    expect([...perTech.values()].sort()).toEqual([3, 3]);
  }, 60_000);

  it('the setting is committed before the drain starts, and the drain is bounded', async () => {
    const { s } = await queued(2, DRAIN_BATCH + 5);
    await enable(s).expect(200);
    const read = await d
      .http('get', '/maintenance/dispatch-settings', s.manager.token)
      .expect(200);
    expect(read.body).toMatchObject({ autoDispatchEnabled: true });

    // One pass: DRAIN_BATCH tickets, the rest wait for the sweep.
    expect(await settled(s, DRAIN_BATCH)).toEqual({
      assigned: DRAIN_BATCH,
      waiting: 5,
    });
    await new Promise((r) => setTimeout(r, 1000));
    expect(await counts(s)).toEqual({ assigned: DRAIN_BATCH, waiting: 5 });
  }, 120_000);

  it('only turning it on starts a pass: not enabling it again, not changing a weight, not turning it off', async () => {
    const { s } = await queued(1, 2);
    await enable(s, { weightOnHold: 0.5 }).expect(200);
    await new Promise((r) => setTimeout(r, 500));
    expect((await counts(s)).assigned).toBe(0);

    await enable(s).expect(200);
    expect(await settled(s, 2)).toEqual({ assigned: 2, waiting: 0 });

    // Already on, then off: neither assigns anything or leaves a new attempt.
    const before = await enabledAttempts(s);
    await enable(s).expect(200);
    await enable(s, { autoDispatchEnabled: false }).expect(200);
    await new Promise((r) => setTimeout(r, 500));
    expect(await enabledAttempts(s)).toBe(before);
  }, 60_000);

  it('with nobody available the pass finds no candidate: the change stands and the tickets wait', async () => {
    const { s, ids } = await queued(1, 2);
    // Nobody can take them yet: the pass finds no candidate, the tickets stay.
    await d.setAvailability(s.c, s.techs[0].id, 'unavailable');
    await enable(s).expect(200);
    await new Promise((r) => setTimeout(r, 1000));
    expect((await counts(s)).waiting).toBe(2);
    expect(
      (await d.http('get', '/maintenance/dispatch-settings', s.manager.token))
        .body,
    ).toMatchObject({ autoDispatchEnabled: true });
    expect(await d.ticketRow(s.c, ids[0])).toMatchObject({ status: 'new' });
  }, 60_000);
});

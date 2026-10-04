import { Logger } from '@nestjs/common';
import {
  DispatchSweep,
  SWEEP_BATCH,
} from '../../src/maintenance/dispatch/dispatch-sweep';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0033: a busy compound must never turn the dispatch lock into errors.
 * Creations, "became available" queue walks, a decline and the sweep all
 * want the compound's one dispatch lock at the same moment. Each decision
 * holds it alone and in a transaction of its own, so nothing waits long
 * enough to expire: no request fails, no transaction is reported as timed
 * out, no decision is skipped as busy, and every ticket ends up with exactly
 * one technician.
 */
describe('Dispatch — a busy compound', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let problems: string[];

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  /**
   * Everything the engine and the sweep log when a decision does not go
   * through. Not "sweep failed in a compound": the sweep walks every compound
   * of the shared test database, and the bare ones other suites leave (no
   * dispatch settings row) fail it by design; a decision of this suite's own
   * compound that failed is logged as "dispatch failed" or "sweep item
   * failed", and would leave tickets unassigned below.
   */
  beforeEach(() => {
    problems = [];
    const note = (message: unknown) => {
      const text = String(message);
      if (!text.startsWith('sweep failed in a compound')) problems.push(text);
    };
    jest.spyOn(Logger.prototype, 'error').mockImplementation(note);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(note);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('30 creations, three queue walks, a decline and two sweeps at once: nothing fails, nothing times out, every ticket has one technician', async () => {
    const s = await d.setUp(6);
    const category = await d.categoryId(s.c, 'general');
    await d
      .http(
        'put',
        `/maintenance/categories/${category}/specialties`,
        s.manager.token,
        { specialtyIds: [] },
      )
      .expect(204);
    // One ticket is in the hands of the technician who will decline it; the
    // others are off, so 20 queued tickets wait for the walks and the sweeps.
    await d.setAvailability(s.c, s.techs[1].id, 'available');
    await d.setAutoDispatch(s.c, true);
    const first = await d.openTicket(s);
    expect((await d.ticketRow(s.c, first)).technicianId).toBe(s.techs[1].id);
    await d.setAvailability(s.c, s.techs[1].id, 'unavailable');
    const queued: string[] = [];
    for (let i = 0; i < 20; i++) queued.push(await d.openTicket(s));
    await d.setAvailability(s.c, s.techs[1].id, 'available');
    problems = [];

    const sweep = h.moduleRef.get(DispatchSweep);
    const creations = Array.from({ length: 30 }, () =>
      d.http('post', '/tickets', s.owner.token, {
        unitId: s.unit.id,
        categoryId: category,
        description: 'Busy compound',
      }),
    );
    const walks = [2, 3, 4].map((i) =>
      d.http('post', '/technician/availability', s.techs[i].token, {
        state: 'available',
      }),
    );
    const decline = d.http(
      'post',
      `/technician/tickets/${first}/decline`,
      s.techs[1].token,
      { reasonCode: 'other' },
    );
    const sweeps = [sweep.run(), sweep.run()];

    const responses = await Promise.all([
      ...creations,
      ...walks,
      decline,
      ...sweeps,
    ]);

    const statuses = responses
      .slice(0, 34)
      .map((r) => (r as { status: number }).status);
    expect(statuses.slice(0, 30)).toEqual(Array(30).fill(201));
    expect(statuses.slice(30, 33)).toEqual(Array(3).fill(200));
    expect(statuses[33]).toBe(204);
    // Nothing the engine or the sweep tried was lost to the lock: no
    // "dispatch failed", no "lock busy", no expired transaction.
    expect(problems).toEqual([]);

    // The decisions that were skipped or raced are finished by one more
    // sweep, with every technician available.
    for (const t of s.techs) await d.setAvailability(s.c, t.id, 'available');
    await sweep.run();
    expect(problems).toEqual([]);

    const created = responses
      .slice(0, 30)
      .map((r) => (r as { body: { id: string } }).body.id);
    const all = [first, ...queued, ...created];
    const { rows, attempts } = await d.inTenant(s.c, async (tx) => ({
      rows: await tx.ticket.findMany({ where: { id: { in: all } } }),
      attempts: await tx.ticketAssignment.groupBy({
        by: ['ticketId'],
        where: { ticketId: { in: all }, assignmentType: 'automatic' },
        _count: true,
      }),
    }));
    expect(rows).toHaveLength(all.length);
    expect(rows.every((r) => r.status === 'assigned' && r.technicianId)).toBe(
      true,
    );
    // One automatic assignment per ticket, plus the decline's second one.
    const perTicket = new Map(attempts.map((a) => [a.ticketId, a._count]));
    for (const id of all) expect(perTicket.get(id)).toBe(id === first ? 2 : 1);
    // The decliner did not get it back.
    expect(rows.find((r) => r.id === first)?.technicianId).not.toBe(
      s.techs[1].id,
    );
  }, 120_000);

  it('a sweep of a full batch while residents keep creating tickets: every creation succeeds, other requests are not held up', async () => {
    const s = await d.setUp(4);
    const category = await d.categoryId(s.c, 'general');
    await d
      .http(
        'put',
        `/maintenance/categories/${category}/specialties`,
        s.manager.token,
        { specialtyIds: [] },
      )
      .expect(204);
    await d.setAutoDispatch(s.c, true);
    // A full sweep batch is waiting: available technicians, but no event
    // told the engine, so only the sweep finds the tickets.
    const queued: string[] = [];
    for (let i = 0; i < SWEEP_BATCH; i++) queued.push(await d.openTicket(s));
    for (const t of s.techs) await d.setAvailability(s.c, t.id, 'available');
    problems = [];

    const sweeping = h.moduleRef.get(DispatchSweep).run();
    // The sweep is under way when the residents arrive.
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    const creations = Array.from({ length: 40 }, () =>
      d.http('post', '/tickets', s.owner.token, {
        unitId: s.unit.id,
        categoryId: category,
        description: 'During a sweep',
      }),
    );
    const other = (async () => {
      await new Promise((r) => setTimeout(r, 500));
      const t = Date.now();
      const res = await d.http('get', '/me', s.manager.token);
      return { status: res.status, ms: Date.now() - t };
    })();
    const [responses, swept, me] = await Promise.all([
      Promise.all(creations),
      sweeping,
      other,
    ]);
    const creationMs = Date.now() - started;
    process.stdout.write(
      `busy compound: sweep assigned ${swept}; 40 creations took ${creationMs} ms in all; GET /me took ${me.ms} ms\n`,
    );

    expect(responses.map((r) => r.status)).toEqual(Array(40).fill(201));
    expect(me.status).toBe(200);
    expect(me.ms).toBeLessThan(2000);
    expect(problems).toEqual([]);

    await h.moduleRef.get(DispatchSweep).run();
    const left = await d.inTenant(s.c, (tx) =>
      tx.ticket.count({ where: { status: 'new' } }),
    );
    expect(left).toBe(0);
  }, 120_000);
});

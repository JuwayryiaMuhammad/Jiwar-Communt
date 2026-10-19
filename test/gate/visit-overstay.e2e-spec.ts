import { dbClock } from '../setup/compound-clock';
import { gateCompletionHelpers } from '../setup/gate-completion';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0056, visit overstay: a visitor still inside past their visit's
 * expected length — their pass's, else the compound's — alerts the guards on
 * shift at the gate they came in by and the host, once per visit. Nothing
 * else happens. Entries are moved into the past (time travel); every
 * instant comes from the database's clock.
 */
describe('Gate — visit overstay (ADR 0056)', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof gateCompletionHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof gateCompletionHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = gateCompletionHelpers(h);
    s = await g.setUp('Overstay Court');
  }, 180_000);

  afterAll(() => h.close());

  const alertsOf = (entryId: string) =>
    g.inTx(s.c, (tx) => tx.visitOverstayAlert.findMany({ where: { entryId } }));

  it('past its pass’s own length: the guards at its gate and the host told, once', async () => {
    const p = await g.pass(s.alice, s.home.id, { expectedMinutes: 15 });
    const entry = await g.enter(s.guard, 'visitor_pass', p.id);
    await g.backdate(entry, 20);
    await g.sweepOverstay();
    await g.sweepOverstay();
    expect(await g.told(s.c, s.guard.id, entry)).toEqual([
      {
        kind: 'visit.overstayed',
        params: { unitCode: s.unitCode, minutes: 15 },
      },
    ]);
    expect(await g.told(s.c, s.alice.id, entry)).toEqual([
      {
        kind: 'visit.overstayed_host',
        params: { unitCode: s.unitCode, minutes: 15 },
      },
    ]);
    expect(await alertsOf(entry)).toEqual([
      expect.objectContaining({
        subjectType: 'visitor_pass',
        subjectId: p.id,
        gateId: s.guard.gateId,
        unitId: s.home.id,
        expectedMinutes: 15,
      }),
    ]);
    // Nothing else: they are still inside.
    expect(
      await g.inTx(s.c, (tx) =>
        tx.gateEntry.count({ where: { subjectId: p.id, direction: 'out' } }),
      ),
    ).toBe(0);
  });

  it('without its own, the compound’s length; with it off, nobody', async () => {
    await g.settings(s.manager, { visitExpectedMinutes: 30 });
    try {
      const p = await g.pass(s.alice, s.home.id);
      const entry = await g.enter(s.guard, 'visitor_pass', p.id);
      await g.backdate(entry, 40);
      await g.sweepOverstay();
      expect(await alertsOf(entry)).toEqual([
        expect.objectContaining({ expectedMinutes: 30 }),
      ]);
      await g.settings(s.manager, { visitExpectedMinutes: null });
      const quiet = await g.pass(s.alice, s.home.id);
      const quietEntry = await g.enter(s.guard, 'visitor_pass', quiet.id);
      await g.backdate(quietEntry, 40);
      await g.sweepOverstay();
      expect(await alertsOf(quietEntry)).toEqual([]);
      expect(await g.told(s.c, s.guard.id, quietEntry)).toEqual([]);
    } finally {
      await g.settings(s.manager, { visitExpectedMinutes: 240 });
    }
  });

  it('not yet due, or already gone: nothing', async () => {
    const early = await g.pass(s.alice, s.home.id, { expectedMinutes: 15 });
    const earlyEntry = await g.enter(s.guard, 'visitor_pass', early.id);
    await g.backdate(earlyEntry, 10);
    const gone = await g.pass(s.alice, s.home.id, { expectedMinutes: 15 });
    const goneEntry = await g.enter(s.guard, 'visitor_pass', gone.id);
    await g.backdate(goneEntry, 20);
    await g.enter(s.guard, 'visitor_pass', gone.id, { direction: 'out' });
    await g.sweepOverstay();
    expect(await alertsOf(earlyEntry)).toEqual([]);
    expect(await alertsOf(goneEntry)).toEqual([]);
  });

  it('a group: each visitor is their own visit; the first out closes the first in', async () => {
    const p = await g.pass(s.alice, s.home.id, {
      expectedMinutes: 15,
      partySize: 2,
    });
    const first = await g.enter(s.guard, 'visitor_pass', p.id);
    await g.backdate(first, 30);
    const second = await g.enter(s.guard, 'visitor_pass', p.id);
    await g.backdate(second, 20);
    // One leaves: the first in is closed, the second is still inside.
    await g.enter(s.guard, 'visitor_pass', p.id, { direction: 'out' });
    await g.sweepOverstay();
    expect(await alertsOf(first)).toEqual([]);
    expect(await alertsOf(second)).toHaveLength(1);
  });

  it('a gate request’s visitor: the household member who let them in is the host', async () => {
    const asked = await g
      .http('post', '/gate/approval-requests', s.guard.token, {
        kind: 'uninvited_visitor',
        unitCode: s.unitCode,
      })
      .expect(201);
    const requestId = (asked.body as { id: string }).id;
    await g
      .http('post', `/gate-requests/${requestId}/decide`, s.alice.token, {
        decision: 'approve',
      })
      .expect(200);
    const entry = await g.enter(s.guard, 'gate_request', requestId);
    await g.backdate(entry, 241);
    await g.sweepOverstay();
    expect(await g.told(s.c, s.alice.id, entry)).toEqual([
      {
        kind: 'visit.overstayed_host',
        params: { unitCode: s.unitCode, minutes: 240 },
      },
    ]);
  });

  it('a field exception’s visitor: the gate only, no host', async () => {
    const x = await g.visitor(s.guard, s.unitCode);
    await g.approve(s.manager, x.id);
    const entry = await g.enter(s.guard, 'field_exception', x.id);
    await g.backdate(entry, 241);
    await g.sweepOverstay();
    expect(await alertsOf(entry)).toHaveLength(1);
    expect(await g.told(s.c, s.guard.id, entry)).toEqual([
      {
        kind: 'visit.overstayed',
        params: { unitCode: s.unitCode, minutes: 240 },
      },
    ]);
    expect(await g.told(s.c, s.alice.id, entry)).toEqual([]);
  });

  it('a pass’s length stays within the system’s 12 hours', async () => {
    const res = await g
      .http('post', `/units/${s.home.id}/visitor-passes`, s.alice.token, {
        kind: 'one_time',
        partySize: 1,
        validFrom: dbClock().toISOString(),
        validUntil: new Date(dbClock().getTime() + 3_600_000).toISOString(),
        expectedMinutes: 721,
      })
      .expect(400);
    expect((res.body as { fields: unknown[] }).fields).toEqual([
      {
        field: 'expectedMinutes',
        code: 'INVALID_NUMBER',
        params: { min: 15, max: 720 },
      },
    ]);
  });
});

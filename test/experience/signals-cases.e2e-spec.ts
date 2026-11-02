import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  experienceHelpers,
  type CaseBody,
  type ExperienceSetUp,
} from '../setup/experience';

type Body = {
  code: string;
  params?: Record<string, unknown>;
  fields?: { field: string; code: string }[];
};

/**
 * ADR 0082: rule-based dissatisfaction signals and the follow-up and
 * recovery cases. A unit meeting a rule (its count of events within its
 * days) is signalled once per its newest event, joins the unit's open case
 * or opens a follow-up; one open case per unit, whoever opens it and
 * however many at once. A case is owned, due by the inbox's hours for its
 * kind, and closed once.
 */
describe('Experience — signals and cases', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof experienceHelpers>;
  let s: ExperienceSetUp;
  const o = (i: number) => s.owners[i - 1];

  beforeAll(async () => {
    h = await createHttpHarness();
    e = experienceHelpers(h);
    s = await e.setUp(6, 3);
  }, 180_000);

  afterAll(() => h.close());

  const manager = () => s.manager.token;

  it('the thresholds: the defaults, changed per rule and audited, a rule off with null', async () => {
    const read = await e.api('get', '/settings', manager()).expect(200);
    expect(read.body).toEqual({
      rules: [
        { code: 'repeated_low_ratings', count: 2, days: 90 },
        { code: 'reopened_tickets', count: 2, days: 60 },
        { code: 'repeated_complaints', count: 3, days: 30 },
      ],
    });
    const changed = await e
      .api('patch', '/settings', manager(), {
        items: [{ code: 'reopened_tickets', count: null, days: 30 }],
      })
      .expect(200);
    expect((changed.body as { rules: object[] }).rules[1]).toEqual({
      code: 'reopened_tickets',
      count: null,
      days: 30,
    });
    const audit = await e.inTx(s.c, (tx) =>
      tx.auditLog.findFirstOrThrow({
        where: { action: 'experience.settings_changed' },
        orderBy: { occurredAt: 'desc' },
      }),
    );
    expect(audit.changes).toEqual({
      'reopened_tickets.count': { from: 2, to: null },
      'reopened_tickets.days': { from: 60, to: 30 },
    });
    for (const bad of [
      { code: 'repeated_low_ratings', count: 1 },
      { code: 'repeated_low_ratings', days: 400 },
      { code: 'nope' },
    ])
      await e
        .api('patch', '/settings', manager(), { items: [bad] })
        .expect(400);
    const twice = await e
      .api('patch', '/settings', manager(), {
        items: [
          { code: 'repeated_complaints', count: 3 },
          { code: 'repeated_complaints', days: 20 },
        ],
      })
      .expect(400);
    expect((twice.body as Body).fields).toEqual([
      { field: 'items[1].code', code: 'DUPLICATE_VALUE' },
    ]);
  });

  it('two low ratings within 90 days: one signal, a follow-up opened by it, the managers told; once per newest rating', async () => {
    await e.lowRatings(s.c, o(1), 1);
    expect(await e.signals()).toBeGreaterThanOrEqual(0);
    expect(await e.signalsOf(s.c, o(1).unitId)).toEqual([]);
    await e.lowRatings(s.c, o(1), 1);
    await e.signals();
    const [signal] = await e.signalsOf(s.c, o(1).unitId);
    expect(signal).toMatchObject({
      code: 'repeated_low_ratings',
      count: 2,
      windowDays: 90,
    });
    const [opened] = await e.casesOf(s.c, o(1).unitId);
    expect(opened).toMatchObject({
      kind: 'follow_up',
      origin: 'signal',
      openedById: null,
      status: 'open',
    });
    expect(signal.caseId).toBe(opened.id);
    const told = await e.notifications(
      s.c,
      s.c.managerId,
      'experience_case.opened',
    );
    expect(told.at(-1)).toMatchObject({
      targetId: opened.id,
      params: { signal: 'repeated_low_ratings' },
    });
    const audit = await e.inTx(s.c, (tx) =>
      tx.auditLog.findFirstOrThrow({
        where: { action: 'experience_signal.raised', targetId: signal.id },
      }),
    );
    expect(audit).toMatchObject({ actorType: 'system' });
    expect(audit.metadata).toMatchObject({
      unitId: o(1).unitId,
      code: 'repeated_low_ratings',
      caseId: opened.id,
    });
    // Nothing new: nothing raised again.
    await e.signals();
    expect(await e.signalsOf(s.c, o(1).unitId)).toHaveLength(1);
    // A third: a new signal, joining the open case.
    await e.lowRatings(s.c, o(1), 1);
    await e.signals();
    const both = await e.signalsOf(s.c, o(1).unitId);
    expect(both.map((x) => [x.count, x.caseId])).toEqual([
      [2, opened.id],
      [3, opened.id],
    ]);
    expect(await e.casesOf(s.c, o(1).unitId)).toHaveLength(1);
  });

  it('two rules met for one unit in one run: two signals, one case', async () => {
    await e.lowRatings(s.c, o(2), 2);
    await e.complaints(s.c, o(2), o(3).unitId, 3);
    await e.signals();
    const signals = await e.signalsOf(s.c, o(2).unitId);
    expect(signals.map((x) => x.code).sort()).toEqual([
      'repeated_complaints',
      'repeated_low_ratings',
    ]);
    const cases = await e.casesOf(s.c, o(2).unitId);
    expect(cases).toHaveLength(1);
    expect(new Set(signals.map((x) => x.caseId))).toEqual(
      new Set([cases[0].id]),
    );
    // The unit complained about is never signalled for it.
    expect(
      (await e.signalsOf(s.c, o(3).unitId)).filter(
        (x) => x.code === 'repeated_complaints',
      ),
    ).toEqual([]);
  });

  it('race: three sweep runs at once write each signal once and open one case', async () => {
    for (let round = 0; round < 3; round++) {
      const unit = round === 0 ? o(4) : round === 1 ? o(5) : o(6);
      await e.lowRatings(s.c, unit, 2);
      await e.complaints(s.c, unit, o(1).unitId, 3);
      await Promise.all([e.signals(), e.signals(), e.signals()]);
      const signals = await e.signalsOf(s.c, unit.unitId);
      expect(signals).toHaveLength(2);
      const cases = await e.casesOf(s.c, unit.unitId);
      expect(cases.filter((c) => c.status === 'open')).toHaveLength(1);
      expect(signals.every((x) => x.caseId === cases[0].id)).toBe(true);
      // Close it for the next round's unit to start clean.
      await e
        .api('post', `/cases/${cases[0].id}/close`, manager(), {
          outcome: 'no_action_needed',
        })
        .expect(201);
    }
  });

  it('by hand: a recovery case with an owner (told); a second for the unit is EXPERIENCE_CASE_OPEN naming the first', async () => {
    const staff = await e.staff(s.c, ['experience.manage']);
    const opened = await e.openCase(staff.token, {
      unitId: o(3).unitId,
      kind: 'recovery',
      failureCode: 'maintenance_delay',
      note: 'CASE-NOTE three visits missed',
      ownerId: s.c.managerId,
    });
    expect(opened).toMatchObject({
      kind: 'recovery',
      origin: 'manual',
      status: 'open',
      ownerId: s.c.managerId,
      unitCode: expect.any(String) as string,
      number: expect.stringMatching(/^EC-\d{6}$/) as string,
    });
    // Due by the inbox's hours for a recovery: 24 by default.
    const hours =
      (new Date(opened.dueAt!).getTime() -
        new Date(
          (opened as unknown as { openedAt: string }).openedAt,
        ).getTime()) /
      3_600_000;
    expect(hours).toBe(24);
    expect(
      (
        await e.notifications(s.c, s.c.managerId, 'experience_case.assigned')
      ).at(-1),
    ).toMatchObject({ targetId: opened.id });
    const again = await e
      .api('post', '/cases', staff.token, {
        unitId: o(3).unitId,
        kind: 'follow_up',
      })
      .expect(409);
    expect(again.body).toMatchObject({
      code: 'EXPERIENCE_CASE_OPEN',
      params: { caseId: opened.id },
    });
    const audit = await e.inTx(s.c, (tx) =>
      tx.auditLog.findFirstOrThrow({
        where: { action: 'experience_case.opened', targetId: opened.id },
      }),
    );
    expect(JSON.stringify(audit)).not.toContain('CASE-NOTE');
    // Half a source is refused; an unknown unit is not found; a resident
    // owner is refused.
    const half = await e
      .api('post', '/cases', staff.token, {
        unitId: o(2).unitId,
        kind: 'recovery',
        sourceType: 'ticket',
      })
      .expect(400);
    expect((half.body as Body).fields).toEqual([
      { field: 'sourceId', code: 'FIELD_REQUIRED' },
    ]);
    await e
      .api('post', '/cases', staff.token, {
        unitId: '0193b8a4-0000-7000-8000-000000000000',
        kind: 'recovery',
      })
      .expect(404);
    const resident = await e
      .api('post', `/cases/${opened.id}/assign`, staff.token, {
        ownerId: o(1).id,
      })
      .expect(409);
    expect((resident.body as Body).code).toBe('EXPERIENCE_OWNER_INVALID');
  });

  it('race: a hand and a signal at once for one unit make one open case', async () => {
    const unit = s.owners[0];
    // o(1)'s case is open from the first scenario: close it first.
    const [open] = (await e.casesOf(s.c, unit.unitId)).filter(
      (c) => c.status === 'open',
    );
    await e
      .api('post', `/cases/${open.id}/close`, manager(), {
        outcome: 'resolved',
      })
      .expect(201);
    await e.lowRatings(s.c, unit, 2);
    const [hand] = await Promise.all([
      e.api('post', '/cases', manager(), {
        unitId: unit.unitId,
        kind: 'follow_up',
      }),
      e.signals(),
    ]);
    expect([201, 409]).toContain(hand.status);
    const cases = (await e.casesOf(s.c, unit.unitId)).filter(
      (c) => c.status === 'open',
    );
    expect(cases).toHaveLength(1);
    const latest = (await e.signalsOf(s.c, unit.unitId)).at(-1)!;
    expect(latest.caseId).toBe(cases[0].id);
  });

  it('closed once, with an outcome; the list by status, kind and unit; staff without the permission see nothing', async () => {
    const opened = await e
      .openCase(manager(), {
        unitId: o(2).unitId,
        kind: 'recovery',
      })
      .catch(async () => {
        const [c] = (await e.casesOf(s.c, o(2).unitId)).filter(
          (x) => x.status === 'open',
        );
        return e.getCase(manager(), c.id);
      });
    const bad = await e
      .api('post', `/cases/${opened.id}/close`, manager(), { outcome: 'meh' })
      .expect(400);
    expect((bad.body as Body).fields?.[0].field).toBe('outcome');
    const noComp = await e
      .api('post', `/cases/${opened.id}/close`, manager(), {
        outcome: 'compensated',
      })
      .expect(409);
    expect((noComp.body as Body).code).toBe('EXPERIENCE_CASE_NOT_COMPENSATED');
    const closed = await e
      .api('post', `/cases/${opened.id}/close`, manager(), {
        outcome: 'resident_unreachable',
        note: 'OUTCOME-NOTE three calls',
      })
      .expect(201);
    expect(closed.body).toMatchObject({
      status: 'closed',
      outcome: 'resident_unreachable',
      dueAt: null,
    });
    const twice = await e
      .api('post', `/cases/${opened.id}/close`, manager(), {
        outcome: 'resolved',
      })
      .expect(409);
    expect((twice.body as Body).code).toBe('EXPERIENCE_CASE_CLOSED');
    const list = await e
      .api('get', `/cases?status=closed&unitId=${o(2).unitId}`, manager())
      .expect(200);
    expect((list.body as { data: CaseBody[] }).data.map((c) => c.id)).toContain(
      opened.id,
    );
    const audit = await e.inTx(s.c, (tx) =>
      tx.auditLog.findFirstOrThrow({
        where: { action: 'experience_case.closed', targetId: opened.id },
      }),
    );
    expect(audit.metadata).toEqual({ outcome: 'resident_unreachable' });
    expect(JSON.stringify(audit)).not.toContain('OUTCOME-NOTE');
    const other = await e.staff(s.c, ['inbox.read']);
    await e.api('get', '/cases', other.token).expect(403);
  });

  it('the inbox: an open case shows to the holders of experience.manage, due by its kind', async () => {
    const inbox = await e
      .http('get', '/staff/inbox?type=recovery_case', manager())
      .expect(200);
    const rows = (inbox.body as { data: { type: string; number: string }[] })
      .data;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => /^EC-/.test(r.number))).toBe(true);
    const counts = await e
      .http('get', '/staff/inbox/count', manager())
      .expect(200);
    const types = (counts.body as { types: { type: string }[] }).types.map(
      (t) => t.type,
    );
    expect(types).toEqual(
      expect.arrayContaining([
        'follow_up_case',
        'recovery_case',
        'compensation',
      ]),
    );
  });
});

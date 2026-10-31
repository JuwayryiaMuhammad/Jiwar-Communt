import { at, day, dbClock } from '../setup/compound-clock';
import { gateHelpers } from '../setup/gate';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { marketHelpers, type MarketSetUp, type Who } from '../setup/market';

/**
 * ADR 0071: a household told when its visitor comes and goes, on a pass
 * that says so — the pass and the gate, never the visitor's name; and,
 * opted in, when the guard lets someone in by an `always_allow` standing
 * instruction.
 */
describe('Visitors — entry and exit notices', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof marketHelpers>;
  let s: MarketSetUp;
  let guard: Who;
  let gateName: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = marketHelpers(h);
    s = await m.setUp();
    const duty = await gateHelpers(h).onDuty(s.c);
    guard = await m.who(s.c, duty.guardId, 'staff');
    gateName = duty.gateName;
  }, 180_000);

  afterAll(() => h.close());

  const pass = async (over: Record<string, unknown> = {}) =>
    (
      (
        await m
          .http('post', `/units/${s.homeA.id}/visitor-passes`, s.alice.token, {
            kind: 'one_time',
            partySize: 1,
            validFrom: new Date(dbClock().getTime() - 60_000).toISOString(),
            validUntil: at(day(1), 18).toISOString(),
            visitorName: 'Hidden Name',
            ...over,
          })
          .expect(201)
      ).body as { id: string }
    ).id;
  const entry = (id: string, direction: 'in' | 'out') =>
    m
      .http('post', '/gate/entries', guard.token, {
        subjectType: 'visitor_pass',
        subjectId: id,
        direction,
      })
      .expect(201);
  const told = async (who: Who, id: string) =>
    (await m.notifications(s.c, who.id))
      .filter((n) => n.targetId === id)
      .map((n) => [n.kind, n.params]);

  it('the host hears of the entry and the exit: the gate, never the name', async () => {
    const id = await pass();
    await entry(id, 'in');
    await entry(id, 'out');
    const notes = await told(s.alice, id);
    expect(notes).toEqual(
      expect.arrayContaining([
        ['visitor_pass.entered', { gateName }],
        ['visitor_pass.exited', { gateName }],
      ]),
    );
    expect(JSON.stringify(notes)).not.toContain('Hidden Name');
  });

  it('a pass that says not to tells nobody', async () => {
    const id = await pass({ notifyOnEntry: false });
    await entry(id, 'in');
    expect(
      (await told(s.alice, id)).filter(([k]) => k === 'visitor_pass.entered'),
    ).toEqual([]);
  });

  it('the pass shows the host whether the household is told', async () => {
    const detail = async (id: string) =>
      (
        (
          await m
            .http('get', `/visitor-passes/${id}`, s.alice.token)
            .expect(200)
        ).body as { notifyOnEntry: boolean }
      ).notifyOnEntry;
    expect(await detail(await pass())).toBe(true);
    expect(await detail(await pass({ notifyOnEntry: false }))).toBe(false);
  });

  it('a standing instruction carries the opt-in to be told', async () => {
    const res = await m
      .http(
        'post',
        `/units/${s.homeA.id}/standing-instructions`,
        s.alice.token,
        {
          description: 'Our gardener on Mondays',
          action: 'always_allow',
          notify: true,
        },
      )
      .expect(201);
    expect(res.body).toMatchObject({ notify: true, action: 'always_allow' });
    const plain = await m
      .http(
        'post',
        `/units/${s.homeA.id}/standing-instructions`,
        s.alice.token,
        {
          description: 'The water delivery',
          action: 'leave_at_gate',
        },
      )
      .expect(201);
    expect(plain.body).toMatchObject({ notify: false });
  });

  describe('let in by a standing instruction', () => {
    const instruction = async (notify: boolean) =>
      (
        (
          await m
            .http(
              'post',
              `/units/${s.homeA.id}/standing-instructions`,
              s.alice.token,
              {
                description: 'Words-Of-The-Household',
                action: 'always_allow',
                notify,
              },
            )
            .expect(201)
        ).body as { id: string }
      ).id;
    const ask = async () =>
      (
        (
          await m
            .http('post', '/gate/approval-requests', guard.token, {
              kind: 'uninvited_visitor',
              unitCode: s.homeA.code,
              visitorName: 'Hidden Name',
            })
            .expect(201)
        ).body as { id: string }
      ).id;
    const apply = (requestId: string, instructionId: string) =>
      m.http(
        'post',
        `/gate/approval-requests/${requestId}/apply-instruction`,
        guard.token,
        { instructionId },
      );
    const letIn = async (who: Who, requestId: string) =>
      (await told(who, requestId)).filter(
        ([k]) => k === 'gate.let_in_by_instruction',
      );

    it('opted in, the household is told once: the request, never the visitor nor the words', async () => {
      const instructionId = await instruction(true);
      const requestId = await ask();
      const applied = await apply(requestId, instructionId).expect(200);
      expect(applied.body).toMatchObject({ status: 'approved' });
      // Decided once: applying it again is refused and tells nobody twice.
      expect((await apply(requestId, instructionId)).status).toBe(409);
      const notes = await letIn(s.alice, requestId);
      expect(notes).toEqual([['gate.let_in_by_instruction', {}]]);
      const raw = JSON.stringify(
        (await m.notifications(s.c, s.alice.id)).filter(
          (n) => n.kind === 'gate.let_in_by_instruction',
        ),
      );
      expect(raw).not.toContain('Hidden Name');
      expect(raw).not.toContain('Words-Of-The-Household');
      expect(raw).not.toContain(instructionId);
      // Another unit's household hears nothing.
      expect(await letIn(s.bob, requestId)).toEqual([]);
    });

    it('not opted in, nobody is told', async () => {
      const instructionId = await instruction(false);
      const requestId = await ask();
      await apply(requestId, instructionId).expect(200);
      expect(await letIn(s.alice, requestId)).toEqual([]);
    });
  });
});

import { gateHelpers } from '../setup/gate';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { call, err } from '../api/request';
import { passBody } from '../api/routes/visitors';
import { buildWorld, type World } from '../api/world';

/**
 * The gate's races (ADR 0028), each run for real with Promise.all: every
 * outcome is one of the allowed ones, and the database agrees.
 */
describe('Gate concurrency', () => {
  let h: HttpHarness;
  let w: World;
  let homeCode: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
    homeCode = (
      await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.unit.findUniqueOrThrow({
          where: { id: w.a.homeUnitId },
        }),
      )
    ).code;
  }, 120_000);

  afterAll(() => h.close());

  const ROUNDS = 5;
  const guard = () => w.a.tokens.guard;
  const ask = async () =>
    (
      (
        await call(w, 'POST', '/gate/approval-requests', {
          token: guard(),
          body: { kind: 'uninvited_visitor', unitCode: homeCode },
        }).expect(201)
      ).body as { id: string }
    ).id;
  const decide = (id: string, token: string, decision: string) =>
    call(w, 'POST', `/gate-requests/${id}/decide`, {
      token,
      body: { decision },
    });
  const enter = (subjectType: string, subjectId: string, token = guard()) =>
    call(w, 'POST', '/gate/entries', {
      token,
      body: { subjectType, subjectId, direction: 'in' },
    });
  const entries = (subjectId: string) =>
    w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.gateEntry.count({ where: { subjectId } }),
    );

  it('approve and deny at once: deny always wins before the entry', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const id = await ask();
      await Promise.all([
        decide(id, w.a.tokens.owner, 'approve'),
        decide(id, w.a.tokens.family, 'deny'),
      ]);
      const row = await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.gateApprovalRequest.findUniqueOrThrow({
          where: { id },
        }),
      );
      expect(row.status).toBe('denied');
    }
  });

  it('a deny racing the entry: exactly one of them takes effect', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const id = await ask();
      await decide(id, w.a.tokens.owner, 'approve').expect(200);
      const [entry, deny] = await Promise.all([
        enter('gate_request', id),
        decide(id, w.a.tokens.family, 'deny'),
      ]);
      const entered = entry.status === 201;
      const denied = deny.status === 200;
      expect(entered !== denied).toBe(true);
      if (entered)
        expect(err(deny)).toMatchObject({ code: 'GATE_REQUEST_DECIDED' });
      else
        expect(err(entry)).toMatchObject({
          code: 'GATE_ENTRY_REFUSED',
          params: { reason: 'not_approved' },
        });
      expect(await entries(id)).toBe(entered ? 1 : 0);
    }
  });

  it('two guards let the same one-time pass in: once', async () => {
    const second = await gateHelpers(h).guard(w.a);
    await gateHelpers(h).startShift(w.a, second.id, w.a.gateId);
    const secondToken = await w.tokenFor(w.a, second.id, 'staff');
    for (let i = 0; i < ROUNDS; i++) {
      const pass = (
        await call(w, 'POST', `/units/${w.a.homeUnitId}/visitor-passes`, {
          token: w.a.tokens.owner,
          body: passBody(),
        }).expect(201)
      ).body as { id: string };
      const results = await Promise.all([
        enter('visitor_pass', pass.id),
        enter('visitor_pass', pass.id, secondToken),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await entries(pass.id)).toBe(1);
    }
  });

  it('the pass cap holds under concurrent creation', async () => {
    const unit = await w.helpers.unit(w.a);
    const host = await w.helpers.resident(w.a, [unit.id]);
    const token = await w.tokenFor(w.a, host.id, 'resident');
    await call(w, 'PATCH', '/settings', {
      token: w.a.tokens.manager,
      body: { maxActiveVisitorPasses: 3 },
    }).expect(200);
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          call(w, 'POST', `/units/${unit.id}/visitor-passes`, {
            token,
            body: passBody(),
          }),
        ),
      );
      const codes = results.map((r) => r.status).sort();
      expect(codes).toEqual([201, 201, 201, 409, 409, 409]);
      const active = await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.visitorPass.count({
          where: { unitId: unit.id, status: 'active' },
        }),
      );
      expect(active).toBe(3);
    } finally {
      await call(w, 'PATCH', '/settings', {
        token: w.a.tokens.manager,
        body: { maxActiveVisitorPasses: 50 },
      }).expect(200);
    }
  });

  it('one guard starting two shifts at once: one shift', async () => {
    const g = await gateHelpers(h).guard(w.a);
    const token = await w.tokenFor(w.a, g.id, 'staff');
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        call(w, 'POST', '/gate/shifts/start', {
          token,
          body: { gateId: w.a.gateId },
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    for (const r of results.filter((x) => x.status === 409))
      expect(err(r).code).toBe('SHIFT_ALREADY_OPEN');
  });
});

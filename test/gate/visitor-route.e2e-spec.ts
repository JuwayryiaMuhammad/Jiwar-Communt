import { call } from '../api/request';
import { passBody } from '../api/routes/visitors';
import { buildWorld, type World } from '../api/world';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const LINK = /^https:\/\/app\.jiwar\.test\/v#([A-Za-z0-9_-]{43})$/;

/**
 * ADR 0071: the visitor's route before arrival. A gate's directions, set by
 * the management; a pass naming the gate its visitor is expected at; the
 * visitor's page showing that gate, its directions and the parking area of
 * the host's visitor parking booking for the pass.
 */
describe('Visitors — the route before arrival', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 300_000);

  afterAll(() => h.close());

  const lookup = (token: string) =>
    call(w, 'POST', '/public/visitor-passes/lookup', { body: { token } });

  it('the page shows the expected gate and its directions; no parking without a booking', async () => {
    const gate = await call(w, 'PATCH', `/gates/${w.a.gateId}`, {
      token: w.a.tokens.manager,
      body: {
        directionsEn: 'From the ring road, the second exit.',
        directionsAr: 'من الطريق الدائري، المخرج الثاني.',
      },
    }).expect(200);
    expect(gate.body).toMatchObject({
      directionsEn: 'From the ring road, the second exit.',
    });
    const res = await call(
      w,
      'POST',
      `/units/${w.a.homeUnitId}/visitor-passes`,
      {
        token: w.a.tokens.owner,
        body: passBody({ expectedGateId: w.a.gateId }),
      },
    ).expect(201);
    const token = LINK.exec((res.body as { link: string }).link)![1];
    expect((await lookup(token).expect(200)).body).toMatchObject({
      expectedGate: {
        name: w.a.gateName,
        directionsEn: 'From the ring road, the second exit.',
        directionsAr: 'من الطريق الدائري، المخرج الثاني.',
      },
      parkingArea: null,
    });
  });

  it('a pass names one of the compound’s gates only', async () => {
    const res = await call(
      w,
      'POST',
      `/units/${w.a.homeUnitId}/visitor-passes`,
      {
        token: w.a.tokens.owner,
        body: passBody({ expectedGateId: w.b.gateId }),
      },
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'GATE_NOT_FOUND' });
  });

  it('the directions are the management’s words: audited as changed only', async () => {
    await call(w, 'PATCH', `/gates/${w.a.gateId}`, {
      token: w.a.tokens.manager,
      body: { directionsEn: 'Through the north gate.' },
    }).expect(200);
    const rows = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.auditLog.findMany({
        where: { action: 'gate.updated', targetId: w.a.gateId },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: 1,
      }),
    );
    expect(rows[0].changes).toMatchObject({ directionsEn: { changed: true } });
  });
});

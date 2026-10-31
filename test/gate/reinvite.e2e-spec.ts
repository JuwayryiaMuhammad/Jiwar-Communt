import { Client } from 'pg';
import { VISITOR_DATA_SWEEP } from '../../src/gate/visitors/visitor-data.sweep';
import { at, day, dbClock } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { marketHelpers, type MarketSetUp, type Who } from '../setup/market';
import { required } from '../setup/test-env';

/**
 * ADR 0071: re-inviting a visitor. The host of an earlier pass gets a new
 * one for the same visitor while the compound keeps their details, through
 * every check a new pass runs; once the details are gone, 409.
 */
describe('Visitors — re-invite', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof marketHelpers>;
  let s: MarketSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = marketHelpers(h);
    s = await m.setUp();
  }, 180_000);

  afterAll(() => h.close());

  const pass = async (by: Who, unitId: string) =>
    (
      (
        await m
          .http('post', `/units/${unitId}/visitor-passes`, by.token, {
            kind: 'one_time',
            partySize: 2,
            validFrom: at(day(1), 10).toISOString(),
            validUntil: at(day(1), 18).toISOString(),
            visitorName: 'Omar Visitor',
            visitorPhone: '+201001234567',
          })
          .expect(201)
      ).body as { id: string }
    ).id;
  const reinvite = (by: Who, id: string, d = 3) =>
    m.http('post', `/visitor-passes/${id}/reinvite`, by.token, {
      validFrom: at(day(d), 10).toISOString(),
      validUntil: at(day(d), 18).toISOString(),
    });

  /** Moves a pass's visitor details past their day (a test's time machine). */
  async function outlive(passId: string) {
    const db = new Client({
      connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
    });
    await db.connect();
    try {
      await db.query('BEGIN');
      await db.query(`SET LOCAL session_replication_role = replica`);
      await db.query(
        `UPDATE visitor_details SET expires_at = now() - interval '1 second'
          WHERE id = (SELECT visitor_details_id FROM visitor_passes WHERE id = $1)`,
        [passId],
      );
      await db.query('COMMIT');
    } finally {
      await db.end();
    }
  }

  it('a new pass, the same visitor, the same party; the earlier one stays as it was', async () => {
    const first = await pass(s.alice, s.homeA.id);
    const res = await reinvite(s.alice, first).expect(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const issued = res.body as { id: string; code: string; partySize: number };
    expect(issued.id).not.toBe(first);
    expect(issued).toMatchObject({ partySize: 2, kind: 'one_time' });
    expect(typeof issued.code).toBe('string');
    expect(
      (
        await m
          .http('get', `/visitor-passes/${issued.id}`, s.alice.token)
          .expect(200)
      ).body,
    ).toMatchObject({ visitorName: 'Omar Visitor' });
  });

  it('only by its host; never another unit’s', async () => {
    const first = await pass(s.alice, s.homeA.id);
    await reinvite(s.bob, first).expect(404);
  });

  it('once the details are past their day, or deleted by the sweep: 409', async () => {
    const first = await pass(s.alice, s.homeA.id);
    await outlive(first);
    expect((await reinvite(s.alice, first).expect(409)).body).toMatchObject({
      code: 'VISITOR_DETAILS_PURGED',
    });
    await m.sweep_(VISITOR_DATA_SWEEP, dbClock());
    await reinvite(s.alice, first).expect(409);
  });

  it('race: a re-invite and the retention sweep at once — never a pass without its details, never a 500 (3 rounds)', async () => {
    for (let round = 0; round < 3; round++) {
      const first = await pass(s.alice, s.homeA.id);
      await outlive(first);
      const [res] = await Promise.all([
        reinvite(s.alice, first, 4 + round),
        m.sweep_(VISITOR_DATA_SWEEP, dbClock()),
      ]);
      expect(res.status).toBe(409);
      const left = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.visitorPass.findUniqueOrThrow({
          where: { id: first },
        }),
      );
      expect(left.visitorDetailsId).toBeNull();
    }
  });
});

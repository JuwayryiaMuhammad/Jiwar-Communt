import { boardAppealHelpers } from '../setup/board-appeals';
import type { Who } from '../setup/board-matters';
import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const ROUNDS = 5;

/**
 * ADR 0055, a unit violation (or a warning) taken to the board: as a
 * fine. Only once its appeal was upheld, open; while the board has it, no
 * payment and no cancellation; overturned, cancelled by the system; and a
 * board appeal and a payment at once: one wins (×5).
 */
describe('Violations — appealed to the board (ADR 0055)', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof boardAppealHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof boardAppealHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = boardAppealHelpers(h);
    s = await a.setUp(5, 3);
  }, 240_000);

  afterAll(() => h.close());

  const o = (i: number) => s.owners[i];
  let receipts = 0;
  const unitCode = async (unitId: string) =>
    (
      await a.inTx(s.c, (tx) =>
        tx.unit.findUniqueOrThrow({ where: { id: unitId } }),
      )
    ).code;

  /** A violation of the owner's unit (a warning without an amount), appealed and upheld. */
  async function upheld(owner: Who & { unitId: string }, amount?: string) {
    const v = (
      await a
        .http('post', '/staff/violations', s.manager.token, {
          kind: 'noise',
          unitCode: await unitCode(owner.unitId),
          ...(amount ? { amount } : {}),
          occurredOn: day(0),
        })
        .expect(201)
    ).body as { id: string };
    await a
      .http('post', `/violations/${v.id}/appeal`, owner.token, {
        reason: 'We were away',
      })
      .expect(200);
    await a
      .http(
        'post',
        `/staff/violations/${v.id}/decide-appeal`,
        s.manager.token,
        {
          decision: 'upheld',
        },
      )
      .expect(200);
    return v.id;
  }
  const pay = (id: string) =>
    a.http('post', `/staff/violations/${id}/payments`, s.accountant.token, {
      amount: '120',
      receiptNumber: `VBA-${++receipts}-${Date.now() % 100000}`,
      paidOn: day(0),
    });
  const lodge = (as: Who, id: string) =>
    a.lodge(as, id, { kind: 'unit_violation' });
  const row = (id: string) =>
    a.inTx(s.c, (tx) => tx.unitViolation.findUniqueOrThrow({ where: { id } }));

  it('a warning upheld is appealed and, overturned, cancelled by the system', async () => {
    const id = await upheld(o(3));
    const x = (await lodge(o(3), id).expect(201)).body as { id: string };
    expect(
      (
        await a
          .http('post', `/staff/violations/${id}/cancel`, s.manager.token, {
            reasonCode: 'other',
          })
          .expect(409)
      ).body,
    ).toMatchObject({
      code: 'VIOLATION_UNDER_APPEAL',
      params: { level: 'board' },
    });
    const m = (await a.proposeOn(o(0), x.id).expect(201)).body as {
      id: string;
    };
    await a.vote(o(0), m.id, 'for').expect(201);
    await a.vote(o(1), m.id, 'for').expect(201);
    expect(await row(id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'board_overturned',
      cancelledById: null,
    });
    const staff = await a
      .http('get', `/staff/violations/${id}`, s.manager.token)
      .expect(200);
    expect(staff.body).toMatchObject({
      status: 'cancelled',
      cancelReason: 'board_overturned',
      cancelledBy: null,
    });
  });

  it('a board appeal and a payment at once: one wins, and the violation says which (×5)', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const id = await upheld(o(4), '120');
      const [lodged, paid] = await Promise.all([lodge(o(4), id), pay(id)]);
      const v = await row(id);
      if (lodged.status === 201) {
        expect(paid.status).toBe(409);
        expect(paid.body).toMatchObject({
          code: 'VIOLATION_UNDER_APPEAL',
          params: { level: 'board' },
        });
        expect(v).toMatchObject({ status: 'open', boardAppealClosedAt: null });
        expect(v.boardAppealAt).not.toBeNull();
      } else {
        expect(paid.status).toBe(201);
        expect(lodged.body).toMatchObject({
          code: 'BOARD_APPEAL_NOT_ELIGIBLE',
          params: { reason: 'paid' },
        });
        expect(v).toMatchObject({ status: 'paid', boardAppealAt: null });
      }
    }
  });
});

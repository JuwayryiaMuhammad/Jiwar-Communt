import { auditReaders } from '../setup/audit';
import type { MotionBody } from '../setup/board-matters';
import { boardAppealHelpers } from '../setup/board-appeals';
import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { vehicleHelpers } from '../setup/vehicles';

const ROUNDS = 5;

/**
 * ADR 0055, a fine's appeal to the board under races:
 * - lodged while the fine is paid: both take the fine's row for update;
 *   either the appeal is lodged and the payment refused (FINE_UNDER_APPEAL,
 *   level board), or the payment is recorded and the appeal refused
 *   (BOARD_APPEAL_NOT_ELIGIBLE, paid); the row agrees;
 * - two votes that would each overturn it: one decides, and the fine is
 *   cancelled once;
 * - a deciding vote while the appellant withdraws: one of the two, and the
 *   fine follows the winner.
 */
describe('Vehicles — a fine’s board appeal, concurrently (ADR 0055)', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof boardAppealHelpers>;
  let v: ReturnType<typeof vehicleHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof boardAppealHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = boardAppealHelpers(h);
    v = vehicleHelpers(h);
    s = await a.setUp(4, 3);
    read = auditReaders(h);
  }, 240_000);

  afterAll(() => h.close());

  /** A fine of the appellant's unit, its first appeal upheld. */
  async function upheldFine() {
    const owner = s.owners[3];
    const unit = await a.inTx(s.c, (tx) =>
      tx.unit.findUniqueOrThrow({ where: { id: owner.unitId } }),
    );
    const f = await v.fine(s.manager, unit.code);
    await v
      .http('post', `/vehicle-fines/${f.id}/appeal`, owner.token, {
        reason: 'Race',
      })
      .expect(200);
    await v
      .http(
        'post',
        `/staff/vehicle-fines/${f.id}/decide-appeal`,
        s.manager.token,
        {
          decision: 'upheld',
        },
      )
      .expect(200);
    return f;
  }
  const fineRow = (id: string) =>
    a.inTx(s.c, (tx) => tx.vehicleFine.findUniqueOrThrow({ where: { id } }));
  const lodged = async (fineId: string) => {
    const res = await a.lodge(s.owners[3], fineId, { kind: 'vehicle_fine' });
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  };

  it('two votes that would each overturn it: one decides, the fine is cancelled once (×5)', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const f = await upheldFine();
      const appealId = await lodged(f.id);
      const m = (await a.proposeOn(s.owners[0], appealId).expect(201))
        .body as MotionBody;
      await a.vote(s.owners[0], m.id, 'for').expect(201);
      const [one, two] = await Promise.all([
        a.vote(s.owners[1], m.id, 'for'),
        a.vote(s.owners[2], m.id, 'for'),
      ]);
      expect([one.status, two.status].sort()).toEqual([201, 409]);
      expect(
        ([one, two].find((x) => x.status === 409)!.body as { code: string })
          .code,
      ).toBe('BOARD_MOTION_CLOSED');
      expect(await fineRow(f.id)).toMatchObject({
        status: 'cancelled',
        cancelReason: 'board_overturned',
      });
      expect(
        await read.tenant(s.c.tenantId, {
          action: 'vehicle_fine.cancelled',
          targetId: f.id,
        }),
      ).toHaveLength(1);
    }
  });

  it('a deciding vote while the appellant withdraws: one of the two, and the fine follows (×5)', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const f = await upheldFine();
      const appealId = await lodged(f.id);
      const m = (await a.proposeOn(s.owners[0], appealId).expect(201))
        .body as MotionBody;
      await a.vote(s.owners[0], m.id, 'for').expect(201);
      const [voted, withdrawn] = await Promise.all([
        a.vote(s.owners[1], m.id, 'for'),
        a.http(
          'post',
          `/governance/board-appeals/${appealId}/withdraw`,
          s.owners[3].token,
          {},
        ),
      ]);
      const row = await fineRow(f.id);
      expect(row.boardAppealClosedAt).not.toBeNull();
      if (voted.status === 201) {
        expect((voted.body as MotionBody).status).toBe('carried');
        expect(withdrawn.status).toBe(409);
        expect((withdrawn.body as { code: string }).code).toBe(
          'BOARD_APPEAL_NOT_PENDING',
        );
        expect(row).toMatchObject({
          status: 'cancelled',
          cancelReason: 'board_overturned',
        });
      } else {
        expect(voted.status).toBe(409);
        expect((voted.body as { code: string }).code).toBe(
          'BOARD_MOTION_CLOSED',
        );
        expect(withdrawn.status).toBe(200);
        expect(row.status).toBe('unpaid');
      }
    }
  });

  it('one wins, and the fine says which (×5)', async () => {
    const owner = s.owners[3];
    const code = (
      await a.inTx(s.c, (tx) =>
        tx.unit.findUniqueOrThrow({ where: { id: owner.unitId } }),
      )
    ).code;
    for (let round = 0; round < ROUNDS; round++) {
      const f = await v.fine(s.manager, code);
      await v
        .http('post', `/vehicle-fines/${f.id}/appeal`, owner.token, {
          reason: 'Race',
        })
        .expect(200);
      await v
        .http(
          'post',
          `/staff/vehicle-fines/${f.id}/decide-appeal`,
          s.manager.token,
          {
            decision: 'upheld',
          },
        )
        .expect(200);
      const [lodged, paid] = await Promise.all([
        a.lodge(owner, f.id, { kind: 'vehicle_fine' }),
        v.http(
          'post',
          `/staff/vehicle-fines/${f.id}/payments`,
          s.accountant.token,
          {
            amount: '500',
            receiptNumber: `RACE-${round}-${Date.now() % 100000}`,
            paidOn: day(0),
          },
        ),
      ]);
      const row = await a.inTx(s.c, (tx) =>
        tx.vehicleFine.findUniqueOrThrow({ where: { id: f.id } }),
      );
      if (lodged.status === 201) {
        expect(paid.status).toBe(409);
        expect(paid.body).toMatchObject({
          code: 'FINE_UNDER_APPEAL',
          params: { level: 'board' },
        });
        expect(row).toMatchObject({
          status: 'unpaid',
          boardAppealClosedAt: null,
        });
        expect(row.boardAppealAt).not.toBeNull();
      } else {
        expect(paid.status).toBe(201);
        expect(lodged.status).toBe(409);
        expect(lodged.body).toMatchObject({
          code: 'BOARD_APPEAL_NOT_ELIGIBLE',
          params: { reason: 'paid' },
        });
        expect(row).toMatchObject({ status: 'paid', boardAppealAt: null });
      }
    }
  });
});

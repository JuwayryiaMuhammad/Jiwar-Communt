import { boardAppealHelpers } from '../setup/board-appeals';
import type { Who } from '../setup/board-matters';
import { day } from '../setup/compound-clock';
import { eraseNow } from '../setup/erasure';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { plate, vehicleHelpers } from '../setup/vehicles';

/**
 * ADR 0055, a vehicle fine taken to the board: only once its appeal was
 * upheld, unpaid; while the board has it, no payment and no cancellation;
 * overturned, the fine is cancelled by the system (`board_overturned`, no
 * actor); upheld, it is payable again.
 */
describe('Vehicles — a fine appealed to the board (ADR 0055)', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof boardAppealHelpers>;
  let v: ReturnType<typeof vehicleHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof boardAppealHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = boardAppealHelpers(h);
    v = vehicleHelpers(h);
    s = await a.setUp(6, 3);
  }, 240_000);

  afterAll(() => h.close());

  const o = (i: number) => s.owners[i];
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  let receipts = 0;
  const unitCode = async (unitId: string) =>
    (
      await a.inTx(s.c, (tx) =>
        tx.unit.findUniqueOrThrow({ where: { id: unitId } }),
      )
    ).code;

  /** A fine of the owner's unit, appealed by them and upheld by the manager. */
  async function upheldFine(owner: Who & { unitId: string }) {
    const f = await v.fine(s.manager, await unitCode(owner.unitId), {
      plate: plate(),
    });
    await v
      .http('post', `/vehicle-fines/${f.id}/appeal`, owner.token, {
        reason: 'Not our car',
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
    return f.id;
  }
  const pay = (fineId: string) =>
    v.http(
      'post',
      `/staff/vehicle-fines/${fineId}/payments`,
      s.accountant.token,
      {
        amount: '500',
        receiptNumber: `BA-${++receipts}-${Date.now() % 100000}`,
        paidOn: day(0),
      },
    );
  const lodge = (as: Who, fineId: string) =>
    a.lodge(as, fineId, { kind: 'vehicle_fine' });
  const fineRow = (id: string) =>
    a.inTx(s.c, (tx) => tx.vehicleFine.findUniqueOrThrow({ where: { id } }));

  it('only an upheld, unpaid fine; the resident view says until when', async () => {
    const plain = await v.fine(s.manager, await unitCode(o(3).unitId));
    expect((await lodge(o(3), plain.id).expect(409)).body).toMatchObject({
      code: 'BOARD_APPEAL_NOT_ELIGIBLE',
      params: { reason: 'not_decided' },
    });
    const id = await upheldFine(o(3));
    const view = await v
      .http('get', `/vehicle-fines/${id}`, o(3).token)
      .expect(200);
    expect(view.body).toMatchObject({
      boardAppealUntil: expect.any(String) as string,
      boardAppealAt: null,
    });
    const paid = await upheldFine(o(3));
    await pay(paid).expect(201);
    expect((await lodge(o(3), paid).expect(409)).body).toMatchObject({
      params: { reason: 'paid' },
    });
  });

  it('while the board has it: no payment, no cancellation; overturned, cancelled by the system', async () => {
    const id = await upheldFine(o(4));
    await lodge(o(4), id).expect(201);
    const refused = await pay(id).expect(409);
    expect(refused.body).toMatchObject({
      code: 'FINE_UNDER_APPEAL',
      params: { level: 'board' },
    });
    expect(
      code(
        await v
          .http('post', `/staff/vehicle-fines/${id}/cancel`, s.manager.token, {
            reasonCode: 'other',
          })
          .expect(409),
      ),
    ).toBe('FINE_UNDER_APPEAL');
    const [x] = (
      (await a.http('get', '/board/appeals', o(0).token).expect(200)).body as {
        data: { id: string; subjectId: string }[];
      }
    ).data.filter((r) => r.subjectId === id);
    const m = (await a.proposeOn(o(0), x.id).expect(201)).body as {
      id: string;
    };
    await a.vote(o(0), m.id, 'for').expect(201);
    await a.vote(o(1), m.id, 'for').expect(201);
    expect(await fineRow(id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'board_overturned',
      cancelledById: null,
      boardAppealClosedAt: expect.any(Date) as Date,
    });
    const staff = (
      await a
        .http('get', `/staff/governance/board-appeals/${x.id}`, s.manager.token)
        .expect(200)
    ).body as { effect: string };
    expect(staff.effect).toBe('applied');
  });

  it('upheld by the board: payable again; an erasure afterwards still clears the first appeal (a system cancellation never blocks a later change)', async () => {
    const id = await upheldFine(o(5));
    const x = (await lodge(o(5), id).expect(201)).body as { id: string };
    const m = (
      await a
        .proposeOn(o(0), x.id, {
          outcome: 'uphold',
          rationale: 'The fine stands.',
        })
        .expect(201)
    ).body as { id: string };
    await a.vote(o(0), m.id, 'for').expect(201);
    await a.vote(o(1), m.id, 'for').expect(201);
    await pay(id).expect(201);

    // A co-owner's fine, appealed by them, overturned: then they are erased.
    const coOwner = await a.owner(s.c, o(5).unitId);
    const f = await v.fine(s.manager, await unitCode(o(5).unitId));
    await v
      .http('post', `/vehicle-fines/${f.id}/appeal`, coOwner.token, {
        reason: 'COOWNER-APPEAL',
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
    const y = (await lodge(coOwner, f.id).expect(201)).body as { id: string };
    const n = (await a.proposeOn(o(0), y.id).expect(201)).body as {
      id: string;
    };
    await a.vote(o(0), n.id, 'for').expect(201);
    await a.vote(o(1), n.id, 'for').expect(201);
    await eraseNow(h, s.c, coOwner.id);
    expect(await fineRow(f.id)).toMatchObject({
      status: 'cancelled',
      cancelledById: null,
      appealText: null,
      appealClearedAt: expect.any(Date) as Date,
    });
  });
});

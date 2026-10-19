import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { boardAppealHelpers } from '../setup/board-appeals';
import type { Who } from '../setup/board-matters';
import {
  bookingRow,
  facilityRow,
  suspensionRow,
} from '../setup/facilities-rows';
import { superuserSql } from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0055, a suspension from booking taken to the board: in force,
 * within 15 days of its start; nothing is blocked meanwhile; overturned,
 * lifted by the system (`board_overturned`, no actor) if still in force,
 * else nothing is left to apply.
 */
describe('Facilities — a suspension appealed to the board (ADR 0055)', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof boardAppealHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof boardAppealHelpers>['setUp']>>;
  let facilityId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = boardAppealHelpers(h);
    s = await a.setUp(6, 3);
    facilityId = await a.x.asManager(s.c, () =>
      h.moduleRef
        .get(TenantTx)
        .withTenantTx((tx) => facilityRow(tx, s.c.tenantId)),
    );
  }, 240_000);

  afterAll(() => h.close());

  const o = (i: number) => s.owners[i];
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;

  /** A suspension of the owner's unit in force now, as a no-show starts one. */
  const suspended = (owner: Who & { unitId: string }) =>
    a.x.asManager(s.c, () =>
      h.moduleRef.get(TenantTx).withTenantTx(async (tx) =>
        suspensionRow(tx, {
          tenantId: s.c.tenantId,
          unitId: owner.unitId,
          triggerBookingId: await bookingRow(tx, {
            tenantId: s.c.tenantId,
            facilityId,
            unitId: owner.unitId,
            bookedById: owner.id,
          }),
        }),
      ),
    );
  const lodge = (as: Who, id: string) =>
    a.lodge(as, id, { kind: 'booking_suspension' });
  const row = (id: string) =>
    a.inTx(s.c, (tx) =>
      tx.bookingSuspension.findUniqueOrThrow({ where: { id } }),
    );
  async function overturn(appealId: string) {
    const m = (await a.proposeOn(o(0), appealId).expect(201)).body as {
      id: string;
    };
    await a.vote(o(0), m.id, 'for').expect(201);
    await a.vote(o(1), m.id, 'for').expect(201);
  }

  it('in force: appealed, and, overturned, lifted by the system', async () => {
    const id = await suspended(o(3));
    const standing = await a
      .http('get', `/units/${o(3).unitId}/booking-standing`, o(3).token)
      .expect(200);
    expect(standing.body).toMatchObject({
      suspension: { id },
      boardAppealUntil: expect.any(String) as string,
      boardAppealAt: null,
    });
    const x = (await lodge(o(3), id).expect(201)).body as { id: string };
    await overturn(x.id);
    expect(await row(id)).toMatchObject({
      liftedAt: expect.any(Date) as Date,
      liftedById: null,
      liftReasonCode: 'board_overturned',
    });
    const after = await a
      .http('get', `/units/${o(3).unitId}/booking-standing`, o(3).token)
      .expect(200);
    expect(after.body).toMatchObject({ suspension: null });
    expect(
      (
        (
          await a
            .http(
              'get',
              `/staff/governance/board-appeals/${x.id}`,
              s.manager.token,
            )
            .expect(200)
        ).body as { effect: string }
      ).effect,
    ).toBe('applied');
  });

  it('lifted by the staff, or past its 15 days: not appealed', async () => {
    const lifted = await suspended(o(4));
    await a
      .http(
        'post',
        `/staff/booking-suspensions/${lifted}/lift`,
        s.manager.token,
        {
          reasonCode: 'staff_error',
        },
      )
      .expect(204);
    expect((await lodge(o(4), lifted).expect(409)).body).toMatchObject({
      code: 'BOARD_APPEAL_NOT_ELIGIBLE',
      params: { reason: 'not_in_force' },
    });
    const old = await suspended(o(4));
    await superuserSql(
      `UPDATE booking_suspensions
          SET starts_at = now() - interval '16 days', ends_at = now() + interval '1 day',
              created_at = now() - interval '16 days'
        WHERE id = $1`,
      [old],
    );
    expect(code(await lodge(o(4), old).expect(409))).toBe(
      'BOARD_APPEAL_WINDOW_PASSED',
    );
  });

  it('nothing is blocked meanwhile: lifted by the staff, an overturn has nothing left to apply', async () => {
    const id = await suspended(o(5));
    const x = (await lodge(o(5), id).expect(201)).body as { id: string };
    await a
      .http('post', `/staff/booking-suspensions/${id}/lift`, s.manager.token, {
        reasonCode: 'exception_granted',
      })
      .expect(204);
    await overturn(x.id);
    expect(await row(id)).toMatchObject({
      liftReasonCode: 'exception_granted',
      liftedById: s.manager.id,
      boardAppealClosedAt: expect.any(Date) as Date,
    });
    expect(
      (
        (
          await a
            .http(
              'get',
              `/staff/governance/board-appeals/${x.id}`,
              s.manager.token,
            )
            .expect(200)
        ).body as { effect: string }
      ).effect,
    ).toBe('none');
  });
});

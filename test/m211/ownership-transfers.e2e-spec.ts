import { auditReaders } from '../setup/audit';
import { day } from '../setup/compound-clock';
import { financeHelpers, type FinanceSetUp, type Who } from '../setup/finance';
import { queuedBehind } from '../setup/held-lock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface TransferBody {
  id: string;
  reference: string;
  status: string;
  owedNow: string | null;
  owedAtApproval: string | null;
  duesExceptionCode: string | null;
  newOccupancyId: string | null;
  cancelReason: string | null;
}

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});

/**
 * ADR 0083: an ownership transfer request waits in the staff inbox and is
 * approved once. The dues gate reads finance's amount under finance's own
 * lock: a unit that owes is refused, unless an exception's code comes with
 * a fresh step-up. The transfer itself is ADR 0021's: every occupancy ends
 * and stays in the unit's history, the buyer's starts.
 */
describe('Ownership transfers and their dues gate', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  const reason = {
    reasonCode: 'unit_changed_hands',
    reason: 'The unit was sold.',
  };
  /** A compound, its home with its owner, and a buyer living elsewhere. */
  async function setUp(name: string) {
    const s = await f.setUp(name);
    const elsewhere = await f.unit(s.c, 'B');
    const buyer = await f.owner(s.c, elsewhere.id);
    return { ...s, buyer };
  }
  const ask = (s: FinanceSetUp, buyer: Who, over: object = {}) =>
    f.http(
      'post',
      `/staff/units/${s.home.id}/ownership-transfers`,
      s.manager.token,
      { toAccountId: buyer.id, ...reason, ...over },
    );
  const asked = async (s: FinanceSetUp, buyer: Who) =>
    (await ask(s, buyer).expect(201)).body as TransferBody;
  const approve = (s: FinanceSetUp, id: string, body: object = {}) =>
    f.http(
      'post',
      `/staff/ownership-transfers/${id}/approve`,
      s.manager.token,
      body,
    );
  const get = async (s: FinanceSetUp, id: string) =>
    (
      await f
        .http('get', `/staff/ownership-transfers/${id}`, s.manager.token)
        .expect(200)
    ).body as TransferBody;
  const owners = (s: FinanceSetUp) =>
    f.x.asManager(s.c, () =>
      f.x.prisma.tenant.unitOccupancy.findMany({
        where: { unitId: s.home.id, status: 'active' },
        select: { accountId: true, occupancyType: true },
      }),
    );
  const pay = (s: FinanceSetUp, amount: string) =>
    f.http('post', `/staff/units/${s.home.id}/payments`, s.accountant.token, {
      amount,
      method: 'cash',
      paidOn: day(0),
    });

  it('requested, in the inbox, approved once: the old owner’s occupancy ends into the history, the buyer’s starts', async () => {
    const s = await setUp('Transfer Court');
    const t = await asked(s, s.buyer);
    expect(t).toMatchObject({
      status: 'pending',
      owedNow: '0.00',
      reference: expect.stringMatching(/^OT-\d{6}$/) as string,
    });
    const inbox = (
      await f
        .http('get', '/staff/inbox?type=ownership_transfer', s.manager.token)
        .expect(200)
    ).body as { data: { id: string; number: string }[] };
    expect(inbox.data.map((i) => i.id)).toContain(t.id);
    // One waits per unit.
    expect(code(await ask(s, s.buyer))).toEqual({
      status: 409,
      code: 'OWNERSHIP_TRANSFER_PENDING',
    });

    const done = (await approve(s, t.id).expect(200)).body as TransferBody;
    expect(done).toMatchObject({
      status: 'done',
      owedNow: null,
      owedAtApproval: '0.00',
      duesExceptionCode: null,
    });
    expect(await owners(s)).toEqual([
      { accountId: s.buyer.id, occupancyType: 'owner' },
    ]);
    const history = (
      await f
        .http(
          'get',
          `/staff/units/${s.home.id}/occupancy-history`,
          s.manager.token,
        )
        .expect(200)
    ).body as {
      data: {
        account: { id: string };
        status: string;
        endReason: string | null;
      }[];
    };
    expect(
      history.data.map((o) => [o.account.id, o.status, o.endReason]),
    ).toEqual(
      expect.arrayContaining([
        [s.owner.id, 'ended', 'ownership_transferred'],
        [s.buyer.id, 'active', null],
      ]),
    );
    expect(code(await approve(s, t.id))).toEqual({
      status: 409,
      code: 'OWNERSHIP_TRANSFER_NOT_PENDING',
    });
    const audit = auditReaders(h);
    expect(
      await audit.tenant(s.c.tenantId, {
        action: 'ownership_transfer.approved',
        targetId: t.id,
      }),
    ).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          unitId: s.home.id,
          owed: '0.00',
          newOccupancyId: done.newOccupancyId,
        }) as unknown,
      }),
    ]);
  });

  it('a unit that owes is refused; an exception needs its code and a fresh step-up, and is audited with what was owed', async () => {
    const s = await setUp('Transfer Dues Court');
    await f.issue(s.manager, s.home.id);
    const t = await asked(s, s.buyer);
    expect(t.owedNow).toBe('1000.00');
    const owed = await approve(s, t.id);
    expect(code(owed)).toEqual({ status: 409, code: 'TRANSFER_DUES_OWED' });
    expect((owed.body as { params?: unknown }).params).toEqual({
      owed: '1000.00',
    });
    expect(
      code(await approve(s, t.id, { duesExceptionCode: 'bribe' })),
    ).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
    expect(
      code(
        await approve(s, t.id, { duesExceptionCode: 'dues_settled_at_sale' }),
      ),
    ).toEqual({ status: 403, code: 'STEP_UP_REQUIRED' });
    expect((await get(s, t.id)).status).toBe('pending');

    await f.stepUp(s.manager.token);
    const done = (
      await approve(s, t.id, {
        duesExceptionCode: 'dues_settled_at_sale',
      }).expect(200)
    ).body as TransferBody;
    expect(done).toMatchObject({
      status: 'done',
      owedAtApproval: '1000.00',
      duesExceptionCode: 'dues_settled_at_sale',
    });
    expect(
      await auditReaders(h).tenant(s.c.tenantId, {
        action: 'ownership_transfer.approved',
        targetId: t.id,
      }),
    ).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          owed: '1000.00',
          duesExceptionCode: 'dues_settled_at_sale',
          stepUp: true,
        }) as unknown,
      }),
    ]);
  });

  it('paid off, the transfer goes ahead with no exception; the direct route passes the same gate', async () => {
    const s = await setUp('Transfer Paid Court');
    await f.issue(s.manager, s.home.id);
    const t = await asked(s, s.buyer);
    await pay(s, '1000').expect(201);
    expect((await get(s, t.id)).owedNow).toBe('0.00');
    await approve(s, t.id).expect(200);

    const other = await setUp('Transfer Direct Court');
    await f.issue(other.manager, other.home.id);
    const direct = (over: object = {}) =>
      f.http(
        'post',
        `/units/${other.home.id}/transfer-ownership`,
        other.manager.token,
        { toAccountId: other.buyer.id, ...reason, ...over },
      );
    expect(code(await direct())).toEqual({
      status: 409,
      code: 'TRANSFER_DUES_OWED',
    });
    await f.stepUp(other.manager.token);
    await direct({ duesExceptionCode: 'payment_plan_agreed' }).expect(200);
    expect(await owners(other)).toEqual([
      { accountId: other.buyer.id, occupancyType: 'owner' },
    ]);
  });

  it('cancelled with a code, then neither approved nor cancelled again; the moves’ board shows what is owed', async () => {
    const s = await setUp('Transfer Cancel Court');
    const t = await asked(s, s.buyer);
    expect(
      code(
        await f.http(
          'post',
          `/staff/ownership-transfers/${t.id}/cancel`,
          s.manager.token,
          {},
        ),
      ),
    ).toEqual({ status: 400, code: 'REASON_REQUIRED' });
    const cancelled = (
      await f
        .http(
          'post',
          `/staff/ownership-transfers/${t.id}/cancel`,
          s.manager.token,
          { reasonCode: 'sale_cancelled' },
        )
        .expect(200)
    ).body as TransferBody;
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancelReason: 'sale_cancelled',
    });
    expect(code(await approve(s, t.id))).toEqual({
      status: 409,
      code: 'OWNERSHIP_TRANSFER_NOT_PENDING',
    });
    // A new request may wait now.
    await asked(s, s.buyer);

    await f.issue(s.manager, s.home.id);
    const occupancy = await f.x.asManager(s.c, () =>
      f.x.prisma.tenant.unitOccupancy.findFirstOrThrow({
        where: { unitId: s.home.id, accountId: s.owner.id, status: 'active' },
        select: { id: true },
      }),
    );
    const move = (
      await f
        .http('post', `/staff/units/${s.home.id}/moves`, s.manager.token, {
          occupancyId: occupancy.id,
          direction: 'out',
          plannedOn: day(3),
        })
        .expect(201)
    ).body as { id: string };
    const detail = (
      await f
        .http('get', `/staff/moves/${move.id}`, s.manager.token)
        .expect(200)
    ).body as { owed: string };
    expect(detail.owed).toBe('1000.00');
    const board = (
      await f
        .http('get', `/staff/moves?unitId=${s.home.id}`, s.manager.token)
        .expect(200)
    ).body as { id: string; owed: string }[];
    expect(board.find((m) => m.id === move.id)?.owed).toBe('1000.00');
  });

  it('race: two approvals at once — one carries the transfer out, the other finds it done', async () => {
    const s = await setUp('Transfer Race Court');
    const t = await asked(s, s.buyer);
    const answers = await queuedBehind(
      {
        sql: 'SELECT id FROM ownership_transfers WHERE id = $1 FOR UPDATE',
        params: [t.id],
      },
      [() => approve(s, t.id), () => approve(s, t.id)],
    );
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    expect(
      answers.map((a) => (a.body as { code?: string }).code).filter(Boolean),
    ).toEqual(['OWNERSHIP_TRANSFER_NOT_PENDING']);
    expect(await owners(s)).toEqual([
      { accountId: s.buyer.id, occupancyType: 'owner' },
    ]);
    expect(
      await auditReaders(h).tenant(s.c.tenantId, {
        action: 'unit.ownership_transferred',
        targetId: s.home.id,
      }),
    ).toHaveLength(1);
  });

  it('race: a payment landing while the gate reads — either it was counted, or it waits for the refusal', async () => {
    const financeLock = (s: FinanceSetUp) => ({
      sql: `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      params: [`finance-unit:${s.c.tenantId}`, s.home.id],
    });

    // The approval reads first: the unit still owes, refused; the payment
    // lands after.
    const first = await setUp('Transfer Pay Late Court');
    await f.issue(first.manager, first.home.id);
    const late = await asked(first, first.buyer);
    const [refused, paidLate] = await queuedBehind(financeLock(first), [
      () => approve(first, late.id),
      () => pay(first, '1000'),
    ]);
    expect(code(refused)).toEqual({ status: 409, code: 'TRANSFER_DUES_OWED' });
    expect(paidLate.status).toBe(201);
    expect((await get(first, late.id)).status).toBe('pending');

    // The payment lands first: the gate counts it, the transfer goes ahead.
    const second = await setUp('Transfer Pay Early Court');
    await f.issue(second.manager, second.home.id);
    const early = await asked(second, second.buyer);
    const [paid, approved] = await queuedBehind(financeLock(second), [
      () => pay(second, '1000'),
      () => approve(second, early.id),
    ]);
    expect(paid.status).toBe(201);
    expect(approved.status).toBe(200);
    expect((approved.body as TransferBody).owedAtApproval).toBe('0.00');
  });
});

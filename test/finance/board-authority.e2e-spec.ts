import { boardMatterHelpers } from '../setup/board-matters';
import { day } from '../setup/compound-clock';
import { batchRow, disputeRow, invoiceRow } from '../setup/finance-rows';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Setting {
  type: string;
  threshold: string | null;
  binding: boolean;
  bindable: boolean;
}

/**
 * ADR 0073: the board's authority, binding. A compound makes the waiver's
 * and the payment plan's thresholds binding; above one, finance refuses a
 * dispute's credit (and a plan) unless it names what an approved request
 * of the type granted, used once and never past its cost.
 */
describe('Finance — the board’s authority over a waiver and a plan', () => {
  let h: HttpHarness;
  let b: ReturnType<typeof boardMatterHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof boardMatterHelpers>['setUp']>>;
  const o = (i: number) => s.owners[i - 1];

  beforeAll(async () => {
    h = await createHttpHarness();
    b = boardMatterHelpers(h);
    s = await b.setUp(5, 3);
  }, 180_000);

  afterAll(() => h.close());

  const settings = (items: object[]) =>
    b.http('patch', '/staff/governance/settings', s.manager.token, { items });

  /** An open dispute of an invoice of `total` on an owner's unit (owner 4's). */
  async function dispute(total = '9000.00', owner = o(4)): Promise<string> {
    return b.inTx(s.c, async (tx) => {
      const batchId = await batchRow(tx, {
        tenantId: s.c.tenantId,
        unitId: owner.unitId,
        createdById: s.c.managerId,
      });
      const invoiceId = await invoiceRow(tx, {
        tenantId: s.c.tenantId,
        unitId: owner.unitId,
        batchId,
        createdById: s.c.managerId,
        total,
      });
      return disputeRow(tx, {
        tenantId: s.c.tenantId,
        unitId: owner.unitId,
        invoiceId,
        openedById: owner.id,
      });
    });
  }

  const decide = (id: string, body: Record<string, unknown>) =>
    b.http('post', `/staff/invoice-disputes/${id}/decide`, s.manager.token, {
      decision: 'accept',
      ...body,
    });

  /** A waiver request of `cost` the board approves; its authorization's id. */
  async function approvedWaiver(cost: string): Promise<string> {
    const r = await b.raise(s.manager, { type: 'waiver_above_limit', cost });
    const m = await b.motion(o(1), r.id);
    await b.vote(o(1), m.id, 'for').expect(201);
    await b.vote(o(2), m.id, 'for').expect(201);
    const list = (
      (
        await b
          .http(
            'get',
            '/staff/finance/board-authorizations?type=waiver_above_limit&unused=true',
            s.manager.token,
          )
          .expect(200)
      ).body as { data: { id: string; approvalRequestId: string }[] }
    ).data;
    const auth = list.find((a) => a.approvalRequestId === r.id);
    if (!auth) throw new Error('no authorization for the approved waiver');
    return auth.id;
  }

  it('binding is the waiver’s and the plan’s to set; major_contract always binds; the others never', async () => {
    const read = (
      (
        await b
          .http('get', '/staff/governance/settings', s.manager.token)
          .expect(200)
      ).body as { items: Setting[] }
    ).items;
    expect(read.find((r) => r.type === 'major_contract')).toMatchObject({
      binding: true,
      bindable: false,
    });
    for (const type of ['waiver_above_limit', 'payment_plan_above_limit'])
      expect(read.find((r) => r.type === type)).toMatchObject({
        binding: false,
        bindable: true,
      });
    for (const type of [
      'major_contract',
      'exceptional_fee',
      'legal_escalation',
    ]) {
      const res = await settings([{ type, binding: true }]).expect(400);
      expect((res.body as { fields: unknown[] }).fields).toEqual([
        { field: 'items[0].binding', code: 'FIELD_NOT_ALLOWED' },
      ]);
    }
  });

  it('above an advisory threshold the credit goes through; above a binding one it needs the board; within it, nothing', async () => {
    await settings([
      { type: 'waiver_above_limit', threshold: '1000.00', binding: false },
    ]).expect(200);
    await decide(await dispute(), { amount: '5000.00' }).expect(201);
    await settings([{ type: 'waiver_above_limit', binding: true }]).expect(200);
    const refused = await decide(await dispute(), { amount: '5000.00' }).expect(
      409,
    );
    expect(refused.body).toMatchObject({
      code: 'NEEDS_BOARD_APPROVAL',
      params: { type: 'waiver_above_limit', limit: '1000.00' },
    });
    await decide(await dispute(), { amount: '1000.00' }).expect(201);
    // Nothing to name within it, or on a rejection.
    const extra = await decide(await dispute(), {
      amount: '500.00',
      authorizationId: '0193b8a4-0000-7000-8000-000000000000',
    }).expect(400);
    expect((extra.body as { fields: unknown[] }).fields).toEqual([
      { field: 'authorizationId', code: 'FIELD_NOT_ALLOWED' },
    ]);
    const rejected = await b
      .http(
        'post',
        `/staff/invoice-disputes/${await dispute()}/decide`,
        s.manager.token,
        {
          decision: 'reject',
          reasonCode: 'charge_is_correct',
          authorizationId: '0193b8a4-0000-7000-8000-000000000000',
        },
      )
      .expect(400);
    expect((rejected.body as { fields: unknown[] }).fields).toEqual([
      { field: 'authorizationId', code: 'FIELD_NOT_ALLOWED' },
    ]);
  });

  it('an approved waiver authorizes one credit up to its cost: used once, never past it, never for a plan', async () => {
    await settings([
      { type: 'waiver_above_limit', threshold: '1000.00', binding: true },
    ]).expect(200);
    const auth = await approvedWaiver('6000.00');
    const over = await decide(await dispute(), {
      amount: '7000.00',
      authorizationId: auth,
    }).expect(409);
    expect(over.body).toMatchObject({
      code: 'BOARD_AUTHORIZATION_EXCEEDED',
      params: { amount: '6000.00' },
    });
    const first = await dispute();
    await decide(first, { amount: '6000.00', authorizationId: auth }).expect(
      201,
    );
    const used = (
      (
        await b
          .http(
            'get',
            '/staff/finance/board-authorizations?type=waiver_above_limit',
            s.manager.token,
          )
          .expect(200)
      ).body as {
        data: { id: string; usedAt: string | null; usedBy: object | null }[];
      }
    ).data.find((a) => a.id === auth)!;
    expect(used.usedAt).not.toBeNull();
    expect(used.usedBy).toEqual({ type: 'invoice_dispute', id: first });
    const again = await decide(await dispute(), {
      amount: '2000.00',
      authorizationId: auth,
    }).expect(409);
    expect(again.body).toMatchObject({ code: 'BOARD_AUTHORIZATION_USED' });
    // A waiver's authorization never serves a plan.
    await settings([
      { type: 'payment_plan_above_limit', threshold: '1000.00', binding: true },
    ]).expect(200);
    const other = await approvedWaiver('8000.00');
    const plan = await b
      .http(
        'post',
        `/staff/invoices/${await invoiceOfNew()}/instalment-plan`,
        s.manager.token,
        {
          instalments: [
            { amount: '4500.00', dueOn: day(30) },
            { amount: '4500.00', dueOn: day(60) },
          ],
          authorizationId: other,
        },
      )
      .expect(404);
    expect(plan.body).toMatchObject({ code: 'BOARD_AUTHORIZATION_NOT_FOUND' });
    // Without one, the plan above the binding threshold needs the board.
    const unnamed = await b
      .http(
        'post',
        `/staff/invoices/${await invoiceOfNew()}/instalment-plan`,
        s.manager.token,
        {
          instalments: [
            { amount: '4500.00', dueOn: day(30) },
            { amount: '4500.00', dueOn: day(60) },
          ],
        },
      )
      .expect(409);
    expect(unnamed.body).toMatchObject({
      code: 'NEEDS_BOARD_APPROVAL',
      params: { type: 'payment_plan_above_limit', limit: '1000.00' },
    });
  });

  it('two credits naming one authorization at once: one is made, the other is refused as used (3×)', async () => {
    await settings([
      { type: 'waiver_above_limit', threshold: '1000.00', binding: true },
    ]).expect(200);
    for (let round = 0; round < 3; round++) {
      const auth = await approvedWaiver('3000.00');
      // Two units: only the authorization's own lock stands between them.
      const [x, y] = [await dispute(), await dispute('9000.00', o(5))];
      const res = await Promise.all([
        decide(x, { amount: '3000.00', authorizationId: auth }),
        decide(y, { amount: '3000.00', authorizationId: auth }),
      ]);
      expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(
        res.find((r) => r.status === 409)!.body as { code: string },
      ).toMatchObject({ code: 'BOARD_AUTHORIZATION_USED' });
    }
  });

  /** An invoice with nothing paid, for the staff's convert. */
  async function invoiceOfNew(): Promise<string> {
    const owner = o(4);
    return b.inTx(s.c, async (tx) => {
      const batchId = await batchRow(tx, {
        tenantId: s.c.tenantId,
        unitId: owner.unitId,
        createdById: s.c.managerId,
      });
      return invoiceRow(tx, {
        tenantId: s.c.tenantId,
        unitId: owner.unitId,
        batchId,
        createdById: s.c.managerId,
        total: '9000.00',
      });
    });
  }
});

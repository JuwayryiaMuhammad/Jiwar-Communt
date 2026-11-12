import { err } from '../api/request';
import { budgetHelpers, type BudgetBody } from '../setup/budgets';
import { day } from '../setup/compound-clock';
import { uniqueSuffix } from '../setup/fixtures';
import { gateHelpers } from '../setup/gate';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { deferred } from '../setup/permits';

type Who = { id: string; token: string };
interface OrderLine {
  id: string;
  position: number;
  accepted: string;
  rejected: string;
  invoiced: string;
}
interface Order {
  id: string;
  reference: string;
  status: string;
  closeReason: string | null;
  total: string;
  committed: string;
  lines: OrderLine[];
  receipts: {
    id: string;
    reference: string;
    photos: { fileId: string; url: string | null }[];
    lines: {
      purchaseOrderLineId: string;
      accepted: string;
      rejected: string;
      rejectReason: string | null;
      stockMovementId: string | null;
    }[];
  }[];
}
interface Invoice {
  id: string;
  status: string;
  total: string;
  purchaseOrderId: string | null;
}
interface Match {
  status: string;
  purchaseOrderId: string | null;
  priceVariance: string;
  issues: {
    kind: string;
    position: number;
    quantity: string | null;
    amount: string;
  }[];
  lines: {
    position: number;
    issues: string[];
    otherInvoicedQuantity: string | null;
  }[];
  override: { reasonCode: string; overriddenByMe: boolean } | null;
}

/**
 * ADR 0094: goods and service receipts in parts (accepted, rejected with a
 * reason, photos) writing the stock receipt of ADR 0065; the three-way match
 * of a vendor's invoice against its order and what was accepted, within the
 * compound's tolerances; a mismatch blocking the invoice's approval until a
 * receipt, a corrected invoice or an audited override; an order required
 * above an amount; what is left of an order cancelled; the three reports.
 */
describe('Goods receipts and the three-way match (ADR 0094)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof budgetHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof budgetHelpers>['setUp']>>;
  let budget: BudgetBody;
  let supervisor: Who;
  let vendorId: string;
  let storeId: string;

  const http = (
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    token: string,
    body?: object,
  ) => f.http(method, path, token, body);
  const m = () => s.manager.token;
  const acc = () => s.accountant.token;
  const sup = () => supervisor.token;
  const line = () => budget.lines[0];
  const lineView = async () =>
    (await f.budgetView(s.accountant, budget.id)).lines[0] as unknown as {
      committed: string;
      available: string;
    };
  const goods = (qty: string, price: string, over: object = {}) => ({
    kind: 'goods',
    description: 'Gaskets',
    quantity: qty,
    unit: 'box',
    unitPrice: price,
    ...over,
  });
  const service = (price: string, over: object = {}) => ({
    kind: 'service',
    description: 'Installation',
    quantity: '1',
    unit: 'lot',
    unitPrice: price,
    ...over,
  });
  /** An approved order of `lines`, raised by the accountant. */
  const approvedOrder = async (lines: object[], over: object = {}) => {
    const o = (
      await http('post', '/staff/purchase-orders', acc(), {
        vendorId,
        budgetLineId: line().id,
        deliveryOn: day(10),
        lines,
        ...over,
      }).expect(201)
    ).body as Order;
    await http(
      'post',
      `/staff/purchase-orders/${o.id}/approve`,
      m(),
      {},
    ).expect(200);
    return order(o.id);
  };
  const order = async (id: string) =>
    (await http('get', `/staff/purchase-orders/${id}`, m()).expect(200))
      .body as Order;
  const receive = (
    orderId: string,
    lines: object[],
    by = sup(),
    over: object = {},
  ) =>
    http('post', `/staff/purchase-orders/${orderId}/receipts`, by, {
      receivedOn: day(0),
      lines,
      ...over,
    });
  const take = (lineId: string, accepted: string, over: object = {}) => ({
    purchaseOrderLineId: lineId,
    accepted,
    ...over,
  });
  /** An invoice of the order, recorded by `by` (the accountant by default). */
  const bill = (
    orderId: string,
    lines: { lineId: string; quantity: string; unitPrice: string }[],
    by: Who = s.accountant,
    over: object = {},
  ) =>
    deferred(
      (async () =>
        http('post', '/staff/finance/vendor-invoices', by.token, {
          purchaseOrderId: orderId,
          vendorNumber: `V-${uniqueSuffix()}`,
          issuedOn: day(0),
          dueOn: day(30),
          invoiceFileId: await f.invoice(by),
          lines: lines.map((l) => ({
            description: 'Billed',
            purchaseOrderLineId: l.lineId,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
          })),
          ...over,
        }))(),
    );
  const billed = async (...args: Parameters<typeof bill>) =>
    (await bill(...args).expect(201)).body as Invoice;
  const matchOf = async (invoiceId: string, by = m()) =>
    (
      await http(
        'get',
        `/staff/finance/vendor-invoices/${invoiceId}/match`,
        by,
      ).expect(200)
    ).body as Match;
  const approveInvoice = (invoiceId: string, by = m()) =>
    http('post', `/staff/finance/vendor-invoices/${invoiceId}/approve`, by, {});
  const settings = (body: object) =>
    http('patch', '/staff/finance/purchase-order-settings', m(), body);

  beforeAll(async () => {
    h = await createHttpHarness();
    f = budgetHelpers(h);
    s = await f.setUp(4, 3);
    budget = await f.activeBudget(
      s.accountant,
      [s.owners[0], s.owners[1]],
      [{ category: 'maintenance', amount: '900000.00' }],
    );
    await http('patch', '/staff/governance/settings', m(), {
      items: [{ type: 'major_contract', threshold: '100000.00' }],
    }).expect(200);
    const g = await gateHelpers(h).guard(s.c, 'maintenance_supervisor');
    supervisor = await f.who(s.c, g.id, 'staff');
    vendorId = (
      (
        await http('post', '/staff/vendors', m(), {
          name: `Receiving ${uniqueSuffix()}`,
          categories: ['supplies'],
        }).expect(201)
      ).body as { id: string }
    ).id;
    storeId = (
      (
        await http('post', '/maintenance/stores', m(), {
          code: `PO-${uniqueSuffix()}`,
          nameAr: 'مخزن',
          nameEn: 'Receiving store',
        }).expect(201)
      ).body as { id: string }
    ).id;
  }, 240_000);

  afterAll(() => h.close());

  describe('raised by the maintenance supervisor', () => {
    it('reads the budgets to name the line, and the vendors and the stock, so a whole order is theirs to raise; the budget itself stays the accountant’s and the manager’s', async () => {
      const active = (
        await http('get', '/staff/finance/budgets?status=active', sup()).expect(
          200,
        )
      ).body as { data: { id: string }[] };
      expect(active.data.map((b) => b.id)).toContain(budget.id);
      const read = (
        await http('get', `/staff/finance/budgets/${budget.id}`, sup()).expect(
          200,
        )
      ).body as { lines: { id: string }[] };
      expect(read.lines.map((l) => l.id)).toContain(line().id);
      await http('get', '/staff/vendors?status=active', sup()).expect(200);
      await http('get', '/maintenance/stock/items?active=true', sup()).expect(
        200,
      );
      const o = (
        await http('post', '/staff/purchase-orders', sup(), {
          vendorId,
          budgetLineId: line().id,
          deliveryOn: day(10),
          lines: [service('1500.00')],
        }).expect(201)
      ).body as Order;
      expect(o.status).toBe('requested');
      // Reading is all: the budget's lines, its settings and its expenses
      // stay with finance.budget.
      await http('put', `/staff/finance/budgets/${budget.id}/lines`, sup(), {
        lines: [],
      }).expect(403);
      await http('get', '/staff/finance/budget-settings', sup()).expect(403);
      await http('get', '/staff/finance/expenses', sup()).expect(403);
      // Who neither keeps the budget nor raises an order still reads none.
      const guard = await gateHelpers(h).guard(s.c);
      const g = await f.who(s.c, guard.id, 'staff');
      await http('get', '/staff/finance/budgets', g.token).expect(403);
      await http('get', `/staff/finance/budgets/${budget.id}`, g.token).expect(
        403,
      );
    });
  });

  describe('raised by the accountant', () => {
    it('lists the stock items to name a stock line, so the accountant’s order carries one; the store itself stays with who keeps the stock', async () => {
      const item = (
        await http('post', '/maintenance/stock/items', m(), {
          sku: `AC-${uniqueSuffix()}`,
          nameAr: 'فلتر',
          nameEn: 'Filter',
          unit: 'piece',
        }).expect(201)
      ).body as { id: string };
      const listed = (
        await http('get', '/maintenance/stock/items?active=true', acc()).expect(
          200,
        )
      ).body as { data: { id: string }[] };
      expect(listed.data.map((i) => i.id)).toContain(item.id);
      const o = (
        await http('post', '/staff/purchase-orders', acc(), {
          vendorId,
          budgetLineId: line().id,
          deliveryOn: day(10),
          lines: [
            {
              kind: 'stock',
              stockItemId: item.id,
              quantity: '4',
              unitPrice: '75.00',
            },
          ],
        }).expect(201)
      ).body as Order;
      expect(o.lines).toEqual([
        expect.objectContaining({ kind: 'stock', stockItemId: item.id }),
      ]);
      // Listing is all: an item's card, the stores, the movements and every
      // change stay stock.manage's.
      await http('get', `/maintenance/stock/items/${item.id}`, acc()).expect(
        403,
      );
      await http('get', '/maintenance/stores', acc()).expect(403);
      await http('get', '/maintenance/stock/movements', acc()).expect(403);
      await http('post', '/maintenance/stock/items', acc(), {
        sku: `AX-${uniqueSuffix()}`,
        nameAr: 'صنف',
        nameEn: 'Item',
        unit: 'piece',
      }).expect(403);
      // Who neither keeps the stock nor raises an order lists none.
      const guard = await gateHelpers(h).guard(s.c);
      const g = await f.who(s.c, guard.id, 'staff');
      await http('get', '/maintenance/stock/items', g.token).expect(403);
    });
  });

  describe('receipts', () => {
    it('are in parts: accepted and rejected with a reason, a note and photos; a stock line goes into the store at the order’s cost', async () => {
      const item = (
        await http('post', '/maintenance/stock/items', m(), {
          sku: `RC-${uniqueSuffix()}`,
          nameAr: 'صمام',
          nameEn: 'Valve',
          unit: 'piece',
        }).expect(201)
      ).body as { id: string };
      const o = await approvedOrder([
        {
          kind: 'stock',
          stockItemId: item.id,
          quantity: '10',
          unitPrice: '50.00',
        },
        goods('4', '100.00'),
        service('2000.00'),
      ]);
      const [stock, boxes, install] = o.lines;
      // A stock line needs its store; a store needs a stock line.
      expect(
        err(await receive(o.id, [take(stock.id, '6')]).expect(400)).fields,
      ).toEqual([
        expect.objectContaining({ field: 'storeId', code: 'FIELD_REQUIRED' }),
      ]);
      expect(
        err(
          await receive(o.id, [take(boxes.id, '1')], sup(), { storeId }).expect(
            400,
          ),
        ).fields,
      ).toEqual([
        expect.objectContaining({
          field: 'storeId',
          code: 'FIELD_NOT_ALLOWED',
        }),
      ]);
      // A rejection has its reason, and only it.
      expect(
        err(
          await receive(o.id, [take(boxes.id, '1', { rejected: '1' })]).expect(
            400,
          ),
        ).fields,
      ).toEqual([
        expect.objectContaining({
          field: 'lines.0.rejectReason',
          code: 'FIELD_REQUIRED',
        }),
      ]);
      expect(
        err(
          await receive(o.id, [
            take(boxes.id, '1', { rejectReason: 'damaged' }),
          ]).expect(400),
        ).fields,
      ).toEqual([
        expect.objectContaining({
          field: 'lines.0.rejectReason',
          code: 'FIELD_NOT_ALLOWED',
        }),
      ]);
      const photo = await f.files.ready(
        sup(),
        'goods_receipt_photo',
        'image/png',
      );
      const first = (
        await receive(
          o.id,
          [
            take(stock.id, '6', {
              rejected: '2',
              rejectReason: 'damaged',
              note: 'Two arrived cracked',
            }),
          ],
          sup(),
          { storeId, deliveryNote: 'DN-77', photoFileIds: [photo] },
        ).expect(201)
      ).body as Order['receipts'][number];
      expect(first.reference).toMatch(/^GR-\d{6}$/);
      expect(first.lines[0]).toMatchObject({
        accepted: '6.000',
        rejected: '2.000',
        rejectReason: 'damaged',
      });
      expect(first.photos).toHaveLength(1);
      expect(first.photos[0].url).toContain('http');
      // The stock receipt: at the order's cost, linked to the receipt.
      const movement = await f.inTx(s.c, (tx) =>
        tx.stockMovement.findFirstOrThrow({
          where: { goodsReceiptId: first.id },
        }),
      );
      expect(movement).toMatchObject({
        id: first.lines[0].stockMovementId,
        kind: 'receive',
        reference: first.reference,
        itemId: item.id,
        storeId,
      });
      expect(movement.quantity.toFixed(3)).toBe('6.000');
      expect(movement.unitCost?.toFixed(2)).toBe('50.00');
      const stocked = await f.inTx(s.c, (tx) =>
        tx.stockItem.findUniqueOrThrow({ where: { id: item.id } }),
      );
      expect(stocked.averageCost?.toFixed(2)).toBe('50.00');
      // The rejected is not received: the rest of the order is still to come.
      const seen = await order(o.id);
      expect(seen.lines[0]).toMatchObject({
        accepted: '6.000',
        rejected: '2.000',
      });
      // More than the order takes, with no tolerance, is refused.
      expect(
        err(
          await receive(o.id, [take(stock.id, '5')], sup(), { storeId }).expect(
            409,
          ),
        ),
      ).toMatchObject({
        code: 'GOODS_RECEIPT_EXCEEDS_ORDER',
        params: { max: '4.000' },
      });
      // Goods and a service confirmed; the raiser confirms a service alone.
      await receive(o.id, [take(boxes.id, '4')]).expect(201);
      expect(
        err(await receive(o.id, [take(boxes.id, '0.5')], acc()).expect(403))
          .code,
      ).toBe('FORBIDDEN');
      await receive(o.id, [take(install.id, '1')], acc()).expect(201);
      expect(
        err(await receive(o.id, [take(install.id, '1')], acc()).expect(409)),
      ).toMatchObject({ code: 'GOODS_RECEIPT_EXCEEDS_ORDER' });
      // A service line confirmed by someone who neither raised nor holds the permission.
      const other = await approvedOrder([service('300.00')]);
      const confirmed = await receive(
        other.id,
        [take(other.lines[0].id, '1')],
        m(),
      );
      expect(confirmed.status).toBe(201);
      expect((confirmed.body as { reference: string }).reference).toMatch(
        /^GR-/,
      );
    });

    it('wait for an approved order, and a receipt on a waiting order is refused', async () => {
      const o = (
        await http('post', '/staff/purchase-orders', acc(), {
          vendorId,
          budgetLineId: line().id,
          deliveryOn: day(10),
          lines: [goods('1', '10.00')],
        }).expect(201)
      ).body as Order;
      // No line yet: the order’s lines are read from the waiting order.
      const detail = await order(o.id);
      expect(
        err(await receive(o.id, [take(detail.lines[0].id, '1')]).expect(409)),
      ).toMatchObject({
        code: 'PURCHASE_ORDER_STATE',
        params: { status: 'requested' },
      });
    });

    it('a receipt tolerance raises what an order takes', async () => {
      const o = await approvedOrder([goods('10', '10.00')]);
      await settings({ quantityPct: '10' }).expect(200);
      try {
        await receive(o.id, [take(o.lines[0].id, '11')]).expect(201);
        expect(
          err(await receive(o.id, [take(o.lines[0].id, '0.1')]).expect(409)),
        ).toMatchObject({ params: { max: '0.000' } });
      } finally {
        await settings({ quantityPct: '0' }).expect(200);
      }
    });
  });

  describe('the three-way match', () => {
    it('blocks an invoice for what was not received until it is received; within tolerance it goes on to approval', async () => {
      const o = await approvedOrder([goods('10', '100.00'), service('500.00')]);
      const [boxes, install] = o.lines;
      await receive(o.id, [take(boxes.id, '6')]).expect(201);
      const a = await billed(o.id, [
        { lineId: boxes.id, quantity: '6', unitPrice: '100.00' },
        { lineId: install.id, quantity: '1', unitPrice: '500.00' },
      ]);
      expect(a.purchaseOrderId).toBe(o.id);
      const blocked = await matchOf(a.id);
      expect(blocked).toMatchObject({ status: 'blocked' });
      expect(blocked.issues).toEqual([
        expect.objectContaining({
          kind: 'quantity_not_received',
          position: 2,
          quantity: '1.000',
        }),
      ]);
      expect(err(await approveInvoice(a.id))).toMatchObject({
        statusCode: 409,
        code: 'INVOICE_MATCH_BLOCKED',
        params: { issues: 1 },
      });
      // The service is confirmed: nothing else to resolve.
      await receive(o.id, [take(install.id, '1')], acc()).expect(201);
      expect(await matchOf(a.id)).toMatchObject({
        status: 'matched',
        issues: [],
      });
      const done = (await approveInvoice(a.id).expect(200)).body as Invoice;
      expect(done.status).toBe('approved');
      // 1 100 of the order’s 1 500 is invoiced: the commitment keeps 400.
      expect((await order(o.id)).committed).toBe('400.00');
      // The rest is received and billed 1 % over the order’s price: within
      // tolerance, the variance reported, approved as any.
      await receive(o.id, [take(boxes.id, '4')]).expect(201);
      const b = await billed(o.id, [
        { lineId: boxes.id, quantity: '4', unitPrice: '101.00' },
      ]);
      expect(await matchOf(b.id)).toMatchObject({
        status: 'matched',
        priceVariance: '4.00',
      });
      await approveInvoice(b.id).expect(200);
      // Fully received and invoiced: the order closes, giving back its rest.
      const closed = await order(o.id);
      expect(closed).toMatchObject({
        status: 'closed',
        closeReason: 'completed',
        committed: '0.00',
      });
      expect(closed.lines.map((l) => l.invoiced)).toEqual(['10.000', '1.000']);
    });

    it('a price above the tolerance blocks; a corrected invoice resolves it, and so does an override by someone who did not record it', async () => {
      const o = await approvedOrder([goods('10', '100.00')]);
      const [boxes] = o.lines;
      await receive(o.id, [take(boxes.id, '10')]).expect(201);
      const dear = await billed(o.id, [
        { lineId: boxes.id, quantity: '10', unitPrice: '110.00' },
      ]);
      expect(await matchOf(dear.id)).toMatchObject({
        status: 'blocked',
        issues: [
          expect.objectContaining({ kind: 'price_over', amount: '100.00' }),
        ],
      });
      // Not by who recorded it; not by a role without the permission.
      await http(
        'post',
        `/staff/finance/vendor-invoices/${dear.id}/match/override`,
        acc(),
        { reasonCode: 'vendor_price_agreed' },
      ).expect(403);
      // A corrected invoice: the first called off with its reason, the number freed.
      await http(
        'post',
        `/staff/finance/vendor-invoices/${dear.id}/cancel`,
        acc(),
        {
          reasonCode: 'corrected',
        },
      ).expect(200);
      const right = await billed(o.id, [
        { lineId: boxes.id, quantity: '10', unitPrice: '100.00' },
      ]);
      expect(await matchOf(right.id)).toMatchObject({ status: 'matched' });
      await http(
        'post',
        `/staff/finance/vendor-invoices/${right.id}/cancel`,
        acc(),
        {
          reasonCode: 'entered_in_error',
        },
      ).expect(200);
      // Recorded by the manager: the manager never overrides its match.
      const again = await billed(
        o.id,
        [{ lineId: boxes.id, quantity: '10', unitPrice: '110.00' }],
        s.manager,
      );
      expect(
        err(
          await http(
            'post',
            `/staff/finance/vendor-invoices/${again.id}/match/override`,
            m(),
            { reasonCode: 'vendor_price_agreed' },
          ),
        ),
      ).toMatchObject({ statusCode: 409, code: 'MATCH_SELF_OVERRIDE' });
      await http(
        'post',
        `/staff/finance/vendor-invoices/${again.id}/cancel`,
        m(),
        {
          reasonCode: 'entered_in_error',
        },
      ).expect(200);
      // Recorded by the accountant, let through by the manager with a reason.
      const agreed = await billed(o.id, [
        { lineId: boxes.id, quantity: '10', unitPrice: '110.00' },
      ]);
      const view = (
        await http(
          'post',
          `/staff/finance/vendor-invoices/${agreed.id}/match/override`,
          m(),
          { reasonCode: 'vendor_price_agreed', note: 'Agreed by phone' },
        ).expect(200)
      ).body as Match;
      expect(view).toMatchObject({
        status: 'overridden',
        override: { reasonCode: 'vendor_price_agreed', overriddenByMe: true },
      });
      expect(
        err(
          await http(
            'post',
            `/staff/finance/vendor-invoices/${agreed.id}/match/override`,
            m(),
            { reasonCode: 'rounding' },
          ),
        ),
      ).toMatchObject({ statusCode: 409 });
      expect((await approveInvoice(agreed.id).expect(200)).body).toMatchObject({
        status: 'approved',
        total: '1100.00',
      });
      // The price variance stays in the line’s category: the invoice’s total
      // is what the line spent.
      expect(await matchOf(agreed.id)).toMatchObject({
        priceVariance: '100.00',
      });
    });

    it('counts what the other invoices of the order billed; an extra line within the amount tolerance goes through', async () => {
      const o = await approvedOrder([goods('10', '100.00')]);
      const [boxes] = o.lines;
      await receive(o.id, [take(boxes.id, '10')]).expect(201);
      const first = await billed(o.id, [
        { lineId: boxes.id, quantity: '6', unitPrice: '100.00' },
      ]);
      const second = await billed(o.id, [
        { lineId: boxes.id, quantity: '6', unitPrice: '100.00' },
      ]);
      expect(await matchOf(first.id)).toMatchObject({ status: 'matched' });
      const m2 = await matchOf(second.id);
      expect(m2).toMatchObject({ status: 'blocked' });
      expect(m2.issues[0]).toMatchObject({
        kind: 'quantity_over_order',
        quantity: '2.000',
      });
      expect(m2.lines[0].otherInvoicedQuantity).toBe('6.000');
      // Freight: an invoice line naming no order line, small enough.
      const o2 = await approvedOrder([goods('10', '100.00')]);
      await receive(o2.id, [take(o2.lines[0].id, '10')]).expect(201);
      const third = (
        await http('post', '/staff/finance/vendor-invoices', acc(), {
          purchaseOrderId: o2.id,
          vendorNumber: `F-${uniqueSuffix()}`,
          issuedOn: day(0),
          dueOn: day(30),
          invoiceFileId: await f.invoice(s.accountant),
          lines: [
            {
              description: 'Billed',
              purchaseOrderLineId: o2.lines[0].id,
              quantity: '10',
              unitPrice: '100.00',
            },
            { description: 'Freight', amount: '80.00' },
          ],
        }).expect(201)
      ).body as Invoice;
      expect(await matchOf(third.id)).toMatchObject({ status: 'matched' });
      const big = (
        await http('post', '/staff/finance/vendor-invoices', acc(), {
          purchaseOrderId: o2.id,
          vendorNumber: `F-${uniqueSuffix()}`,
          issuedOn: day(0),
          dueOn: day(30),
          invoiceFileId: await f.invoice(s.accountant),
          lines: [{ description: 'Freight', amount: '150.00' }],
        }).expect(201)
      ).body as Invoice;
      expect(await matchOf(big.id)).toMatchObject({
        status: 'blocked',
        issues: [
          expect.objectContaining({ kind: 'extra_line', amount: '150.00' }),
        ],
      });
      // Against its own vendor’s lines only.
      const stranger = await approvedOrder([goods('1', '10.00')]);
      expect(
        err(
          await bill(o.id, [
            { lineId: stranger.lines[0].id, quantity: '1', unitPrice: '10.00' },
          ]).expect(400),
        ).fields,
      ).toEqual([
        expect.objectContaining({
          field: 'lines.0.purchaseOrderLineId',
          code: 'INVALID_VALUE',
        }),
      ]);
    });

    it('an invoice states its order’s line with a quantity and a unit price, or its amount, never both', async () => {
      const o = await approvedOrder([goods('2', '10.00')]);
      const res = deferred(
        (async () =>
          http('post', '/staff/finance/vendor-invoices', acc(), {
            purchaseOrderId: o.id,
            vendorNumber: `X-${uniqueSuffix()}`,
            issuedOn: day(0),
            dueOn: day(30),
            invoiceFileId: await f.invoice(s.accountant),
            lines: [
              {
                description: 'Both',
                purchaseOrderLineId: o.lines[0].id,
                quantity: '1',
                unitPrice: '10.00',
                amount: '10.00',
              },
              { description: 'Neither' },
              { description: 'Loose', amount: '5.00', quantity: '1' },
            ],
          }))(),
      );
      expect(err(await res.expect(400)).fields).toEqual([
        expect.objectContaining({
          field: 'lines.0.amount',
          code: 'FIELD_NOT_ALLOWED',
        }),
        expect.objectContaining({
          field: 'lines.1.amount',
          code: 'FIELD_REQUIRED',
        }),
        expect.objectContaining({
          field: 'lines.2.quantity',
          code: 'FIELD_NOT_ALLOWED',
        }),
      ]);
    });
  });

  describe('an order required', () => {
    it('above the compound’s amount an invoice with no contract needs one; never by default', async () => {
      const request = async () =>
        (
          await http('post', '/staff/purchase-requests', acc(), {
            title: 'Cleaning supplies',
            estimatedAmount: '3000.00',
            vendorId,
            budgetLineId: line().id,
          }).expect(201)
        ).body as { id: string };
      const fulfilled = async () => {
        const r = await request();
        await http(
          'post',
          `/staff/purchase-requests/${r.id}/approve`,
          m(),
          {},
        ).expect(200);
        await http('post', `/staff/purchase-requests/${r.id}/fulfil`, m(), {
          reference: 'cash',
        }).expect(200);
        return r.id;
      };
      const invoiceOf = (purchaseRequestId: string, amount: string) =>
        deferred(
          (async () =>
            http('post', '/staff/finance/vendor-invoices', acc(), {
              purchaseRequestId,
              vendorNumber: `R-${uniqueSuffix()}`,
              issuedOn: day(0),
              dueOn: day(30),
              invoiceFileId: await f.invoice(s.accountant),
              lines: [{ description: 'Supplies', amount }],
            }))(),
        );
      const defaults = (
        await http(
          'get',
          '/staff/finance/purchase-order-settings',
          acc(),
        ).expect(200)
      ).body as Record<string, string | null>;
      expect(defaults).toEqual({
        poRequiredAbove: null,
        pricePct: '2.00',
        quantityPct: '0.00',
        amount: '100.00',
      });
      const r1 = await fulfilled();
      await invoiceOf(r1, '5000.00').expect(201);
      await settings({ poRequiredAbove: '1000.00' }).expect(200);
      try {
        const r2 = await fulfilled();
        await invoiceOf(r2, '1000.00').expect(201);
        expect(err(await invoiceOf(r2, '1000.01'))).toMatchObject({
          statusCode: 409,
          code: 'VENDOR_INVOICE_PO_REQUIRED',
          params: { above: '1000.00' },
        });
      } finally {
        await settings({ poRequiredAbove: null }).expect(200);
      }
    });

    it('the settings are kept by an approver of payables, audited, and checked', async () => {
      await http('patch', '/staff/finance/purchase-order-settings', acc(), {
        pricePct: '3',
      }).expect(403);
      expect(
        err(await settings({ pricePct: '101' }).expect(400)).fields,
      ).toEqual([
        expect.objectContaining({ field: 'pricePct', code: 'INVALID_VALUE' }),
      ]);
      const changed = (
        await settings({ pricePct: '3.50', amount: '250' }).expect(200)
      ).body as Record<string, string | null>;
      expect(changed).toMatchObject({ pricePct: '3.50', amount: '250.00' });
      await settings({ pricePct: '2', amount: '100' }).expect(200);
    });

    it('a request an order took over is invoiced through the order', async () => {
      const r = (
        await http('post', '/staff/purchase-requests', acc(), {
          title: 'Hoses',
          estimatedAmount: '900.00',
          vendorId,
          budgetLineId: line().id,
        }).expect(201)
      ).body as { id: string };
      await http(
        'post',
        `/staff/purchase-requests/${r.id}/approve`,
        m(),
        {},
      ).expect(200);
      const o = (
        await http('post', '/staff/purchase-orders', acc(), {
          purchaseRequestId: r.id,
          deliveryOn: day(3),
          lines: [goods('3', '300.00')],
        }).expect(201)
      ).body as Order;
      await http(
        'post',
        `/staff/purchase-orders/${o.id}/approve`,
        m(),
        {},
      ).expect(200);
      expect(
        err(
          await http('post', '/staff/finance/vendor-invoices', acc(), {
            purchaseRequestId: r.id,
            vendorNumber: `H-${uniqueSuffix()}`,
            issuedOn: day(0),
            dueOn: day(30),
            invoiceFileId: await f.invoice(s.accountant),
            lines: [{ description: 'Hoses', amount: '900.00' }],
          }),
        ),
      ).toMatchObject({
        code: 'VENDOR_INVOICE_SOURCE_INVALID',
        params: { reason: 'ordered' },
      });
    });
  });

  describe('what is left of an order', () => {
    it('cancelled with a code: nothing received gives the whole commitment back; later receipts are refused', async () => {
      const before = await lineView();
      const o = await approvedOrder([goods('10', '100.00')]);
      expect(Number((await lineView()).committed)).toBeCloseTo(
        Number(before.committed) + 1000,
      );
      expect(
        err(
          await http('post', `/staff/purchase-orders/${o.id}/cancel`, acc(), {
            reasonCode: 'nonsense',
          }),
        ),
      ).toMatchObject({ statusCode: 400 });
      const done = (
        await http('post', `/staff/purchase-orders/${o.id}/cancel`, acc(), {
          reasonCode: 'vendor_unavailable',
        }).expect(200)
      ).body as Order;
      expect(done).toMatchObject({
        status: 'closed',
        closeReason: 'remainder_cancelled',
        committed: '0.00',
      });
      expect((await lineView()).committed).toBe(before.committed);
      expect(
        err(await receive(o.id, [take(o.lines[0].id, '1')]).expect(409)),
      ).toMatchObject({
        code: 'PURCHASE_ORDER_STATE',
        params: { status: 'closed' },
      });
    });

    it('cancelled after a part arrived: the commitment keeps the value of what arrived until it is invoiced', async () => {
      const o = await approvedOrder([goods('10', '100.00')]);
      const [boxes] = o.lines;
      await receive(o.id, [take(boxes.id, '4')]).expect(201);
      const done = (
        await http('post', `/staff/purchase-orders/${o.id}/cancel`, m(), {
          reasonCode: 'price_changed',
        }).expect(200)
      ).body as Order;
      expect(done).toMatchObject({
        status: 'closed',
        closeReason: 'remainder_cancelled',
        committed: '400.00',
      });
      const inv = await billed(o.id, [
        { lineId: boxes.id, quantity: '4', unitPrice: '100.00' },
      ]);
      expect(await matchOf(inv.id)).toMatchObject({ status: 'matched' });
      await approveInvoice(inv.id).expect(200);
      expect((await order(o.id)).committed).toBe('0.00');
    });

    it('an amendment goes no lower than what was received or invoiced of a line, and keeps a line with history', async () => {
      const o = await approvedOrder([goods('10', '100.00'), service('200.00')]);
      const [boxes, install] = o.lines;
      await receive(o.id, [take(boxes.id, '4')]).expect(201);
      const amend = (lines: object[]) =>
        http('post', `/staff/purchase-orders/${o.id}/amend`, acc(), {
          reasonCode: 'quantity_change',
          lines,
        });
      expect(
        err(
          await amend([
            { id: boxes.id, ...goods('3', '100.00') },
            { id: install.id, ...service('200.00') },
          ]),
        ),
      ).toMatchObject({
        statusCode: 409,
        code: 'PURCHASE_ORDER_LINE_BELOW_USED',
        params: { min: '4.000' },
      });
      expect(
        err(await amend([{ id: install.id, ...service('200.00') }])),
      ).toMatchObject({ code: 'PURCHASE_ORDER_LINE_BELOW_USED' });
      // The line with nothing against it may go.
      await amend([{ id: boxes.id, ...goods('4', '100.00') }]).expect(200);
      const done = (
        await http(
          'post',
          `/staff/purchase-orders/${o.id}/approve`,
          m(),
          {},
        ).expect(200)
      ).body as Order;
      expect(done.total).toBe('400.00');
      expect(done.committed).toBe('400.00');
    });
  });

  describe('the reports', () => {
    it('open orders, received and not invoiced, and match exceptions — for who keeps payables', async () => {
      const o = await approvedOrder([goods('10', '100.00')]);
      const [boxes] = o.lines;
      await receive(o.id, [take(boxes.id, '5')]).expect(201);
      await billed(o.id, [
        { lineId: boxes.id, quantity: '8', unitPrice: '100.00' },
      ]);
      const view = (key: string, query = '', by = acc()) =>
        http(
          'get',
          `/staff/reports/view?report=${key}&from=${day(-3)}&to=${day(0)}${query}`,
          by,
        );
      const open = (await view('po_open').expect(200)).body as {
        rows: { values: (string | null)[] }[];
      };
      expect(open.rows.map((r) => r.values)).toContainEqual([
        o.reference,
        expect.any(String),
        day(10),
        '1000.00',
        '500.00',
        '0.00',
        '1000.00',
      ]);
      const rni = (await view('po_received_not_invoiced').expect(200)).body as {
        rows: { values: (string | null)[] }[];
      };
      expect(rni.rows.map((r) => r.values)).toContainEqual([
        o.reference,
        expect.any(String),
        day(0),
        '500.00',
      ]);
      const byVendor = (
        await view('po_received_not_invoiced', '&groupBy=vendor').expect(200)
      ).body as { rows: { values: (string | null)[] }[] };
      expect(byVendor.rows.length).toBeGreaterThan(0);
      const exceptions = (await view('po_match_exceptions').expect(200))
        .body as {
        rows: { values: (string | null)[] }[];
      };
      expect(exceptions.rows.map((r) => r.values.slice(1, 5))).toContainEqual([
        o.reference,
        expect.any(String),
        'blocked',
        '1',
      ]);
      const byIssue = (
        await view('po_match_exceptions', '&groupBy=issue').expect(200)
      ).body as { rows: { values: (string | null)[] }[] };
      expect(byIssue.rows.map((r) => r.values[0])).toContain(
        'quantity_not_received',
      );
      // The supervisor keeps no payables: the report is not theirs.
      expect(err(await view('po_open', '', sup()).expect(403)).code).toBe(
        'REPORT_NOT_YOURS',
      );
    });
  });
});

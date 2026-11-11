import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { M37_COVERAGE } from '../setup/audit-coverage-split';
import { budgetHelpers, type BudgetBody } from '../setup/budgets';
import { day } from '../setup/compound-clock';
import { nationalIdFor, uniquePhone, uniqueSuffix } from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  type HttpHarness,
} from '../setup/http-app';
import { deferred } from '../setup/permits';

/**
 * One scenario per entry of purchase orders’ catalog (ADR 0014, 0094): the
 * actor, the compound, ids, numbers, codes, quantities, days and amounts —
 * a note, a delivery note and a decision’s words as `{ changed }` only.
 */
const covered = new Set<string>();

interface Order {
  id: string;
  reference: string;
  lines: { id: string }[];
}

describe('Audit coverage — purchase orders', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof budgetHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: Awaited<ReturnType<ReturnType<typeof budgetHelpers>['setUp']>>;
  let budget: BudgetBody;
  let vendorId: string;
  let contractorToken: string;
  let contractorId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = budgetHelpers(h);
    read = auditReaders(h);
    s = await f.setUp(4, 3);
    budget = await f.activeBudget(
      s.accountant,
      [s.owners[0], s.owners[1]],
      [{ category: 'maintenance', amount: '100000.00' }],
    );
    vendorId = (
      (
        await f
          .http('post', '/staff/vendors', s.manager.token, {
            name: `PO audit vendor ${uniqueSuffix()}`,
            categories: ['supplies'],
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    const made = await f
      .http('post', `/staff/vendors/${vendorId}/contractors`, s.manager.token, {
        fullName: 'Audit Contractor',
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(new Date('1987-05-05')),
        phone: uniquePhone(),
        email: uniqueEmail('po-audit'),
      })
      .expect(201);
    contractorId = (made.body as { id: string }).id;
    contractorToken = await h.tokenFor({
      sub: contractorId,
      tid: s.c.tenantId,
      typ: 'contractor',
    });
  }, 240_000);

  afterAll(() => h.close());

  const m = () => s.manager.token;
  const acc = () => s.accountant.token;
  const rows = (action: string, targetId: string) =>
    read.tenant(s.c.tenantId, { action, targetId });
  const svc = (price = '1000.00', over: object = {}) => ({
    kind: 'service',
    description: 'AUDIT-secret pump work',
    quantity: '1',
    unit: 'lot',
    unitPrice: price,
    ...over,
  });
  const raise = async (over: object = {}) =>
    (
      await f
        .http('post', '/staff/purchase-orders', acc(), {
          vendorId,
          budgetLineId: budget.lines[0].id,
          deliveryOn: day(10),
          lines: [svc()],
          ...over,
        })
        .expect(201)
    ).body as Order;
  const approve = (id: string, by = m()) =>
    f.http('post', `/staff/purchase-orders/${id}/approve`, by, {});
  const approved = async (over: object = {}) => {
    const o = await raise(over);
    await approve(o.id).expect(200);
    return o;
  };

  it('purchase_order.raised and .approved — the number, the source, the vendor, the line, the totals; the note as { changed }', async () => {
    const o = await raise({ note: 'AUDIT-secret note' });
    const raised = await rows('purchase_order.raised', o.id);
    expect(raised.map((r) => [r.actorId, r.metadata])).toEqual([
      [
        s.accountant.id,
        {
          number: Number(o.reference.slice(3)),
          source: 'direct',
          vendorId,
          budgetLineId: budget.lines[0].id,
          purchaseRequestId: null,
          tenderId: null,
          deliveryOn: day(10),
          lines: 1,
          subtotal: '1000.00',
          tax: '0.00',
          total: '1000.00',
        },
      ],
    ]);
    expect(raised[0].changes).toEqual({ note: { changed: true } });
    covered.add('purchase_order.raised');
    await f
      .http('post', `/staff/purchase-orders/${o.id}/approve`, m(), {
        note: 'AUDIT-secret decision',
      })
      .expect(200);
    const approved = await rows('purchase_order.approved', o.id);
    expect(approved.map((r) => [r.actorId, r.metadata])).toEqual([
      [
        s.manager.id,
        { revision: 1, approvalRequestId: null, total: '1000.00' },
      ],
    ]);
    expect(approved[0].changes).toEqual({ decisionNote: { changed: true } });
    covered.add('purchase_order.approved');
    expect(
      JSON.stringify(await read.tenant(s.c.tenantId, { targetId: o.id })),
    ).not.toContain('AUDIT-secret');
  });

  it('purchase_order.rejected and .cancelled — the code', async () => {
    const a = await raise();
    await f
      .http('post', `/staff/purchase-orders/${a.id}/reject`, m(), {
        reasonCode: 'wrong_price',
        note: 'AUDIT-secret again',
      })
      .expect(200);
    expect(
      (await rows('purchase_order.rejected', a.id)).map((r) => [
        r.actorId,
        r.metadata,
        r.changes,
      ]),
    ).toEqual([
      [
        s.manager.id,
        { revision: 1, reasonCode: 'wrong_price' },
        { decisionNote: { changed: true } },
      ],
    ]);
    covered.add('purchase_order.rejected');
    const b = await raise();
    await f
      .http('post', `/staff/purchase-orders/${b.id}/cancel`, acc(), {
        reasonCode: 'duplicate',
      })
      .expect(200);
    expect(
      (await rows('purchase_order.cancelled', b.id)).map((r) => [
        r.actorId,
        r.metadata,
      ]),
    ).toEqual([[s.accountant.id, { reasonCode: 'duplicate' }]]);
    covered.add('purchase_order.cancelled');
  });

  it('purchase_order.amended, .revision_approved, .revision_rejected and .revision_withdrawn — the revision, the code, the total', async () => {
    const o = await approved();
    const amend = (price: string) =>
      f.http('post', `/staff/purchase-orders/${o.id}/amend`, acc(), {
        reasonCode: 'price_change',
        lines: [{ id: o.lines[0].id, ...svc(price) }],
      });
    await amend('1200.00').expect(200);
    expect(
      (await rows('purchase_order.amended', o.id)).map((r) => [
        r.actorId,
        r.metadata,
      ]),
    ).toEqual([
      [
        s.accountant.id,
        {
          revision: 2,
          reasonCode: 'price_change',
          budgetLineId: budget.lines[0].id,
          deliveryOn: day(10),
          lines: 1,
          total: '1200.00',
        },
      ],
    ]);
    covered.add('purchase_order.amended');
    await f
      .http('post', `/staff/purchase-orders/${o.id}/reject`, m(), {
        reasonCode: 'wrong_price',
      })
      .expect(200);
    expect(
      (await rows('purchase_order.revision_rejected', o.id)).map((r) => [
        r.actorId,
        r.metadata,
      ]),
    ).toEqual([[s.manager.id, { revision: 2, reasonCode: 'wrong_price' }]]);
    covered.add('purchase_order.revision_rejected');
    await amend('1300.00').expect(200);
    await f
      .http('post', `/staff/purchase-orders/${o.id}/withdraw-revision`, acc())
      .expect(200);
    expect(
      (await rows('purchase_order.revision_withdrawn', o.id)).map((r) => [
        r.actorId,
        r.metadata,
      ]),
    ).toEqual([[s.accountant.id, { revision: 3 }]]);
    covered.add('purchase_order.revision_withdrawn');
    await amend('1400.00').expect(200);
    await approve(o.id).expect(200);
    expect(
      (await rows('purchase_order.revision_approved', o.id)).map((r) => [
        r.actorId,
        r.metadata,
      ]),
    ).toEqual([
      [
        s.manager.id,
        { revision: 4, approvalRequestId: null, total: '1400.00' },
      ],
    ]);
    covered.add('purchase_order.revision_approved');
  });

  it('purchase_order.sent and .acknowledged — the revision and the vendor', async () => {
    const o = await approved();
    await f
      .http('post', `/staff/purchase-orders/${o.id}/send`, acc())
      .expect(200);
    expect(
      (await rows('purchase_order.sent', o.id)).map((r) => [
        r.actorId,
        r.metadata,
      ]),
    ).toEqual([[s.accountant.id, { revision: 1, vendorId }]]);
    covered.add('purchase_order.sent');
    await f
      .http(
        'post',
        `/contractor/purchase-orders/${o.id}/acknowledge`,
        contractorToken,
      )
      .expect(200);
    expect(
      (await rows('purchase_order.acknowledged', o.id)).map((r) => [
        r.actorId,
        r.metadata,
      ]),
    ).toEqual([[contractorId, { revision: 1, vendorId }]]);
    covered.add('purchase_order.acknowledged');
  });

  it('goods_receipt.recorded, purchase_order.remainder_cancelled and .closed — the lines, the movements, the code, the commitment kept', async () => {
    const o = await approved({
      lines: [
        {
          kind: 'goods',
          description: 'AUDIT-secret gaskets',
          quantity: '4',
          unit: 'box',
          unitPrice: '100.00',
        },
      ],
    });
    const got = (
      await f
        .http('post', `/staff/purchase-orders/${o.id}/receipts`, m(), {
          receivedOn: day(0),
          deliveryNote: 'AUDIT-secret DN-1',
          note: 'AUDIT-secret condition',
          lines: [
            {
              purchaseOrderLineId: o.lines[0].id,
              accepted: '3',
              rejected: '1',
              rejectReason: 'damaged',
            },
          ],
        })
        .expect(201)
    ).body as { id: string; reference: string };
    const [receipt] = await rows('goods_receipt.recorded', got.id);
    expect([receipt.actorId, receipt.metadata, receipt.changes]).toEqual([
      s.manager.id,
      {
        number: Number(got.reference.slice(3)),
        orderId: o.id,
        storeId: null,
        receivedOn: day(0),
        lines: [
          {
            lineId: o.lines[0].id,
            accepted: '3.000',
            rejected: '1.000',
            reasonCode: 'damaged',
          },
        ],
        movements: [],
        photos: 0,
      },
      { note: { changed: true }, deliveryNote: { changed: true } },
    ]);
    covered.add('goods_receipt.recorded');
    await f
      .http('post', `/staff/purchase-orders/${o.id}/cancel`, acc(), {
        reasonCode: 'price_changed',
      })
      .expect(200);
    expect(
      (await rows('purchase_order.remainder_cancelled', o.id)).map((r) => [
        r.actorId,
        r.metadata,
      ]),
    ).toEqual([
      [
        s.accountant.id,
        { reasonCode: 'price_changed', keptCommitment: '300.00' },
      ],
    ]);
    covered.add('purchase_order.remainder_cancelled');
    // Fully received and invoiced closes an order of its own.
    const whole = await approved();
    await f
      .http('post', `/staff/purchase-orders/${whole.id}/receipts`, acc(), {
        receivedOn: day(0),
        lines: [{ purchaseOrderLineId: whole.lines[0].id, accepted: '1' }],
      })
      .expect(201);
    const inv = (
      await deferred(
        (async () =>
          f.http('post', '/staff/finance/vendor-invoices', acc(), {
            purchaseOrderId: whole.id,
            vendorNumber: `PA-${uniqueSuffix()}`,
            issuedOn: day(0),
            dueOn: day(30),
            invoiceFileId: await f.invoice(s.accountant),
            lines: [
              {
                description: 'Billed',
                purchaseOrderLineId: whole.lines[0].id,
                quantity: '1',
                unitPrice: '1000.00',
              },
            ],
          }))(),
      ).expect(201)
    ).body as { id: string };
    await f
      .http('post', `/staff/finance/vendor-invoices/${inv.id}/approve`, m(), {})
      .expect(200);
    expect(
      (await rows('purchase_order.closed', whole.id)).map((r) => [
        r.actorId,
        r.metadata,
      ]),
    ).toEqual([[s.manager.id, { closeReason: 'completed' }]]);
    covered.add('purchase_order.closed');
  });

  it('vendor_invoice.match_overridden — the code and the issues as kinds, positions and amounts', async () => {
    const o = await approved({
      lines: [
        {
          kind: 'goods',
          description: 'Boxes',
          quantity: '1',
          unit: 'box',
          unitPrice: '100.00',
        },
      ],
    });
    await f
      .http('post', `/staff/purchase-orders/${o.id}/receipts`, m(), {
        receivedOn: day(0),
        lines: [{ purchaseOrderLineId: o.lines[0].id, accepted: '1' }],
      })
      .expect(201);
    const inv = (
      await deferred(
        (async () =>
          f.http('post', '/staff/finance/vendor-invoices', acc(), {
            purchaseOrderId: o.id,
            vendorNumber: `PM-${uniqueSuffix()}`,
            issuedOn: day(0),
            dueOn: day(30),
            invoiceFileId: await f.invoice(s.accountant),
            lines: [
              {
                description: 'Billed',
                purchaseOrderLineId: o.lines[0].id,
                quantity: '1',
                unitPrice: '300.00',
              },
            ],
          }))(),
      ).expect(201)
    ).body as { id: string };
    await f
      .http(
        'post',
        `/staff/finance/vendor-invoices/${inv.id}/match/override`,
        m(),
        { reasonCode: 'vendor_price_agreed', note: 'AUDIT-secret phone call' },
      )
      .expect(200);
    const [row] = await rows('vendor_invoice.match_overridden', inv.id);
    expect([row.actorId, row.metadata, row.changes]).toEqual([
      s.manager.id,
      {
        orderId: o.id,
        reasonCode: 'vendor_price_agreed',
        issues: [
          {
            kind: 'price_over',
            position: 1,
            quantity: null,
            amount: '200.00',
          },
        ],
      },
      { note: { changed: true } },
    ]);
    covered.add('vendor_invoice.match_overridden');
    expect(
      JSON.stringify(await read.tenant(s.c.tenantId, { targetId: inv.id })),
    ).not.toContain('AUDIT-secret');
  });

  it('purchase_order_settings.updated — the tolerances, from and to', async () => {
    await f
      .http('patch', '/staff/finance/purchase-order-settings', m(), {
        pricePct: '3.00',
        poRequiredAbove: '5000.00',
      })
      .expect(200);
    expect(
      (await rows('purchase_order_settings.updated', s.c.tenantId)).map((r) => [
        r.actorId,
        r.changes,
      ]),
    ).toEqual([
      [
        s.manager.id,
        {
          poRequiredAbove: { from: null, to: '5000.00' },
          pricePct: { from: '2.00', to: '3.00' },
        },
      ],
    ]);
    covered.add('purchase_order_settings.updated');
  });

  describe('catalog completeness', () => {
    it('every entry of purchase orders has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of M37_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...M37_COVERAGE].sort());
    });
  });
});

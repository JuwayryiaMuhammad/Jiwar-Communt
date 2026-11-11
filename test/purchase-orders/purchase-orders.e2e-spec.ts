import { Client } from 'pg';
import type { Response } from 'supertest';
import { err } from '../api/request';
import { budgetHelpers, type BudgetBody } from '../setup/budgets';
import { dbClock, day } from '../setup/compound-clock';
import { nationalIdFor, uniquePhone, uniqueSuffix } from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  type HttpHarness,
} from '../setup/http-app';
import { required } from '../setup/test-env';

type Who = { id: string; token: string };
interface OrderLine {
  id: string;
  position: number;
  kind: string;
  quantity: string;
  unitPrice: string;
  net: string;
  tax: string;
  accepted: string;
  invoiced: string;
}
interface Order {
  id: string;
  reference: string;
  status: string;
  revision: number;
  pendingRevision: number | null;
  vendorId: string;
  budgetLineId: string;
  source: string;
  subtotal: string;
  tax: string;
  total: string;
  committed: string;
  approvalRequestId: string | null;
  raisedByMe: boolean;
  sentAt: string | null;
  acknowledgedRevision: number | null;
  closeReason: string | null;
  lines: OrderLine[];
  revisions: { revision: number; status: string; total: string }[];
}
interface Commitment {
  id: string;
  source: string;
  purchaseOrderId: string | null;
  purchaseRequestId: string | null;
  amount: string;
  open: string;
  closedAt: string | null;
}

const HOUR = 3_600_000;

/**
 * ADR 0094: purchase orders raised directly, from an approved purchase
 * request and from a tender's award; approved by someone who did not raise
 * them, up to the manager's limit and under the board's approval above it;
 * keeping their budget line's money as the one commitment of ADR 0089;
 * amended by revisions approved again; sent to the vendor as a PDF and
 * acknowledged by its contractors.
 */
describe('Purchase orders (ADR 0094)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof budgetHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof budgetHelpers>['setUp']>>;
  let budget: BudgetBody;
  let vendorId: string;
  let ann: Who;
  let migrator: Client;

  const http = (
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    token: string,
    body?: object,
  ) => f.http(method, path, token, body);
  const m = () => s.manager.token;
  const acc = () => s.accountant.token;
  const line = () => budget.lines[0];
  const lineView = async () =>
    (await f.budgetView(s.accountant, budget.id)).lines[0] as unknown as {
      committed: string;
      available: string;
    };
  const setThreshold = (threshold: string | null) =>
    http('patch', '/staff/governance/settings', m(), {
      items: [{ type: 'major_contract', threshold }],
    }).expect(200);

  const vendor = async () =>
    (
      (
        await http('post', '/staff/vendors', m(), {
          name: `Supplier ${uniqueSuffix()}`,
          categories: ['supplies'],
        }).expect(201)
      ).body as { id: string }
    ).id;
  const contractor = async (v: string): Promise<Who> => {
    const res = await http('post', `/staff/vendors/${v}/contractors`, m(), {
      fullName: 'Receiving Contractor',
      idDocumentType: 'national_id',
      idDocumentNumber: nationalIdFor(new Date('1989-04-04')),
      phone: uniquePhone(),
      email: uniqueEmail('po-vendor'),
    }).expect(201);
    const id = (res.body as { id: string }).id;
    return {
      id,
      token: await h.tokenFor({
        sub: id,
        tid: s.c.tenantId,
        typ: 'contractor',
      }),
    };
  };
  /** A service line, `n` units at `price`. */
  const svc = (price = '1000.00', n = '1', over: object = {}) => ({
    kind: 'service',
    description: 'Pump servicing',
    quantity: n,
    unit: 'lot',
    unitPrice: price,
    ...over,
  });
  const raise = (by: string, over: object = {}) =>
    http('post', '/staff/purchase-orders', by, {
      vendorId,
      budgetLineId: line().id,
      deliveryOn: day(10),
      lines: [svc()],
      ...over,
    });
  const raised = async (by = acc(), over: object = {}) =>
    (await raise(by, over).expect(201)).body as Order;
  const order = async (id: string, by = m()) =>
    (await http('get', `/staff/purchase-orders/${id}`, by).expect(200))
      .body as Order;
  const approve = (id: string, by = m(), body: object = {}) =>
    http('post', `/staff/purchase-orders/${id}/approve`, by, body);
  const approved = async (by = acc(), over: object = {}) => {
    const o = await raised(by, over);
    await approve(o.id).expect(200);
    return order(o.id);
  };
  const commitments = async (orderId: string) =>
    (
      (
        await http(
          'get',
          `/staff/finance/commitments?lineId=${line().id}&source=purchase_order`,
          m(),
        ).expect(200)
      ).body as { data: Commitment[] }
    ).data.filter((c) => c.purchaseOrderId === orderId);
  const majorContract = async (cost: string) => {
    const r = await f.raise(s.manager, {
      type: 'major_contract',
      cost,
      context: 'A large purchase',
    });
    await f.approve([s.owners[0], s.owners[1]], r.id);
    return r.id;
  };

  beforeAll(async () => {
    h = await createHttpHarness();
    f = budgetHelpers(h);
    s = await f.setUp(4, 3);
    budget = await f.activeBudget(
      s.accountant,
      [s.owners[0], s.owners[1]],
      [{ category: 'maintenance', amount: '900000.00' }],
    );
    await setThreshold('100000.00');
    vendorId = await vendor();
    ann = await contractor(vendorId);
    migrator = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await migrator.connect();
  }, 240_000);

  afterAll(async () => {
    await migrator.end();
    await h.close();
  });

  describe('raised and approved', () => {
    it('a direct order has its lines, net, VAT and gross, and waits; approved by another, it keeps the line’s money as one commitment', async () => {
      const before = await lineView();
      const o = await raised(acc(), {
        lines: [
          svc('1000.00', '2', { taxCode: 'vat_14' }),
          {
            kind: 'goods',
            description: 'Gaskets',
            quantity: '10',
            unit: 'box',
            unitPrice: '12.50',
            withholdingCategory: 'supplies',
          },
        ],
      });
      expect(o).toMatchObject({
        status: 'requested',
        revision: 1,
        source: 'direct',
        subtotal: '2125.00',
        tax: '280.00',
        total: '2405.00',
        committed: '0.00',
        raisedByMe: true,
      });
      expect(o.reference).toMatch(/^PO-\d{6}$/);
      expect(o.lines.map((l) => [l.position, l.net, l.tax])).toEqual([
        [1, '2000.00', '280.00'],
        [2, '125.00', '0.00'],
      ]);
      expect((await lineView()).committed).toBe(before.committed);
      // Another holder of purchases.approve approves it; it keeps the line.
      const done = (await approve(o.id).expect(200)).body as Order;
      expect(done).toMatchObject({ status: 'approved', committed: '2405.00' });
      expect(done.revisions).toEqual([
        expect.objectContaining({ revision: 1, status: 'approved' }),
      ]);
      const kept = await commitments(o.id);
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatchObject({ amount: '2405.00', open: '2405.00' });
      expect(Number((await lineView()).committed)).toBeCloseTo(
        Number(before.committed) + 2405,
      );
      // Decided once.
      expect(err(await approve(o.id))).toMatchObject({
        statusCode: 409,
        code: 'PURCHASE_ORDER_STATE',
      });
    });

    it('nobody approves their own order, even under the board’s approval; and the accountant cannot approve at all', async () => {
      const own = await raised(m());
      expect(err(await approve(own.id, m()))).toMatchObject({
        statusCode: 409,
        code: 'PURCHASE_ORDER_SELF_APPROVAL',
      });
      const r = await majorContract('900000.00');
      expect(
        err(await approve(own.id, m(), { approvalRequestId: r })),
      ).toMatchObject({
        code: 'PURCHASE_ORDER_SELF_APPROVAL',
      });
      await http(
        'post',
        `/staff/purchase-orders/${own.id}/approve`,
        acc(),
        {},
      ).expect(403);
      expect(
        err(
          await http('post', `/staff/purchase-orders/${own.id}/reject`, m(), {
            reasonCode: 'no_budget',
          }),
        ),
      ).toMatchObject({ code: 'PURCHASE_ORDER_SELF_APPROVAL' });
      // Called off by its raiser, with a code.
      const called = (
        await http('post', `/staff/purchase-orders/${own.id}/cancel`, m(), {
          reasonCode: 'no_longer_needed',
        }).expect(200)
      ).body as Order;
      expect(called.status).toBe('cancelled');
    });

    it('turned down with a code, it keeps nothing; the raiser is told', async () => {
      const before = await lineView();
      const o = await raised(acc());
      expect(
        err(
          await http('post', `/staff/purchase-orders/${o.id}/reject`, m(), {
            reasonCode: 'nonsense',
          }),
        ),
      ).toMatchObject({ statusCode: 400, code: 'VALIDATION_FAILED' });
      const done = (
        await http('post', `/staff/purchase-orders/${o.id}/reject`, m(), {
          reasonCode: 'wrong_price',
          note: 'Quote it again',
        }).expect(200)
      ).body as Order;
      expect(done.status).toBe('rejected');
      expect((await lineView()).committed).toBe(before.committed);
      const told = await f.inTx(s.c, (tx) =>
        tx.notification.count({
          where: {
            accountId: s.accountant.id,
            kind: 'purchase_order.decided',
            targetId: o.id,
          },
        }),
      );
      expect(told).toBe(1);
    });

    it('above the manager’s limit the order needs the board’s approved major contract, which signs this order and no other', async () => {
      const o = await raised(acc(), { lines: [svc('150000.00')] });
      expect(err(await approve(o.id))).toMatchObject({
        statusCode: 409,
        code: 'PURCHASE_ORDER_NEEDS_APPROVAL',
        params: { threshold: '100000.00' },
      });
      const small = await majorContract('100000.00');
      expect(
        err(await approve(o.id, m(), { approvalRequestId: small })),
      ).toMatchObject({
        code: 'PURCHASE_ORDER_APPROVAL_INVALID',
        params: { reason: 'below_amount' },
      });
      const big = await majorContract('200000.00');
      const done = (
        await approve(o.id, m(), { approvalRequestId: big }).expect(200)
      ).body as Order;
      expect(done).toMatchObject({
        status: 'approved',
        approvalRequestId: big,
      });
      const other = await raised(acc(), { lines: [svc('150000.00')] });
      expect(
        err(await approve(other.id, m(), { approvalRequestId: big })),
      ).toMatchObject({
        code: 'PURCHASE_ORDER_APPROVAL_INVALID',
        params: { reason: 'covers_another' },
      });
    });
  });

  describe('from a purchase request', () => {
    const request = async (over: object = {}) =>
      (
        await http('post', '/staff/purchase-requests', acc(), {
          title: 'Pump seals for building C',
          estimatedAmount: '5000.00',
          vendorId,
          budgetLineId: line().id,
          ...over,
        }).expect(201)
      ).body as { id: string; reference: string };
    const requestCommitments = async (id: string) =>
      (
        (
          await http(
            'get',
            `/staff/finance/commitments?lineId=${line().id}&source=purchase_request`,
            m(),
          ).expect(200)
        ).body as { data: Commitment[] }
      ).data.filter((c) => c.purchaseRequestId === id);

    it('takes the request’s commitment over, not a second one: the request is fulfilled by the order and is called off through it', async () => {
      const r = await request();
      expect(
        err(
          await raise(acc(), {
            purchaseRequestId: r.id,
            lines: [svc('4800.00')],
          }),
        ),
      ).toMatchObject({
        statusCode: 409,
        code: 'PURCHASE_ORDER_SOURCE_INVALID',
        params: { reason: 'request_not_approved' },
      });
      await http(
        'post',
        `/staff/purchase-requests/${r.id}/approve`,
        m(),
        {},
      ).expect(200);
      const keptByRequest = await requestCommitments(r.id);
      expect(keptByRequest).toHaveLength(1);
      expect(keptByRequest[0].open).toBe('5000.00');
      const before = await lineView();
      // Its vendor and line are the request’s.
      const o = (
        await http('post', '/staff/purchase-orders', acc(), {
          purchaseRequestId: r.id,
          deliveryOn: day(5),
          lines: [svc('4800.00')],
        }).expect(201)
      ).body as Order;
      expect(o).toMatchObject({
        source: 'purchase_request',
        vendorId,
        budgetLineId: line().id,
        total: '4800.00',
      });
      expect(
        err(await raise(acc(), { purchaseRequestId: r.id })),
      ).toMatchObject({
        code: 'PURCHASE_ORDER_SOURCE_INVALID',
        params: { reason: 'already_ordered' },
      });
      // Nothing is reserved twice while the order waits, and the request is
      // not called off under it.
      expect((await lineView()).committed).toBe(before.committed);
      expect(
        err(
          await http('post', `/staff/purchase-requests/${r.id}/cancel`, acc(), {
            reasonCode: 'not_needed',
          }),
        ),
      ).toMatchObject({
        code: 'PURCHASE_REQUEST_WRONG_STATUS',
        params: { status: 'ordered' },
      });
      await approve(o.id).expect(200);
      expect((await requestCommitments(r.id))[0].closedAt).not.toBeNull();
      expect((await commitments(o.id))[0]).toMatchObject({ open: '4800.00' });
      // 5000 given back, 4800 kept: the line holds 200 less than before.
      expect(Number((await lineView()).committed)).toBeCloseTo(
        Number(before.committed) - 200,
      );
      const fulfilled = (
        await http('get', `/staff/purchase-requests/${r.id}`, m()).expect(200)
      ).body as { status: string; fulfilledReference: string };
      expect(fulfilled).toMatchObject({
        status: 'fulfilled',
        fulfilledReference: o.reference,
      });
    });
  });

  describe('from a tender’s award', () => {
    const closeBids = async (tenderId: string) => {
      await migrator.query('BEGIN');
      try {
        await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          s.c.tenantId,
        ]);
        await migrator.query(
          'ALTER TABLE tenders DISABLE TRIGGER tenders_move_forward',
        );
        await migrator.query(
          `UPDATE tenders
              SET created_at = LEAST(created_at, clock_timestamp() - interval '1 hour'),
                  bids_due_at = clock_timestamp() - interval '1 second'
            WHERE id = $1::uuid`,
          [tenderId],
        );
        await migrator.query(
          'ALTER TABLE tenders ENABLE TRIGGER tenders_move_forward',
        );
        await migrator.query('COMMIT');
      } catch (e) {
        await migrator.query('ROLLBACK');
        throw e;
      }
    };
    const awarded = async (amount: string) => {
      const t = (
        await http('post', '/staff/tenders', m(), {
          title: 'Pump house refit',
          scope: 'Replace the pumps.',
          category: 'maintenance',
          contractKind: 'service',
          budgetLineId: line().id,
          estimatedValue: amount,
          bidsDueAt: new Date(dbClock().getTime() + 48 * HOUR).toISOString(),
        }).expect(201)
      ).body as { id: string };
      await http('post', `/staff/tenders/${t.id}/invitations`, m(), {
        vendorId,
      }).expect(201);
      await http('post', `/staff/tenders/${t.id}/publish`, m()).expect(200);
      await http('post', `/contractor/tenders/${t.id}/bid`, ann.token, {
        amount,
        durationDays: 30,
      }).expect(201);
      await closeBids(t.id);
      await http('post', `/staff/tenders/${t.id}/opening`, acc()).expect(200);
      const opened = (
        await http('post', `/staff/tenders/${t.id}/opening`, m()).expect(200)
      ).body as { bids: { id: string }[] };
      await http('post', `/staff/tenders/${t.id}/award`, m(), {
        bidId: opened.bids[0].id,
        code: `TC-${uniqueSuffix()}`,
        startsOn: day(5),
        endsOn: day(200),
      }).expect(200);
      return t.id;
    };

    it('takes the award’s vendor and line, never more than the award in all, and only from an awarded tender', async () => {
      const draft = (
        await http('post', '/staff/tenders', m(), {
          title: 'Not awarded',
          category: 'maintenance',
          contractKind: 'service',
          bidsDueAt: new Date(dbClock().getTime() + 48 * HOUR).toISOString(),
        }).expect(201)
      ).body as { id: string };
      expect(
        err(
          await http('post', '/staff/purchase-orders', acc(), {
            tenderId: draft.id,
            budgetLineId: line().id,
            deliveryOn: day(20),
            lines: [svc()],
          }),
        ),
      ).toMatchObject({
        code: 'PURCHASE_ORDER_SOURCE_INVALID',
        params: { reason: 'tender_not_awarded' },
      });
      const tenderId = await awarded('40000.00');
      const first = (
        await http('post', '/staff/purchase-orders', acc(), {
          tenderId,
          deliveryOn: day(20),
          lines: [svc('25000.00')],
        }).expect(201)
      ).body as Order;
      expect(first).toMatchObject({
        source: 'tender',
        vendorId,
        budgetLineId: line().id,
      });
      expect(
        err(
          await http('post', '/staff/purchase-orders', acc(), {
            tenderId,
            deliveryOn: day(20),
            lines: [svc('20000.00')],
          }),
        ),
      ).toMatchObject({
        code: 'PURCHASE_ORDER_SOURCE_INVALID',
        params: {
          reason: 'award_exceeded',
          awarded: '40000.00',
          ordered: '25000.00',
        },
      });
      await http('post', '/staff/purchase-orders', acc(), {
        tenderId,
        deliveryOn: day(20),
        lines: [svc('15000.00')],
      }).expect(201);
      await approve(first.id).expect(200);
    });
  });

  describe('amended', () => {
    it('is a new revision approved again: the revision in force stands until then, and the commitment follows', async () => {
      const o = await approved(acc(), { lines: [svc('1000.00', '2')] });
      expect(o).toMatchObject({ total: '2000.00', committed: '2000.00' });
      const amend = (by: string, over: object = {}) =>
        http('post', `/staff/purchase-orders/${o.id}/amend`, by, {
          reasonCode: 'price_change',
          lines: [{ id: o.lines[0].id, ...svc('1500.00', '2') }],
          ...over,
        });
      expect(err(await amend(acc(), { reasonCode: 'whatever' }))).toMatchObject(
        {
          statusCode: 400,
          code: 'VALIDATION_FAILED',
        },
      );
      const waiting = (await amend(acc()).expect(200)).body as Order;
      expect(waiting).toMatchObject({
        status: 'approved',
        revision: 1,
        pendingRevision: 2,
        total: '2000.00',
        committed: '2000.00',
      });
      expect(
        waiting.revisions.map((r) => [r.revision, r.status, r.total]),
      ).toEqual([
        [2, 'requested', '3000.00'],
        [1, 'approved', '2000.00'],
      ]);
      expect(err(await amend(acc()))).toMatchObject({
        statusCode: 409,
        code: 'PURCHASE_ORDER_REVISION_PENDING',
        params: { revision: 2 },
      });
      const done = (await approve(o.id).expect(200)).body as Order;
      expect(done).toMatchObject({
        revision: 2,
        pendingRevision: null,
        total: '3000.00',
        committed: '3000.00',
      });
      expect(done.lines[0]).toMatchObject({
        id: o.lines[0].id,
        unitPrice: '1500.00',
        net: '3000.00',
      });
      expect(done.revisions.map((r) => r.status)).toEqual([
        'approved',
        'approved',
      ]);
    });

    it('a revision is turned down or taken back and the order stands; its asker never approves it; a line is added and another dropped', async () => {
      const o = await approved(acc(), {
        lines: [svc('1000.00'), svc('500.00')],
      });
      const base = {
        reasonCode: 'item_added',
        lines: [
          { id: o.lines[0].id, ...svc('1000.00') },
          svc('250.00', '2', { description: 'A new item' }),
        ],
      };
      const amend = (by: string) =>
        http('post', `/staff/purchase-orders/${o.id}/amend`, by, base);
      await amend(acc()).expect(200);
      const rejected = (
        await http('post', `/staff/purchase-orders/${o.id}/reject`, m(), {
          reasonCode: 'wrong_price',
        }).expect(200)
      ).body as Order;
      expect(rejected).toMatchObject({
        status: 'approved',
        revision: 1,
        pendingRevision: null,
        total: '1500.00',
      });
      expect(rejected.revisions[0]).toMatchObject({ status: 'rejected' });
      // Taken back by its asker, and only by them.
      await amend(acc()).expect(200);
      expect(
        err(
          await http(
            'post',
            `/staff/purchase-orders/${o.id}/withdraw-revision`,
            m(),
          ),
        ),
      ).toMatchObject({ statusCode: 404 });
      await http(
        'post',
        `/staff/purchase-orders/${o.id}/withdraw-revision`,
        acc(),
      ).expect(200);
      // The manager asks, so the manager cannot approve it.
      await amend(m()).expect(200);
      expect(err(await approve(o.id, m()))).toMatchObject({
        code: 'PURCHASE_ORDER_SELF_APPROVAL',
      });
      await http(
        'post',
        `/staff/purchase-orders/${o.id}/withdraw-revision`,
        m(),
      ).expect(200);
      // Adding one and dropping the second, approved by another.
      await amend(acc()).expect(200);
      const done = (await approve(o.id).expect(200)).body as Order;
      expect(done).toMatchObject({ revision: 5, total: '1500.00' });
      expect(done.lines.map((l) => [l.position, l.net])).toEqual([
        [1, '1000.00'],
        [2, '500.00'],
      ]);
      expect(done.lines.map((l) => l.id)).not.toContain(o.lines[1].id);
    });
  });

  describe('sent to the vendor', () => {
    const binary = (
      res: Response,
      done: (e: Error | null, b: Buffer) => void,
    ) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    };

    it('is a PDF, then seen and acknowledged by the vendor’s contractors, never by another vendor’s', async () => {
      const o = await approved(acc());
      const bea = await contractor(await vendor());
      // Not sent: not theirs to see yet.
      expect(
        (
          await http('get', '/contractor/purchase-orders', ann.token).expect(
            200,
          )
        ).body,
      ).toMatchObject({ data: [] });
      expect(
        err(
          await http('get', `/contractor/purchase-orders/${o.id}`, ann.token),
        ),
      ).toMatchObject({ statusCode: 404, code: 'PURCHASE_ORDER_NOT_FOUND' });
      const pdf = await http('get', `/staff/purchase-orders/${o.id}/pdf`, acc())
        .buffer(true)
        .parse(binary)
        .expect(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      const sent = (
        await http('post', `/staff/purchase-orders/${o.id}/send`, acc()).expect(
          200,
        )
      ).body as Order;
      expect(sent.sentAt).not.toBeNull();
      const told = await f.inTx(s.c, (tx) =>
        tx.notification.count({
          where: {
            accountId: ann.id,
            kind: 'purchase_order.sent',
            targetId: o.id,
          },
        }),
      );
      expect(told).toBe(1);
      const seen = (
        await http(
          'get',
          `/contractor/purchase-orders/${o.id}`,
          ann.token,
        ).expect(200)
      ).body as { reference: string; total: string; lines: object[] };
      expect(seen).toMatchObject({ reference: o.reference, total: '1000.00' });
      expect(JSON.stringify(seen)).not.toMatch(/budget|approval|committed/i);
      const theirs = await http(
        'get',
        `/contractor/purchase-orders/${o.id}/pdf`,
        ann.token,
      )
        .buffer(true)
        .parse(binary)
        .expect(200);
      expect((theirs.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      expect(
        err(
          await http('get', `/contractor/purchase-orders/${o.id}`, bea.token),
        ),
      ).toMatchObject({ statusCode: 404 });
      expect(
        err(
          await http(
            'post',
            `/contractor/purchase-orders/${o.id}/acknowledge`,
            bea.token,
          ),
        ),
      ).toMatchObject({ statusCode: 404 });
      const ack = (
        await http(
          'post',
          `/contractor/purchase-orders/${o.id}/acknowledge`,
          ann.token,
        ).expect(200)
      ).body as { acknowledgedRevision: number };
      expect(ack.acknowledgedRevision).toBe(1);
      // A revision asks again, after it is sent again.
      await http('post', `/staff/purchase-orders/${o.id}/amend`, acc(), {
        reasonCode: 'delivery_date',
        deliveryOn: day(30),
        lines: [{ id: o.lines[0].id, ...svc() }],
      }).expect(200);
      await approve(o.id).expect(200);
      expect(await order(o.id)).toMatchObject({
        revision: 2,
        acknowledgedRevision: 1,
      });
      await http('post', `/staff/purchase-orders/${o.id}/send`, acc()).expect(
        200,
      );
      const second = (
        await http(
          'post',
          `/contractor/purchase-orders/${o.id}/acknowledge`,
          ann.token,
        ).expect(200)
      ).body as { acknowledgedRevision: number };
      expect(second.acknowledgedRevision).toBe(2);
    });
  });
});

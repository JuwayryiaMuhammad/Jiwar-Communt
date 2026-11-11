import type { Response } from 'supertest';
import { boardMatterHelpers } from '../setup/board-matters';
import { day } from '../setup/compound-clock';
import { fileHelpers } from '../setup/files';
import { uniqueSuffix } from '../setup/fixtures';
import { activeBudget } from './no-store-board-matters';
import { call, type Method } from './request';
import type { World } from './world';

/** A setup call that must have done what it asked (awaited: a response). */
function done(res: Response, status = 201): Response {
  if (res.status !== status)
    throw new Error(`no-store: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
}

/**
 * A real call for each no-store route of purchase orders (ADR 0094), in A:
 * the staff's own, the vendor's contractor's, and the match and the
 * tolerances of finance. Orders are raised by A's accountant and approved by
 * A's manager; the contractor's vendor is the orders' vendor, so its
 * contractor sees what was sent.
 */
export function purchaseOrderCalls(
  world: () => World,
  sitting: () => Promise<void>,
): Record<string, () => Promise<Response>> {
  const w = () => world();
  const id = (res: Response) => (res.body as { id: string }).id;
  const as =
    (token: () => string | Promise<string>) =>
    async (method: Method, path: string, body?: object) =>
      call(w(), method, path, { token: await token(), body });
  const m = as(() => w().a.tokens.manager);
  const c = as(() => w().a.tokens.contractor);
  /** A's accountant, made once: raises orders, records invoices. */
  let accountantToken: Promise<string> | null = null;
  const accountant = () =>
    (accountantToken ??= boardMatterHelpers(w().h)
      .accountant(w().a)
      .then((who) => who.token));
  const acc = as(accountant);
  const line = (kind: 'goods' | 'service', price = '100.00') => ({
    kind,
    description: kind === 'goods' ? 'No-store gaskets' : 'No-store work',
    quantity: '1',
    unit: kind === 'goods' ? 'box' : 'lot',
    unitPrice: price,
  });
  const orderBody = async (kind: 'goods' | 'service' = 'service') => ({
    vendorId: w().a.contractorVendorId,
    budgetLineId: (await activeBudget(world, sitting)).lineId,
    deliveryOn: day(10),
    lines: [line(kind)],
  });
  const raised = async (kind: 'goods' | 'service' = 'service') =>
    done(await acc('POST', '/staff/purchase-orders', await orderBody(kind)))
      .body as { id: string; lines: { id: string }[] };
  const approved = async (kind: 'goods' | 'service' = 'service') => {
    const o = await raised(kind);
    done(await m('POST', `/staff/purchase-orders/${o.id}/approve`, {}), 200);
    return o;
  };
  const sent = async () => {
    const o = await approved();
    done(await acc('POST', `/staff/purchase-orders/${o.id}/send`), 200);
    return o;
  };
  /** An invoice of an order whose goods arrived, billed too dear: blocked. */
  const blockedInvoice = async () => {
    const o = await approved('goods');
    done(
      await m('POST', `/staff/purchase-orders/${o.id}/receipts`, {
        receivedOn: day(0),
        lines: [{ purchaseOrderLineId: o.lines[0].id, accepted: '1' }],
      }),
    );
    const file = await fileHelpers(w().h).ready(
      await accountant(),
      'expense_invoice',
      'application/pdf',
    );
    return id(
      done(
        await acc('POST', '/staff/finance/vendor-invoices', {
          purchaseOrderId: o.id,
          vendorNumber: `NS-${uniqueSuffix()}`,
          issuedOn: day(0),
          dueOn: day(30),
          invoiceFileId: file,
          lines: [
            {
              description: 'Billed',
              purchaseOrderLineId: o.lines[0].id,
              quantity: '1',
              unitPrice: '500.00',
            },
          ],
        }),
      ),
    );
  };

  return {
    'GET /staff/purchase-orders': () => m('GET', '/staff/purchase-orders'),
    'POST /staff/purchase-orders': async () =>
      acc('POST', '/staff/purchase-orders', await orderBody()),
    'GET /staff/purchase-orders/{id}': async () =>
      m('GET', `/staff/purchase-orders/${(await approved()).id}`),
    'GET /staff/purchase-orders/{id}/pdf': async () =>
      m('GET', `/staff/purchase-orders/${(await approved()).id}/pdf`),
    'POST /staff/purchase-orders/{id}/approve': async () =>
      m('POST', `/staff/purchase-orders/${(await raised()).id}/approve`, {}),
    'POST /staff/purchase-orders/{id}/reject': async () =>
      m('POST', `/staff/purchase-orders/${(await raised()).id}/reject`, {
        reasonCode: 'no_budget',
      }),
    'POST /staff/purchase-orders/{id}/amend': async () => {
      const o = await approved();
      return acc('POST', `/staff/purchase-orders/${o.id}/amend`, {
        reasonCode: 'price_change',
        lines: [{ id: o.lines[0].id, ...line('service', '120.00') }],
      });
    },
    'POST /staff/purchase-orders/{id}/withdraw-revision': async () => {
      const o = await approved();
      done(
        await acc('POST', `/staff/purchase-orders/${o.id}/amend`, {
          reasonCode: 'price_change',
          lines: [{ id: o.lines[0].id, ...line('service', '130.00') }],
        }),
        200,
      );
      return acc('POST', `/staff/purchase-orders/${o.id}/withdraw-revision`);
    },
    'POST /staff/purchase-orders/{id}/cancel': async () =>
      acc('POST', `/staff/purchase-orders/${(await approved()).id}/cancel`, {
        reasonCode: 'duplicate',
      }),
    'POST /staff/purchase-orders/{id}/send': async () =>
      acc('POST', `/staff/purchase-orders/${(await approved()).id}/send`),
    'POST /staff/purchase-orders/{id}/receipts': async () => {
      const o = await approved();
      return m('POST', `/staff/purchase-orders/${o.id}/receipts`, {
        receivedOn: day(0),
        lines: [{ purchaseOrderLineId: o.lines[0].id, accepted: '1' }],
      });
    },
    'GET /contractor/purchase-orders': async () => {
      await sent();
      return c('GET', '/contractor/purchase-orders');
    },
    'GET /contractor/purchase-orders/{id}': async () =>
      c('GET', `/contractor/purchase-orders/${(await sent()).id}`),
    'GET /contractor/purchase-orders/{id}/pdf': async () =>
      c('GET', `/contractor/purchase-orders/${(await sent()).id}/pdf`),
    'POST /contractor/purchase-orders/{id}/acknowledge': async () =>
      c('POST', `/contractor/purchase-orders/${(await sent()).id}/acknowledge`),
    'GET /staff/finance/vendor-invoices/{id}/match': async () =>
      m(
        'GET',
        `/staff/finance/vendor-invoices/${await blockedInvoice()}/match`,
      ),
    'POST /staff/finance/vendor-invoices/{id}/match/override': async () =>
      m(
        'POST',
        `/staff/finance/vendor-invoices/${await blockedInvoice()}/match/override`,
        { reasonCode: 'vendor_price_agreed' },
      ),
    'GET /staff/finance/purchase-order-settings': () =>
      m('GET', '/staff/finance/purchase-order-settings'),
    'PATCH /staff/finance/purchase-order-settings': () =>
      m('PATCH', '/staff/finance/purchase-order-settings', {
        pricePct: '2.00',
      }),
  };
}

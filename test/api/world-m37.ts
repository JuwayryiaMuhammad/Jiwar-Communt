import { purchaseOrderRow } from '../setup/purchase-order-rows';
import type { Side } from './world';

/** Purchase orders (ADR 0094) as the API suites see them: B's rows. */
export interface M37World {
  /** An approved, sent purchase order of B's, with a receipt. */
  bPurchaseOrderId: string;
  bPurchaseOrderLineId: string;
  bGoodsReceiptId: string;
}

export async function m37World(
  b: Side,
  vendorId: string,
  budgetLineId: string,
): Promise<M37World> {
  const row = await purchaseOrderRow({
    tenantId: b.tenantId,
    vendorId,
    budgetLineId,
    raisedById: b.ids.manager,
  });
  return {
    bPurchaseOrderId: row.orderId,
    bPurchaseOrderLineId: row.lineId,
    bGoodsReceiptId: row.receiptId,
  };
}

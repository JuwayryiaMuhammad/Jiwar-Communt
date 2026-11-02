import { TenantTx } from '../../src/core/database/tenant-tx.service';
import type { communityHelpers } from '../setup/community';
import { paymentRow } from '../setup/finance-rows';
import type { HttpHarness } from '../setup/http-app';
import {
  cashAccountRow,
  chequeRow,
  handinRow,
  investigationRow,
  matchRow,
  statementImportRow,
  statementLineRow,
} from '../setup/treasury-rows';
import type { Side } from './world';

/** Treasury and custody (ADR 0085) as the API suites see it: B's rows. */
export interface M32World {
  bCashAccountId: string;
  /** B's collector: a custodian whose custody A never reads. */
  bCustodianId: string;
  bHandinId: string;
  bInvestigationId: string;
  bChequeId: string;
  bStatementImportId: string;
  bStatementLineId: string;
  bStatementMatchId: string;
}

export async function m32World(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  b: Side,
): Promise<M32World> {
  const tenantTx = h.moduleRef.get(TenantTx);
  return helpers.asManager(b, () =>
    tenantTx.withTenantTx(async (tx) => {
      const tenantId = b.tenantId;
      const bank = await cashAccountRow(tx, {
        tenantId,
        createdById: b.ids.manager,
      });
      const box = await cashAccountRow(tx, {
        tenantId,
        createdById: b.ids.manager,
        kind: 'cash',
      });
      const paymentId = await paymentRow(tx, {
        tenantId,
        unitId: b.homeUnitId,
        recordedById: b.ids.collector,
      });
      const handinId = await handinRow(tx, {
        tenantId,
        custodianId: b.ids.collector,
        receivedById: b.ids.manager,
        cashAccountId: box,
        paymentId,
      });
      const investigationId = await investigationRow(tx, {
        tenantId,
        handinId,
        ownerId: b.ids.manager,
      });
      const chequeId = await chequeRow(tx, {
        tenantId,
        unitId: b.homeUnitId,
        recordedById: b.ids.manager,
      });
      const importId = await statementImportRow(tx, {
        tenantId,
        accountId: bank,
        createdById: b.ids.manager,
      });
      const lineId = await statementLineRow(tx, {
        tenantId,
        accountId: bank,
        importId,
      });
      const matched = await statementLineRow(tx, {
        tenantId,
        accountId: bank,
        importId,
      });
      const matchId = await matchRow(tx, {
        tenantId,
        lineId: matched,
        accountId: bank,
        matchedById: b.ids.manager,
      });
      return {
        bCashAccountId: bank,
        bCustodianId: b.ids.collector,
        bHandinId: handinId,
        bInvestigationId: investigationId,
        bChequeId: chequeId,
        bStatementImportId: importId,
        bStatementLineId: lineId,
        bStatementMatchId: matchId,
      };
    }),
  );
}

import { TenantTx } from '../../src/core/database/tenant-tx.service';
import type { communityHelpers } from '../setup/community';
import { budgetLineRow, budgetRow, expenseRow } from '../setup/finance-rows';
import {
  appealRow,
  approvalRequestRow,
  boardMemberRow,
  boardTermRow,
  motionRow,
} from '../setup/governance-rows';
import type { HttpHarness } from '../setup/http-app';
import { decisionAppealRow } from '../setup/management-rows';
import type { Side } from './world';

/**
 * The board's matters (ADR 0055) as the API suites see them: A's landlord
 * sits on A's board (the board's routes are a sitting member's only), and
 * B holds a request and a motion on it (foreign ids for the matrix).
 */
export interface BoardMattersWorld {
  /** A pending request of B's. */
  bApprovalId: string;
  /** An open motion of B's board on it. */
  bBoardMotionId: string;
  /** A draft budget of B's, and an expense on its line (ADR 0055). */
  bBudgetId: string;
  bExpenseId: string;
  /** A pending appeal of B's owner about B's home. */
  bBoardAppealId: string;
  /** A pending decision appeal of B's owner about B's home (ADR 0059). */
  bDecisionAppealId: string;
}

export async function boardMattersWorld(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  a: Side,
  b: Side,
): Promise<BoardMattersWorld> {
  const tenantTx = h.moduleRef.get(TenantTx);
  // A's board: an open term with seats to spare, the landlord on it. A
  // suite that appoints its own lapses it first.
  await helpers.asManager(a, () =>
    tenantTx.withTenantTx(async (tx) => {
      const termId = await boardTermRow(tx, {
        tenantId: a.tenantId,
        createdById: a.ids.manager,
        open: true,
        seats: 15,
      });
      await boardMemberRow(tx, {
        tenantId: a.tenantId,
        termId,
        accountId: a.ids.landlord,
        addedById: a.ids.manager,
      });
    }),
  );
  return helpers.asManager(b, () =>
    tenantTx.withTenantTx(async (tx) => {
      const seat = await tx.boardMember.findFirstOrThrow({
        where: { accountId: b.ids.owner, endedAt: null },
      });
      const bApprovalId = await approvalRequestRow(tx, {
        tenantId: b.tenantId,
        raisedById: b.ids.manager,
      });
      const bBudgetId = await budgetRow(tx, {
        tenantId: b.tenantId,
        createdById: b.ids.manager,
      });
      const lineId = await budgetLineRow(tx, {
        tenantId: b.tenantId,
        budgetId: bBudgetId,
      });
      return {
        bApprovalId,
        bBoardAppealId: await appealRow(tx, {
          tenantId: b.tenantId,
          unitId: b.homeUnitId,
          appellantId: b.ids.owner,
        }),
        bDecisionAppealId: await decisionAppealRow(tx, {
          tenantId: b.tenantId,
          unitId: b.homeUnitId,
          appellantId: b.ids.owner,
        }),
        bBudgetId,
        bExpenseId: await expenseRow(tx, {
          tenantId: b.tenantId,
          lineId,
          recordedById: b.ids.manager,
        }),
        bBoardMotionId: await motionRow(tx, {
          tenantId: b.tenantId,
          requestId: bApprovalId,
          termId: seat.termId,
          memberId: seat.id,
          accountId: b.ids.owner,
        }),
      };
    }),
  );
}

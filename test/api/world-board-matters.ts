import { TenantTx } from '../../src/core/database/tenant-tx.service';
import type { communityHelpers } from '../setup/community';
import {
  approvalRequestRow,
  boardMemberRow,
  boardTermRow,
  motionRow,
} from '../setup/governance-rows';
import type { HttpHarness } from '../setup/http-app';
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
      return {
        bApprovalId,
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

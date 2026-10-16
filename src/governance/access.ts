import { Injectable } from '@nestjs/common';
import { CommunityGovernancePort } from '../community';
import { PermissionsService } from '../core/access/permissions.service';
import { RequestContext } from '../core/common/cls/request-context';
import { appError, ErrorCode } from '../core/common/errors';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import { dbNow } from './db-clock';

/** Who puts a poll or an election to the owners, and in what capacity. */
export type Author =
  { side: 'manager' } | { side: 'board'; memberId: string; termId: string };

/**
 * The locks and the "who may" of governance (ADR 0051), always in this
 * order:
 *
 * 1. the caller's account row, shared;
 * 2. the compound's board lock, exclusive, for every write to the board
 *    (appoint, a seat filled, changed or ended, a certification);
 * 3. the board seat the caller acts on, shared, when the caller acts as a
 *    board member: ending that seat waits for the action, or the action
 *    sees the seat ended;
 * 4. a vote's row, then its ballot box.
 */
@Injectable()
export class GovernanceAccess {
  constructor(
    private readonly ctx: RequestContext,
    private readonly permissions: PermissionsService,
    private readonly community: CommunityGovernancePort,
  ) {}

  /**
   * The caller's own account row, shared-locked: an erasure, which locks it
   * first, either finished before and the caller is refused, or waits for
   * this write.
   */
  async lockSelf(tx: TenantTxClient): Promise<void> {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM accounts
       WHERE id = ${this.ctx.accountId}::uuid FOR SHARE`;
    if (rows[0]?.status !== 'active')
      throw appError.unauthorized(
        ErrorCode.UNAUTHENTICATED,
        'Authentication required',
      );
  }

  /** The compound's board lock: one board write at a time. */
  async lockBoard(tx: TenantTxClient): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`governance-board:${this.ctx.txTenantId}`}))`;
  }

  /**
   * The units whose vote the caller casts: the units they own now. None:
   * governance is the owners', and the caller finds nothing (404).
   */
  async requireOwner(tx: TenantTxClient): Promise<string[]> {
    const units = await this.community.voteUnits(tx, this.ctx.accountId);
    if (!units.length) throw notAvailable();
    return units;
  }

  /**
   * The manager, or a sitting board member whose seat is now locked
   * shared until the end of the transaction (403 otherwise).
   */
  async requireAuthor(tx: TenantTxClient): Promise<Author> {
    if (await this.permissions.has('governance.manage'))
      return { side: 'manager' };
    const seat = await this.lockSeat(tx, this.ctx.accountId);
    if (!seat)
      throw appError.forbidden(
        ErrorCode.BOARD_SEAT_REQUIRED,
        'Only a sitting board member does this',
      );
    return { side: 'board', ...seat };
  }

  /** The account's seat in the board sitting now, locked shared, or null. */
  async lockSeat(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<{ memberId: string; termId: string } | null> {
    const now = await dbNow(tx);
    const rows = await tx.$queryRaw<{ id: string; term_id: string }[]>`
      SELECT m.id, m.term_id FROM board_members m
        JOIN board_terms t ON t.tenant_id = m.tenant_id AND t.id = m.term_id
       WHERE m.account_id = ${accountId}::uuid AND m.ended_at IS NULL
         AND t.ended_at IS NULL AND t.starts_at <= ${now} AND t.ends_at > ${now}
       FOR SHARE OF m`;
    return rows[0] ? { memberId: rows[0].id, termId: rows[0].term_id } : null;
  }
}

export const notAvailable = () =>
  appError.notFound(
    ErrorCode.GOVERNANCE_NOT_AVAILABLE,
    'Governance is for the units’ owners',
  );

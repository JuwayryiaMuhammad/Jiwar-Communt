import { Injectable } from '@nestjs/common';
import { CommunityGovernancePort } from '../community';
import { PermissionsService } from '../core/access/permissions.service';
import { RequestContext } from '../core/common/cls/request-context';
import { appError, ErrorCode } from '../core/common/errors';
import { isLockNotAvailable } from '../core/database/lock-errors';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import { dbNow } from './db-clock';

/** Who puts a poll or an election to the owners, and in what capacity. */
export type Author =
  { side: 'manager' } | { side: 'board'; memberId: string; termId: string };

/**
 * The locks and the "who may" of governance (ADR 0051), always in this
 * order:
 *
 * 1. account rows (ADR 0036, accounts first): the caller's, shared; and
 *    every account a board write will seat or tell, key-shared in id
 *    order, so an erasure holding one finishes before the board lock is
 *    taken, never while it is held;
 * 2. the compound's board lock, exclusive, for every write to the board
 *    (appoint, a seat filled, changed or ended, a certification);
 * 3. the open term, then the seats: shared by a member acting with their
 *    seat (the seat and its term), for update by whatever ends them (a
 *    seat ended, a term succeeded or replaced). The clock is read after
 *    them: an action decided under the shared lock is dated before the
 *    end that waited for it, or sees the seat ended;
 * 4. a vote's row, then its ballot box.
 *
 * Who a write tells is read plainly before step 1, so it can change by the
 * time the write tells them. An account that joined since is locked late,
 * with `lockLate`: after a seat or the board lock is held, without waiting
 * (an erasure holding it would wait for that lock, a cycle), refused as
 * `GOVERNANCE_BUSY` when it is held, and nothing is written.
 */
@Injectable()
export class GovernanceAccess {
  /** Per transaction: the accounts locked so far, and whether a seat or the board lock is held. */
  private readonly held = new WeakMap<
    object,
    { accounts: Set<string>; seatOrBoard: boolean }
  >();

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
    this.state(tx).accounts.add(this.ctx.accountId);
  }

  /**
   * Accounts a board write will seat or tell (FOR KEY SHARE, in id order),
   * before the board lock.
   */
  async lockAccounts(
    tx: TenantTxClient,
    accountIds: readonly string[],
  ): Promise<void> {
    const ids = [...new Set(accountIds)].sort();
    if (!ids.length) return;
    await tx.$queryRaw`
      SELECT id FROM accounts WHERE id = ANY(${ids}::uuid[])
       ORDER BY id FOR KEY SHARE`;
    const held = this.state(tx).accounts;
    for (const id of ids) held.add(id);
  }

  /**
   * Accounts a write is about to tell or record, read after its locks:
   * those not locked yet are key-shared now. Before any seat or the board
   * lock, that is step 1 and may wait. After it, an erasure holding one
   * would wait for what this transaction holds, so the lock is taken
   * without waiting, and a held one refuses the write (409
   * `GOVERNANCE_BUSY`, retryable).
   */
  async lockLate(
    tx: TenantTxClient,
    accountIds: readonly string[],
  ): Promise<void> {
    const state = this.state(tx);
    const late = [...new Set(accountIds)]
      .filter((id) => !state.accounts.has(id))
      .sort();
    if (!late.length) return;
    if (!state.seatOrBoard) return this.lockAccounts(tx, late);
    try {
      await tx.$queryRaw`
        SELECT id FROM accounts WHERE id = ANY(${late}::uuid[])
         ORDER BY id FOR KEY SHARE NOWAIT`;
    } catch (error) {
      if (isLockNotAvailable(error))
        throw appError.conflict(
          ErrorCode.GOVERNANCE_BUSY,
          'Someone this would tell is being changed; try again',
        );
      throw error;
    }
    for (const id of late) state.accounts.add(id);
  }

  /**
   * Step 1 for a write that may open a poll at once: the accounts of the
   * electorate it would take (each unit's voting owner now), before the
   * seat. Read plainly: one who joins meanwhile is locked late at the
   * snapshot (ADR 0055, closing ADR 0051's Open deadlock).
   */
  async lockElectorate(tx: TenantTxClient): Promise<void> {
    await this.lockAccounts(tx, [
      ...(await this.community.votingOwners(tx)).values(),
    ]);
  }

  /**
   * Step 1 for a write that may open an election's nominations at once:
   * every owner it would tell, before the seat (ADR 0055).
   */
  async lockOwners(tx: TenantTxClient): Promise<void> {
    await this.lockAccounts(tx, await this.community.owners(tx));
  }

  /** The compound's board lock: one board write at a time. */
  async lockBoard(tx: TenantTxClient): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`governance-board:${this.ctx.txTenantId}`}))`;
    this.state(tx).seatOrBoard = true;
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

  /**
   * The account's seat in the board sitting now, the seat and its term
   * locked shared, or null. Ending either waits for the caller's
   * transaction, or the caller sees it ended; whether the term sits is
   * read by the clock after the lock.
   */
  async lockSeat(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<{ memberId: string; termId: string } | null> {
    const rows = await tx.$queryRaw<
      { id: string; term_id: string; starts_at: Date; ends_at: Date }[]
    >`
      SELECT m.id, m.term_id, t.starts_at, t.ends_at FROM board_members m
        JOIN board_terms t ON t.tenant_id = m.tenant_id AND t.id = m.term_id
       WHERE m.account_id = ${accountId}::uuid AND m.ended_at IS NULL
         AND t.ended_at IS NULL
       FOR SHARE OF m, t`;
    if (rows.length) this.state(tx).seatOrBoard = true;
    const now = await dbNow(tx);
    const seat = rows.find((r) => r.starts_at <= now && r.ends_at > now);
    return seat ? { memberId: seat.id, termId: seat.term_id } : null;
  }

  /**
   * Step 3 for a count of the board (ADR 0055): the term shared, then every
   * seat of it not ended, shared, in id order, so nothing seats or unseats
   * a member, or moves the chair, while the count is taken (an end waits on
   * its seat, a seat filled on the term). Returns them: the seats that may
   * count, the chair's among them. Taken after the caller's own seat.
   */
  async lockBoardForVote(
    tx: TenantTxClient,
    termId: string,
  ): Promise<{ memberId: string; accountId: string; role: string }[]> {
    await tx.$queryRaw`
      SELECT id FROM board_terms WHERE id = ${termId}::uuid FOR SHARE`;
    const seats = await tx.$queryRaw<
      { id: string; account_id: string; role: string }[]
    >`
      SELECT id, account_id, role::text AS role FROM board_members
       WHERE term_id = ${termId}::uuid AND ended_at IS NULL
       ORDER BY id FOR SHARE`;
    this.state(tx).seatOrBoard = true;
    return seats.map((s) => ({
      memberId: s.id,
      accountId: s.account_id,
      role: s.role,
    }));
  }

  private state(tx: TenantTxClient) {
    let state = this.held.get(tx);
    if (!state) {
      state = { accounts: new Set(), seatOrBoard: false };
      this.held.set(tx, state);
    }
    return state;
  }
}

export const notAvailable = () =>
  appError.notFound(
    ErrorCode.GOVERNANCE_NOT_AVAILABLE,
    'Governance is for the units’ owners',
  );

import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { PartnersAccess } from '../access';
import { dbNow } from '../db-clock';
import { PartnerNotices } from '../notices/partner-notices';
import { PartnerRequestEngine } from '../requests/request-engine';
import { LIVE } from '../requests/request-rules';
import { PartnersService, partnerNotFound } from './partners.service';
import type { PartnerWithParts } from './views/partner.views';

/**
 * A partner's suspension and reinstatement (ADR 0060), by `partners.manage`.
 *
 * Suspending stops new requests and the partner's desk at once, cancels
 * its live requests as the system (`partner_suspended`, their passes with
 * them), and tells those requesters and everyone who keeps it among their
 * favourites — once each, `partner.suspended`, its target the partner,
 * whose page then offers alternatives in the same categories. Residents
 * are never told why. Reinstating tells nobody.
 *
 * Locks: the accounts to be told are taken FOR KEY SHARE first, in id
 * order (what a notification's foreign key takes anyway), then the
 * partner's row FOR UPDATE, then each request's row. An erasure, which
 * holds its account FOR UPDATE before it reaches for the partner, either
 * finished first or waits for the suspension: the two never wait on each
 * other. Someone who asked or kept it as a favourite in between is taken
 * only if their account is free now (SKIP LOCKED), and is otherwise not
 * told — their request is cancelled all the same.
 */
@Injectable()
export class SuspensionService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly access: PartnersAccess,
    private readonly partners: PartnersService,
    private readonly engine: PartnerRequestEngine,
    private readonly notices: PartnerNotices,
  ) {}

  suspend(
    id: string,
    reasonCode: string | undefined,
  ): Promise<PartnerWithParts> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.partnerSuspend,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      if (
        !(await tx.partner.findUnique({ where: { id }, select: { id: true } }))
      )
        throw partnerNotFound();
      const locked = new Set(
        await this.lockAccounts(tx, await this.concerned(tx, id), false),
      );
      const partner = await this.partners.lock(tx, id, 'update');
      if (partner.status === 'suspended')
        throw appError.conflict(
          ErrorCode.PARTNER_ALREADY_SUSPENDED,
          'The partner is suspended already',
        );
      const now = await dbNow(tx);
      await tx.partner.update({
        where: { id },
        data: {
          status: 'suspended',
          suspendedReason: reason,
          suspendedAt: now,
          suspendedById: this.ctx.accountId,
        },
      });
      const live = await tx.partnerRequest.findMany({
        where: { partnerId: id, status: { in: [...LIVE] } },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      for (const { id: requestId } of live) {
        const request = await this.engine.lock(tx, requestId);
        await this.engine.apply(
          tx,
          request,
          'system_cancel',
          { kind: 'system' },
          { reasonCode: 'partner_suspended', notify: false },
          now,
        );
      }
      // Whoever is concerned now; those not locked before, if free.
      const concerned = await this.concerned(
        tx,
        id,
        live.map((r) => r.id),
      );
      const late = concerned.filter((a) => !locked.has(a));
      const told = [
        ...concerned.filter((a) => locked.has(a)),
        ...(await this.lockAccounts(tx, late, true)),
      ];
      const notified = await this.notices.send(
        tx,
        told,
        'partner.suspended',
        id,
      );
      await this.audit.record(tx, {
        action: 'partner.suspended',
        targetId: id,
        metadata: {
          reasonCode: reason,
          cancelledCount: live.length,
          notifiedCount: notified,
        },
      });
      return this.partners.inTx(tx, id);
    });
  }

  reinstate(id: string): Promise<PartnerWithParts> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const partner = await this.partners.lock(tx, id, 'update');
      if (partner.status !== 'suspended')
        throw appError.conflict(
          ErrorCode.PARTNER_NOT_SUSPENDED,
          'The partner is not suspended',
        );
      await tx.partner.update({
        where: { id },
        data: {
          status: 'active',
          suspendedReason: null,
          suspendedAt: null,
          suspendedById: null,
        },
      });
      await this.audit.record(tx, {
        action: 'partner.reinstated',
        targetId: id,
        metadata: { reasonCode: partner.suspendedReason },
      });
      return this.partners.inTx(tx, id);
    });
  }

  /**
   * The accounts a suspension tells: the requesters of the partner's live
   * requests (or of `cancelled`, once they are cancelled) and everyone who
   * keeps it among their favourites.
   */
  private async concerned(
    tx: TenantTxClient,
    partnerId: string,
    cancelled?: readonly string[],
  ): Promise<string[]> {
    const requests = await tx.partnerRequest.findMany({
      where: cancelled
        ? { id: { in: [...cancelled] } }
        : { partnerId, status: { in: [...LIVE] } },
      select: { requesterId: true },
    });
    const favourites = await tx.partnerFavourite.findMany({
      where: { partnerId },
      select: { accountId: true },
    });
    return [
      ...new Set([
        ...requests.map((r) => r.requesterId),
        ...favourites.map((f) => f.accountId),
      ]),
    ].sort();
  }

  /** The accounts FOR KEY SHARE in id order; with `skipLocked`, those free now. */
  private async lockAccounts(
    tx: TenantTxClient,
    ids: readonly string[],
    skipLocked: boolean,
  ): Promise<string[]> {
    if (!ids.length) return [];
    const rows = skipLocked
      ? await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM accounts WHERE id = ANY(${[...ids]}::uuid[])
           ORDER BY id FOR KEY SHARE SKIP LOCKED`
      : await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM accounts WHERE id = ANY(${[...ids]}::uuid[])
           ORDER BY id FOR KEY SHARE`;
    return rows.map((r) => r.id);
  }
}

import { Injectable } from '@nestjs/common';
import type { PartnerRequest } from '@prisma/client';
import { CommunityPartnersPort } from '../../community';
import { GatePartnersPort, type ServicePass } from '../../gate';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { PartnersAccess } from '../access';
import { dbNow } from '../db-clock';
import { consentedRequests } from './consent-reads';
import {
  PartnerActions,
  type PartnerAction,
  type PartnerActionInput,
} from './partner-actions';
import { deskPasses } from './partner-passes';
import { requestNotFound } from './request-engine';
import { RequestReads, type RequestRead } from './request-reads';
import type { PartnerRequestStatus } from './request-rules';

export interface RelayQuery {
  status?: PartnerRequestStatus;
  partnerId?: string;
  cursor?: string;
  limit?: number;
}

/** A request as the relay reads it: the partner's side of it. */
export interface RelayRead {
  request: RequestRead;
  consented: boolean;
  firstName: string | null;
  pass: ServicePass | null;
}

const PAGE = keysetCursor('createdAt', 'desc');

/**
 * The management's relay (ADR 0060): `partners.manage` reads the
 * compound's requests as a partner would — the unit's code, the requester's
 * first name, the window, the note and the lines, only while the consent
 * holds — and acts for a partner who phones or has no desk link. Every
 * action is the partner's (the same rules as the desk) and is recorded as
 * the relay's, by the staff member.
 */
@Injectable()
export class RelayService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly community: CommunityPartnersPort,
    private readonly access: PartnersAccess,
    private readonly reads: RequestReads,
    private readonly actions: PartnerActions,
    private readonly gate: GatePartnersPort,
  ) {}

  list(q: RelayQuery): Promise<Page<RelayRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.partnerRequest.findMany({
        where: {
          AND: [
            { status: q.status, partnerId: q.partnerId },
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return { ...page, items: await this.read(tx, page.items) };
    });
  }

  get(id: string): Promise<RelayRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.partnerRequest.findUnique({ where: { id } });
      if (!row) throw requestNotFound();
      return (await this.read(tx, [row]))[0];
    });
  }

  act(
    id: string,
    action: PartnerAction,
    input: PartnerActionInput,
  ): Promise<RelayRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const after = await this.actions.act(tx, id, null, action, input, {
        kind: 'relay',
        accountId: this.ctx.accountId,
      });
      return (await this.read(tx, [after]))[0];
    });
  }

  private async read(
    tx: TenantTxClient,
    rows: readonly PartnerRequest[],
  ): Promise<RelayRead[]> {
    const reads = await this.reads.many(tx, rows);
    const consented = await consentedRequests(tx, rows);
    const names = await this.community.firstNames(
      tx,
      rows.map((r) => r.requesterId),
    );
    const passes = await deskPasses(
      this.gate,
      tx,
      rows,
      consented,
      await dbNow(tx),
    );
    return reads.map((r) => ({
      request: r,
      consented: consented.has(r.id),
      firstName: names.get(r.requesterId) ?? null,
      pass: passes.get(r.id) ?? null,
    }));
  }
}

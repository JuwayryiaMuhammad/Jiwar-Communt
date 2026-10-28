import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CommunityGatePort } from '../community';
import { RequestContext } from '../core/common/cls/request-context';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import {
  ResidentItems,
  wantsNumber,
  type ItemCaller,
  type PageRequest,
  type ResidentItem,
} from '../core/resident-items/resident-items';
import { worksCertificateNumber } from './permits/permit-inspections.service';
import { inspectionReference } from './tasks/inspection-requests.service';

const blank = {
  categoryKey: null,
  topicKey: null,
  requestType: null,
  appeal: null,
} as const;

/** A search reads like the first page of a list, both states. */
const first = (take: number, caller: ItemCaller): PageRequest => ({
  after: null,
  take,
  state: null,
  caller,
});

const past = (q: PageRequest, at: Prisma.Sql, id: Prisma.Sql) =>
  q.after
    ? Prisma.sql`(${at}, ${id}) < (${q.after.at}, ${q.after.id}::uuid)`
    : Prisma.sql`TRUE`;

/**
 * The resident's lists (ADR 0058) gain ADR 0063's two requests, each with
 * its own route's visibility:
 * - an inspection request (`GET /units/{unitId}/inspection-requests`): the
 *   requests of the units the caller owns or looks after as a proxy with
 *   `inspections`, and those it asked; found by `IR-` and its number.
 *   Finished: done or cancelled.
 * - a works completion inspection (`GET /permits/{id}/completion-inspections`):
 *   the rounds of the permits the caller asked for; found by the
 *   certificate's `WC-` and its number. Finished: passed or failed.
 */
@Injectable()
export class ResidentInspectionItems implements OnModuleInit {
  constructor(
    private readonly items: ResidentItems,
    private readonly ctx: RequestContext,
    private readonly community: CommunityGatePort,
  ) {}

  onModuleInit(): void {
    this.items.register({
      type: 'inspection_request',
      group: 'request',
      page: (tx, q) => this.requests(tx, q, null),
      search: (tx, q, take, caller) =>
        wantsNumber(q, 'IR')
          ? this.requests(tx, first(take, caller), q.number)
          : Promise.resolve([]),
    });
    this.items.register({
      type: 'works_inspection',
      group: 'request',
      page: (tx, q) => this.works(tx, q, null),
      search: (tx, q, take, caller) =>
        wantsNumber(q, 'WC')
          ? this.works(tx, first(take, caller), q.number)
          : Promise.resolve([]),
    });
  }

  private async requests(
    tx: TenantTxClient,
    q: PageRequest,
    number: number | null,
  ): Promise<ResidentItem[]> {
    if (!q.caller.holds('units.read')) return [];
    const me = this.ctx.accountId;
    const units = await this.community.inspectionUnits(tx, me);
    const conds: Prisma.Sql[] = [
      units.length
        ? Prisma.sql`(r.requested_by = ${me}::uuid OR r.unit_id IN (${Prisma.join(
            units.map((u) => Prisma.sql`${u}::uuid`),
          )}))`
        : Prisma.sql`r.requested_by = ${me}::uuid`,
    ];
    const finished = Prisma.sql`r.status IN ('done', 'cancelled')`;
    if (q.state === 'closed') conds.push(finished);
    if (q.state === 'open') conds.push(Prisma.sql`NOT ${finished}`);
    if (number !== null) conds.push(Prisma.sql`r.number = ${number}`);
    const at = Prisma.sql`GREATEST(r.created_at, COALESCE(r.scheduled_at, r.created_at),
      COALESCE(r.done_at, r.created_at), COALESCE(r.cancelled_at, r.created_at))`;
    const rows = await tx.$queryRaw<
      {
        id: string;
        number: number;
        status: string;
        unit_id: string;
        at: Date;
      }[]
    >`
      SELECT r.id, r.number, r.status, r.unit_id, ${at} AS at
        FROM unit_inspection_requests r
       WHERE ${Prisma.join(conds, ' AND ')} AND ${past(q, at, Prisma.sql`r.id`)}
       ORDER BY at DESC, r.id DESC
       LIMIT ${q.take}`;
    return rows.map((r) => ({
      type: 'inspection_request',
      id: r.id,
      number: inspectionReference(r.number),
      status: r.status,
      lastActivityAt: r.at,
      unitId: r.unit_id,
      kind: null,
      ...blank,
    }));
  }

  private async works(
    tx: TenantTxClient,
    q: PageRequest,
    certificate: number | null,
  ): Promise<ResidentItem[]> {
    if (!q.caller.holds('permits.request')) return [];
    const me = this.ctx.accountId;
    const conds: Prisma.Sql[] = [
      Prisma.sql`p.requested_by_account_id = ${me}::uuid`,
    ];
    const finished = Prisma.sql`i.status IN ('passed', 'failed')`;
    if (q.state === 'closed') conds.push(finished);
    if (q.state === 'open') conds.push(Prisma.sql`NOT ${finished}`);
    if (certificate !== null)
      conds.push(Prisma.sql`i.certificate_number = ${certificate}`);
    const at = Prisma.sql`COALESCE(i.decided_at, i.requested_at)`;
    const rows = await tx.$queryRaw<
      {
        id: string;
        status: string;
        unit_id: string;
        certificate_number: number | null;
        at: Date;
      }[]
    >`
      SELECT i.id, i.status, p.unit_id, i.certificate_number, ${at} AS at
        FROM permit_inspections i
        JOIN unit_permits p ON p.id = i.permit_id AND p.tenant_id = i.tenant_id
       WHERE ${Prisma.join(conds, ' AND ')} AND ${past(q, at, Prisma.sql`i.id`)}
       ORDER BY at DESC, i.id DESC
       LIMIT ${q.take}`;
    return rows.map((r) => ({
      type: 'works_inspection',
      id: r.id,
      number:
        r.certificate_number !== null
          ? worksCertificateNumber(r.certificate_number)
          : null,
      status: r.status,
      lastActivityAt: r.at,
      unitId: r.unit_id,
      kind: 'works',
      ...blank,
    }));
  }
}

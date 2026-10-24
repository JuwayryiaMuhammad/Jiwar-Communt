import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CommunityManagementPort } from '../../community';
import { RequestContext } from '../../core/common/cls/request-context';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import {
  ResidentItems,
  wantsNumber,
  type AppealState,
  type PageRequest,
  type ResidentItem,
} from '../../core/resident-items/resident-items';
import { decisionAppealReference } from './appeal-rules';

/**
 * Decision appeals in the resident's appeals list and search (ADR 0059), as
 * `GET /decision-appeals` lists them: the caller's own, and those of the
 * units they are the primary of. By their last move (lodged, decided,
 * withdrawn); decided by the management, with the decider's role.
 */
@Injectable()
export class ResidentDecisionAppealItems implements OnModuleInit {
  constructor(
    private readonly items: ResidentItems,
    private readonly ctx: RequestContext,
    private readonly community: CommunityManagementPort,
  ) {}

  onModuleInit(): void {
    this.items.register({
      type: 'decision_appeal',
      group: 'appeal',
      page: (tx, q) => this.read(tx, q, null),
      search: (tx, q, take, caller) =>
        wantsNumber(q, 'AP')
          ? this.read(tx, { after: null, take, state: null, caller }, q.number)
          : Promise.resolve([]),
    });
  }

  private async read(
    tx: TenantTxClient,
    q: PageRequest,
    number: number | null,
  ): Promise<ResidentItem[]> {
    if (!q.caller.holds('units.read')) return [];
    const me = this.ctx.accountId;
    const units = await this.community.primaryUnits(tx, me);
    const conds: Prisma.Sql[] = [
      units.length
        ? Prisma.sql`(a.appellant_account_id = ${me}::uuid OR a.unit_id IN (${Prisma.join(units.map((u) => Prisma.sql`${u}::uuid`))}))`
        : Prisma.sql`a.appellant_account_id = ${me}::uuid`,
    ];
    if (q.state === 'open') conds.push(Prisma.sql`a.status = 'pending'`);
    if (q.state === 'closed') conds.push(Prisma.sql`a.status <> 'pending'`);
    if (number !== null) conds.push(Prisma.sql`a.number = ${number}`);
    const at = Prisma.sql`GREATEST(a.lodged_at,
      COALESCE(a.decided_at, a.lodged_at), COALESCE(a.withdrawn_at, a.lodged_at))`;
    const past = q.after
      ? Prisma.sql`(${at}, a.id) < (${q.after.at}, ${q.after.id}::uuid)`
      : Prisma.sql`TRUE`;
    const rows = await tx.$queryRaw<
      {
        id: string;
        number: number;
        kind: string;
        status: string;
        unit_id: string;
        lodged_at: Date;
        decided_at: Date | null;
        decider_role_key: string | null;
        decider_role_name: string | null;
        at: Date;
      }[]
    >`
      SELECT a.id, a.number, a.kind, a.status, a.unit_id, a.lodged_at,
             a.decided_at, a.decider_role_key, a.decider_role_name, ${at} AS at
        FROM decision_appeals a
       WHERE ${Prisma.join(conds, ' AND ')} AND ${past}
       ORDER BY at DESC, a.id DESC
       LIMIT ${q.take}`;
    return rows.map((r) => ({
      type: 'decision_appeal',
      id: r.id,
      number: decisionAppealReference(r.number),
      status: r.status,
      lastActivityAt: r.at,
      unitId: r.unit_id,
      kind: r.kind,
      categoryKey: null,
      topicKey: null,
      requestType: null,
      appeal: {
        state: r.status as AppealState,
        at: r.lodged_at,
        decidedBy: 'management',
        decidedAt: r.decided_at,
        deciderRole: r.decider_role_key
          ? { key: r.decider_role_key, name: r.decider_role_name }
          : null,
      },
    }));
  }
}

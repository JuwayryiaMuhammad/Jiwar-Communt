import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CommunityGovernancePort } from '../../community';
import { RequestContext } from '../../core/common/cls/request-context';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import {
  ResidentItems,
  wantsNumber,
  type AppealState,
  type PageRequest,
  type ResidentItem,
} from '../../core/resident-items/resident-items';
import { appealReference } from './appeal-rules';

/**
 * Appeals to the board in the resident's appeals list and search (ADR
 * 0055, 0058), as `GET /governance/board-appeals` lists them: the caller's
 * own, and those of the units they own or are the primary of. By their
 * last move (lodged, decided, withdrawn); decided by the board.
 */
@Injectable()
export class ResidentAppealItems implements OnModuleInit {
  constructor(
    private readonly items: ResidentItems,
    private readonly ctx: RequestContext,
    private readonly community: CommunityGovernancePort,
  ) {}

  onModuleInit(): void {
    this.items.register({
      type: 'board_appeal',
      group: 'appeal',
      page: (tx, q) => this.read(tx, q, null),
      search: (tx, q, take, caller) =>
        wantsNumber(q, 'BA')
          ? this.read(tx, { after: null, take, state: null, caller }, q.number)
          : Promise.resolve([]),
    });
  }

  private async read(
    tx: TenantTxClient,
    q: PageRequest,
    number: number | null,
  ): Promise<ResidentItem[]> {
    if (!q.caller.holds('governance.read')) return [];
    const me = this.ctx.accountId;
    const units = await this.community.appealUnits(tx, me);
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
        at: Date;
      }[]
    >`
      SELECT a.id, a.number, a.kind, a.status, a.unit_id, a.lodged_at,
             a.decided_at, ${at} AS at
        FROM governance_board_appeals a
       WHERE ${Prisma.join(conds, ' AND ')} AND ${past}
       ORDER BY at DESC, a.id DESC
       LIMIT ${q.take}`;
    return rows.map((r) => ({
      type: 'board_appeal',
      id: r.id,
      number: appealReference(r.number),
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
        decidedBy: 'board',
        decidedAt: r.decided_at,
      },
    }));
  }
}

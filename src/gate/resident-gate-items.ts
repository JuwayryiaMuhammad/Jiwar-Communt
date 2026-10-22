import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type UnitPermitKind } from '@prisma/client';
import { CommunityGatePort } from '../community';
import { RequestContext } from '../core/common/cls/request-context';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import {
  ResidentItems,
  type ItemCaller,
  wantsNumber,
  type AppealState,
  type ItemQuery,
  type PageRequest,
  type ResidentItem,
} from '../core/resident-items/resident-items';
import { PERMIT_PREFIX, permitReference } from './permits/permit-core';
import { safetyReference } from './safety/safety-rules';
import { reference } from './vehicles/vehicle-rules';

const uuids = (ids: readonly string[]) =>
  Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));

/** Each list's "strictly past the cursor" on a computed time. */
const pastSql = (at: Prisma.Sql, q: PageRequest, id: Prisma.Sql) =>
  q.after
    ? Prisma.sql`(${at}, ${id}) < (${q.after.at}, ${q.after.id}::uuid)`
    : Prisma.sql`TRUE`;

const blank = {
  categoryKey: null,
  topicKey: null,
  requestType: null,
} as const;

/** A first-level appeal's state, in the codes every appeal shares. */
function appealOf(r: {
  appealed_at: Date | null;
  appeal_decision: string | null;
  decided_at: Date | null;
}): ResidentItem['appeal'] {
  if (!r.appealed_at) return null;
  const state: AppealState =
    r.appeal_decision === 'upheld'
      ? 'upheld'
      : r.appeal_decision === 'cancelled'
        ? 'overturned'
        : 'pending';
  return {
    state,
    at: r.appealed_at,
    decidedBy: 'management',
    decidedAt: r.decided_at,
  };
}

/**
 * The gate's items in the resident's lists and search (ADR 0058), each by
 * its own list route's rule:
 * - a permit (`GET /units/{unitId}/permits`): the unit's primary sees the
 *   unit's, anyone else those they asked for; `permits.request` holders;
 * - a vehicle fine and a violation (`GET /units/{unitId}/vehicle-fines`,
 *   `…/violations`): on units where the caller holds `vehicles` or
 *   `financeView`; the appeals list has those appealed at the management;
 * - a parcel (`GET /me/parcels`): on units where the caller holds
 *   `parcels`; found by its number only.
 */
@Injectable()
export class ResidentGateItems implements OnModuleInit {
  constructor(
    private readonly items: ResidentItems,
    private readonly ctx: RequestContext,
    private readonly community: CommunityGatePort,
  ) {}

  onModuleInit(): void {
    this.items.register({
      type: 'unit_permit',
      group: 'request',
      page: (tx, q) => this.permits(tx, q, null),
      search: (tx, q, take, caller) => this.findPermits(tx, q, take, caller),
    });
    this.items.register({
      type: 'vehicle_fine',
      group: 'appeal',
      page: (tx, q) => this.fines(tx, 'vehicle_fines', q, null),
      search: (tx, q, take, caller) =>
        wantsNumber(q, 'F')
          ? this.fines(tx, 'vehicle_fines', open(take, caller), q.number)
          : Promise.resolve([]),
    });
    this.items.register({
      type: 'unit_violation',
      group: 'appeal',
      page: (tx, q) => this.fines(tx, 'unit_violations', q, null),
      search: (tx, q, take, caller) =>
        wantsNumber(q, 'V')
          ? this.fines(tx, 'unit_violations', open(take, caller), q.number)
          : Promise.resolve([]),
    });
    this.items.register({
      type: 'parcel',
      group: null,
      search: (tx, q, take) => this.findParcels(tx, q, take),
    });
  }

  private async permits(
    tx: TenantTxClient,
    q: PageRequest,
    only: { kind: UnitPermitKind; number: number } | null,
  ): Promise<ResidentItem[]> {
    if (!q.caller.holds('permits.request')) return [];
    const me = this.ctx.accountId;
    const primary = await this.community.primaryUnits(tx, me);
    const conds: Prisma.Sql[] = [
      primary.length
        ? Prisma.sql`(p.requested_by_account_id = ${me}::uuid OR p.unit_id IN (${uuids(primary)}))`
        : Prisma.sql`p.requested_by_account_id = ${me}::uuid`,
    ];
    // Finished: decided against, cancelled, revoked, used, or ended.
    const finished = Prisma.sql`(p.status IN ('rejected', 'cancelled', 'revoked', 'used')
      OR (p.status = 'approved' AND p.ends_at <= now()))`;
    if (q.state === 'closed') conds.push(finished);
    if (q.state === 'open') conds.push(Prisma.sql`NOT ${finished}`);
    if (only)
      conds.push(
        Prisma.sql`p.kind = ${only.kind}::unit_permit_kind AND p.number = ${only.number}`,
      );
    const at = Prisma.sql`GREATEST(p.created_at, p.updated_at,
      COALESCE(p.decided_at, p.created_at), COALESCE(p.cancelled_at, p.created_at),
      COALESCE(p.revoked_at, p.created_at), COALESCE(p.used_at, p.created_at))`;
    const rows = await tx.$queryRaw<
      {
        id: string;
        kind: UnitPermitKind;
        number: number;
        status: string;
        unit_id: string;
        at: Date;
      }[]
    >`
      SELECT p.id, p.kind, p.number, p.unit_id, ${at} AS at,
             CASE WHEN p.status = 'approved' AND p.ends_at <= now()
                  THEN 'ended' ELSE p.status::text END AS status
        FROM unit_permits p
       WHERE ${Prisma.join(conds, ' AND ')} AND ${pastSql(at, q, Prisma.sql`p.id`)}
       ORDER BY at DESC, p.id DESC
       LIMIT ${q.take}`;
    return rows.map((r) => ({
      type: 'unit_permit',
      id: r.id,
      number: permitReference(r.kind, r.number),
      status: r.status,
      lastActivityAt: r.at,
      unitId: r.unit_id,
      kind: r.kind,
      ...blank,
      appeal: null,
    }));
  }

  /** By reference (`W-0042`, `E-12`): its letter names the kind. */
  private async findPermits(
    tx: TenantTxClient,
    q: ItemQuery,
    take: number,
    caller: ItemCaller,
  ): Promise<ResidentItem[]> {
    if (q.number === null || q.prefix === null) return [];
    const kind = (Object.keys(PERMIT_PREFIX) as UnitPermitKind[]).find(
      (k) => PERMIT_PREFIX[k] === q.prefix,
    );
    if (!kind) return [];
    return this.permits(tx, open(take, caller), { kind, number: q.number });
  }

  /**
   * Fines or violations of the units whose fines the caller sees: in the
   * appeals list, those appealed (by their appeal's last move); found by
   * number, any of them.
   */
  private async fines(
    tx: TenantTxClient,
    table: 'vehicle_fines' | 'unit_violations',
    q: PageRequest,
    number: number | null,
  ): Promise<ResidentItem[]> {
    if (!q.caller.holds('units.read')) return [];
    const me = this.ctx.accountId;
    const units = [
      ...new Set([
        ...(await this.community.unitsWhere(tx, me, 'vehicles')),
        ...(await this.community.unitsWhere(tx, me, 'financeView')),
      ]),
    ];
    if (!units.length) return [];
    const t = Prisma.raw(table);
    const conds: Prisma.Sql[] = [Prisma.sql`f.unit_id IN (${uuids(units)})`];
    if (number === null) conds.push(Prisma.sql`f.appealed_at IS NOT NULL`);
    else conds.push(Prisma.sql`f.number = ${number}`);
    if (q.state === 'open') conds.push(Prisma.sql`f.decided_at IS NULL`);
    if (q.state === 'closed') conds.push(Prisma.sql`f.decided_at IS NOT NULL`);
    const at =
      number === null
        ? Prisma.sql`COALESCE(f.decided_at, f.appealed_at)`
        : Prisma.sql`f.created_at`;
    const rows = await tx.$queryRaw<
      {
        id: string;
        number: number;
        status: string;
        unit_id: string;
        kind: string | null;
        appealed_at: Date | null;
        appeal_decision: string | null;
        decided_at: Date | null;
        at: Date;
      }[]
    >`
      SELECT f.id, f.number, f.status::text AS status, f.unit_id,
             ${table === 'unit_violations' ? Prisma.sql`f.kind` : Prisma.sql`NULL::text`} AS kind,
             f.appealed_at, f.appeal_decision::text AS appeal_decision,
             f.decided_at, ${at} AS at
        FROM ${t} f
       WHERE ${Prisma.join(conds, ' AND ')} AND ${pastSql(at, q, Prisma.sql`f.id`)}
       ORDER BY at DESC, f.id DESC
       LIMIT ${q.take}`;
    const violation = table === 'unit_violations';
    return rows.map((r) => ({
      type: violation ? 'unit_violation' : 'vehicle_fine',
      id: r.id,
      number: violation
        ? safetyReference('V', r.number)
        : reference('F', r.number),
      status: r.status,
      lastActivityAt: r.at,
      unitId: r.unit_id,
      kind: r.kind,
      ...blank,
      appeal: appealOf(r),
    }));
  }

  /** A parcel's number, as the parcel screens show it (no prefix). */
  private async findParcels(
    tx: TenantTxClient,
    q: ItemQuery,
    take: number,
  ): Promise<ResidentItem[]> {
    if (q.number === null || q.prefix !== null) return [];
    const units = await this.community.unitsWhere(
      tx,
      this.ctx.accountId,
      'parcels',
    );
    if (!units.length) return [];
    const rows = await tx.parcel.findMany({
      where: { unitId: { in: units }, number: q.number },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        number: true,
        status: true,
        unitId: true,
        receivedAt: true,
      },
    });
    return rows.map((r) => ({
      type: 'parcel',
      id: r.id,
      number: String(r.number),
      status: r.status,
      lastActivityAt: r.receivedAt,
      unitId: r.unitId,
      kind: null,
      ...blank,
      appeal: null,
    }));
  }
}

/** A search reads like the first page of a list, both states. */
const open = (take: number, caller: ItemCaller): PageRequest => ({
  after: null,
  take,
  state: null,
  caller,
});

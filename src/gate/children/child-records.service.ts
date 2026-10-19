import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { ChildPickup, Prisma } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import { firstNameOf, firstNameRef } from '../../core/common/http/personal';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { dbNow } from '../db-clock';
import { DutyNamesReader } from '../roster/duty-names';
import { PostView } from '../roster/views/roster.views';
import { ChildCore } from './child-core';
import { CHILD_RECORD_RETENTION_DAYS } from './child-rules';
import type {
  ChildAlertView,
  ChildPickupView,
} from './views/child-record.views';

/** The 30-day purge of the children's records (ADR 0054). */
export const CHILD_RECORDS_PURGE_SWEEP = 'gate.child_records_purge';

const DAY = 86_400_000;
const CURSOR = keysetCursor('at');

/** The keepers' alerts: refused, and not by a lockdown. */
const ALERTS = {
  outcome: 'refused',
  NOT: { refusalReason: 'lockdown' },
} satisfies Prisma.ChildPickupWhereInput;

const alertNotFound = () =>
  appError.notFound(ErrorCode.CHILD_ALERT_NOT_FOUND, 'Alert not found');

/**
 * A child's exits, kept 30 days (ADR 0054): the household adults read their
 * own children's; the roster's keepers read the unauthorized pickups only,
 * without the child. Nobody else reads any. The sweep deletes records 30
 * days after they were made, and clears the name and phone of an outside
 * escort revoked 30 days ago (their records are gone by then too).
 */
@Injectable()
export class ChildRecordsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly core: ChildCore,
    private readonly community: CommunityGatePort,
    private readonly audit: AuditService,
    private readonly names: DutyNamesReader,
    private readonly sweep: SweepRunner,
  ) {}

  onModuleInit(): void {
    this.sweep.register(CHILD_RECORDS_PURGE_SWEEP, (now) => this.purge(now));
  }

  /** The unit's children's exits, newest first, for the household adults. */
  forHousehold(
    unitId: string,
    q: { memberId?: string; cursor?: string; limit: number },
  ): Promise<Page<ChildPickupView>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.requireReader(tx, unitId);
      const since = await this.since(tx);
      const controls = q.memberId
        ? (
            await tx.childControl.findMany({
              where: { unitId, memberId: q.memberId },
              select: { id: true },
            })
          ).map((c) => c.id)
        : undefined;
      const rows = await tx.childPickup.findMany({
        where: {
          AND: [
            ...CURSOR.after(q.cursor),
            { unitId, at: { gte: since } },
            ...(controls ? [{ controlId: { in: controls } }] : []),
          ],
        },
        orderBy: CURSOR.orderBy,
        take: q.limit + 1,
      });
      const page = CURSOR.toPage(rows, q.limit);
      return {
        items: await this.householdViews(tx, page.items),
        nextCursor: page.nextCursor,
      };
    });
  }

  /**
   * The unauthorized pickups of the last 30 days, newest first. A refusal
   * under a lockdown is not one (ADR 0053): the household is told, and the
   * keepers ran the lockdown.
   */
  alerts(q: { cursor?: string; limit: number }): Promise<Page<ChildAlertView>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.childPickup.findMany({
        where: {
          AND: [
            ...CURSOR.after(q.cursor),
            { ...ALERTS, at: { gte: await this.since(tx) } },
          ],
        },
        orderBy: CURSOR.orderBy,
        take: q.limit + 1,
      });
      const page = CURSOR.toPage(rows, q.limit);
      return {
        items: await this.alertViews(tx, page.items),
        nextCursor: page.nextCursor,
      };
    });
  }

  alert(id: string): Promise<ChildAlertView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.childPickup.findFirst({
        where: { id, ...ALERTS, at: { gte: await this.since(tx) } },
      });
      if (!row) throw alertNotFound();
      const [view] = await this.alertViews(tx, [row]);
      return view;
    });
  }

  /**
   * Records made 30 days ago or more go, one compound at a time; how many
   * is audited, never whose. Then the outside escorts revoked 30 days ago
   * lose their name and phone, one audit entry each (ids only).
   */
  purge(now: Date): Promise<number> {
    const before = new Date(now.getTime() - CHILD_RECORD_RETENTION_DAYS * DAY);
    return this.sweep.forEachTenant(async (tx) => {
      const { count } = await tx.childPickup.deleteMany({
        where: { at: { lt: before } },
      });
      if (count)
        await this.audit.record(tx, {
          action: 'child_pickup.purged',
          targetId: null,
          metadata: { records: count },
        });
      const cleared = await tx.$queryRaw<{ id: string }[]>`
        UPDATE child_escorts
           SET full_name = NULL, phone = NULL,
               pii_cleared_at = date_trunc('milliseconds', clock_timestamp()),
               updated_at = date_trunc('milliseconds', clock_timestamp())
         WHERE kind = 'outside' AND pii_cleared_at IS NULL
           AND revoked_at < ${before}
        RETURNING id`;
      for (const { id } of cleared)
        await this.audit.record(tx, {
          action: 'child_escort.pii_cleared',
          targetId: id,
        });
      return count + cleared.length;
    });
  }

  // --------------------------------------------------------------------------

  private async since(tx: TenantTxClient): Promise<Date> {
    return new Date(
      (await dbNow(tx)).getTime() - CHILD_RECORD_RETENTION_DAYS * DAY,
    );
  }

  private async householdViews(
    tx: TenantTxClient,
    rows: readonly ChildPickup[],
  ): Promise<ChildPickupView[]> {
    if (!rows.length) return [];
    const controls = new Map(
      (
        await tx.childControl.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.controlId))] } },
          select: { id: true, memberId: true },
        })
      ).map((c) => [c.id, c.memberId]),
    );
    const minors = await this.community.minorsById(tx, [...controls.values()]);
    const escorts = await this.escortNames(tx, rows);
    const names = await this.names.read(tx, [], rows);
    return rows.map((r) => {
      const memberId = controls.get(r.controlId)!;
      return {
        id: r.id,
        memberId,
        firstName: firstNameOf(minors.get(memberId)?.fullName ?? null) ?? '',
        outcome: r.outcome,
        method: r.method,
        refusalReason: r.refusalReason,
        escort: r.escortKind
          ? { kind: r.escortKind, firstName: escorts.get(r.escortId!) ?? null }
          : null,
        post: PostView.of(r, names),
        at: r.at,
      };
    });
  }

  /** The escort's first name as the household knows it, by escort id. */
  private async escortNames(
    tx: TenantTxClient,
    rows: readonly ChildPickup[],
  ): Promise<Map<string, string | null>> {
    const ids = [
      ...new Set(rows.flatMap((r) => (r.escortId ? [r.escortId] : []))),
    ];
    if (!ids.length) return new Map();
    const escorts = await tx.childEscort.findMany({
      where: { id: { in: ids } },
      select: { id: true, accountId: true, engagementId: true, fullName: true },
    });
    const accounts = new Map(
      (
        await tx.account.findMany({
          where: {
            id: {
              in: escorts.flatMap((e) => (e.accountId ? [e.accountId] : [])),
            },
          },
          select: { id: true, fullName: true },
        })
      ).map((a) => [a.id, a.fullName]),
    );
    const out = new Map<string, string | null>();
    for (const e of escorts) {
      let name = e.fullName;
      if (e.accountId) name = accounts.get(e.accountId) ?? null;
      if (e.engagementId)
        name =
          (await this.community.engagementById(tx, e.engagementId))
            ?.workerName ?? null;
      out.set(e.id, firstNameOf(name));
    }
    return out;
  }

  private async alertViews(
    tx: TenantTxClient,
    rows: readonly ChildPickup[],
  ): Promise<ChildAlertView[]> {
    if (!rows.length) return [];
    const names = await this.names.read(
      tx,
      rows.map((r) => r.guardAccountId),
      rows,
    );
    const units = await this.community.unitCodes(
      tx,
      rows.map((r) => r.unitId),
    );
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      post: PostView.of(r, names),
      guard: firstNameRef(
        names.people.get(r.guardAccountId) ?? {
          id: r.guardAccountId,
          fullName: null,
          status: 'erased',
        },
      ),
      unitCode: units.get(r.unitId) ?? '',
      method: r.method,
      escortKind: r.escortKind,
      refusalReason: r.refusalReason,
    }));
  }
}

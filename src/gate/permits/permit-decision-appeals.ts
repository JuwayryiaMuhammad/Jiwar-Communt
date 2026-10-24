import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { UnitPermit } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { localParts } from '../../core/common/slots/day-slots';
import {
  DecisionAppeals,
  type DecisionAppealEffect,
  type DecisionAppealEffectReason,
} from '../../core/decision-appeals/decision-appeals';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { BlocklistMatcher } from '../blocklist/blocklist-matcher';
import { PermitCore, permitReference } from './permit-core';
import { PermitSettingsService } from './permit-settings.service';
import { isWorkDay, type WorkRules } from './permit-rules';
import { daysOf, UNIT_LIMIT } from './permits.service';

/**
 * A rejected permit appealed to the management (ADR 0059), registered with
 * core's DecisionAppeals. The unit's primary appeals it. While the appeal
 * is open the permit is marked, so the purge keeps its data; taken on to
 * the board, it is marked again until the board decides.
 *
 * An overturn approves it through the checks a permit passes to be asked
 * and approved, in the permits' lock order (the unit's lock, the
 * compound's rules FOR SHARE, the permit's row): its window has not
 * passed, its data was not purged, its requester may still ask for it, the
 * unit's live permits of the kind are under the limit, the compound's work
 * days and hours take it (works and moves), and no plate on it is banned.
 * Any refusal leaves it rejected and the overturn to the management
 * (`follow_up`, with the check), never a forced approval. Applied, the
 * requester is told as an approval tells them.
 */
@Injectable()
export class PermitDecisionAppeals implements OnModuleInit {
  constructor(
    private readonly registry: DecisionAppeals,
    private readonly ctx: RequestContext,
    private readonly core: PermitCore,
    private readonly community: CommunityGatePort,
    private readonly settings: PermitSettingsService,
    private readonly blocklist: BlocklistMatcher,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.registry.register('permit_rejection', {
      resolve: async (tx, id, accountId) => {
        const p = await this.lockRow(tx, id);
        if (!p) return null;
        const place = await this.community.placeIn(tx, accountId, p.unitId);
        if (!place?.unitView) return null;
        return {
          unitId: p.unitId,
          decidedAt: p.status === 'rejected' ? p.decidedAt : null,
          deciderId: p.decidedById,
          mayAppeal: await this.community.isPrimary(tx, p.unitId, accountId),
          refused: p.decisionAppealAt
            ? 'appealed'
            : p.status !== 'rejected'
              ? 'not_in_force'
              : null,
        };
      },
      // Marked at the appeal, and marked again when the management's
      // decision goes to the board (the first time stays).
      lodged: async (tx, id, now) => {
        const p = await tx.unitPermit.findUniqueOrThrow({
          where: { id },
          select: { decisionAppealAt: true },
        });
        await tx.unitPermit.update({
          where: { id },
          data: {
            decisionAppealAt: p.decisionAppealAt ?? now,
            decisionAppealClosedAt: null,
          },
        });
      },
      closed: (tx, id, outcome, ev) => this.closed(tx, id, outcome, ev),
      describe: async (tx, id) => {
        const p = await tx.unitPermit.findUnique({ where: { id } });
        if (!p) return null;
        return {
          reference: permitReference(p.kind, p.number),
          kind: p.kind,
          status: p.status,
          startsAt: p.startsAt,
          endsAt: p.endsAt,
          rejectReason: p.rejectReason,
          decidedAt: p.decidedAt,
          appealOverturnedAt: p.appealOverturnedAt,
        };
      },
    });
  }

  private async closed(
    tx: TenantTxClient,
    id: string,
    outcome: 'upheld' | 'overturned' | 'withdrawn',
    ev: { now: Date; decidedById: string | null; appealId: string },
  ): Promise<DecisionAppealEffect> {
    const peek = await tx.unitPermit.findUnique({
      where: { id },
      select: { unitId: true },
    });
    if (!peek) return { effect: 'none' };
    // The permits' lock order: the unit, the rules, the row.
    await this.core.lockUnit(tx, peek.unitId);
    const rules = await this.settings.rules(tx, this.ctx.txTenantId, 'share');
    const p = await this.lockRow(tx, id);
    if (!p?.decisionAppealAt || p.decisionAppealClosedAt)
      return { effect: 'none' };
    if (outcome !== 'overturned' || p.status !== 'rejected') {
      await tx.unitPermit.update({
        where: { id },
        data: { decisionAppealClosedAt: ev.now },
      });
      return outcome === 'overturned'
        ? { effect: 'none', reason: 'changed' }
        : { effect: 'none' };
    }
    const refusal = await this.refusal(tx, p, rules, ev.now);
    if (refusal) {
      await tx.unitPermit.update({
        where: { id },
        data: { decisionAppealClosedAt: ev.now },
      });
      return { effect: 'follow_up', reason: refusal };
    }
    await tx.unitPermit.update({
      where: { id },
      data: {
        status: 'approved',
        decisionAppealClosedAt: ev.now,
        appealOverturnedAt: ev.now,
        appealOverturnedById: ev.decidedById,
      },
    });
    await this.audit.record(tx, {
      action: 'unit_permit.approved',
      targetId: id,
      metadata: {
        kind: p.kind,
        unitId: p.unitId,
        note: false,
        appealId: ev.appealId,
        side: ev.decidedById ? 'management' : 'board',
      },
    });
    await this.core.notify(tx, [p.requestedById], 'unit_permit.approved', id, {
      permitKind: p.kind,
    });
    return { effect: 'applied' };
  }

  /** What a normal ask and approval would refuse now, or null. */
  private async refusal(
    tx: TenantTxClient,
    p: UnitPermit,
    rules: WorkRules,
    now: Date,
  ): Promise<DecisionAppealEffectReason | null> {
    if (p.purgedAt) return 'purged';
    if (p.endsAt.getTime() <= now.getTime()) return 'window_passed';
    // Its requester may still ask for it (as PermitCore.requireRequester).
    const requester = await tx.account.findUnique({
      where: { id: p.requestedById },
      select: { status: true },
    });
    const caps =
      requester?.status === 'active'
        ? await this.community.placeIn(tx, p.requestedById, p.unitId)
        : null;
    const allowed =
      !!caps?.unitView &&
      (p.kind === 'event'
        ? caps.visitorsInvite
        : await this.community.isPrimary(tx, p.unitId, p.requestedById));
    if (!allowed) return 'requester_gone';
    // The unit's live permits of the kind, under its lock.
    const live = await tx.unitPermit.count({
      where: {
        unitId: p.unitId,
        kind: p.kind,
        status: { in: ['pending', 'approved'] },
        endsAt: { gt: now },
        id: { not: p.id },
      },
    });
    if (live >= UNIT_LIMIT[p.kind]) return 'unit_limit';
    if (!(await this.withinWorkRules(tx, p, rules, now))) return 'work_rules';
    // A banned plate on it: a person decides (a watch lets it in).
    const plates =
      p.kind === 'move'
        ? [p.truckPlate]
        : p.kind === 'event'
          ? (
              await tx.permitGuest.findMany({
                where: { permitId: p.id, removedAt: null },
                select: { vehiclePlate: true },
              })
            ).map((g) => g.vehiclePlate)
          : [];
    if ((await this.blocklist.check(tx, { plates })).kind === 'ban')
      return 'blocklisted';
    return null;
  }

  /**
   * The compound's work rules now: a works period keeps a work day ahead
   * and its daily hours inside the work hours; a move's day is a work day
   * and its window inside them. Exits and events have none.
   */
  private async withinWorkRules(
    tx: TenantTxClient,
    p: UnitPermit,
    rules: WorkRules,
    now: Date,
  ): Promise<boolean> {
    const zone = await this.core.timeZone(tx);
    if (p.kind === 'works') {
      if (p.dailyFrom === null || p.dailyTo === null) return false;
      if (p.dailyFrom < rules.workFrom || p.dailyTo > rules.workTo)
        return false;
      const today = localParts(now, zone).date;
      const first = localParts(p.startsAt, zone).date;
      const last = localParts(p.endsAt, zone).date;
      const from = first > today ? first : today;
      return (
        from <= last && daysOf(from, last).some((d) => isWorkDay(rules, d))
      );
    }
    if (p.kind === 'move') {
      const start = localParts(p.startsAt, zone);
      const end = localParts(p.endsAt, zone);
      const endMinute = end.date === start.date ? end.minute : 24 * 60;
      return (
        isWorkDay(rules, start.date) &&
        start.minute >= rules.workFrom &&
        endMinute <= rules.workTo
      );
    }
    return true;
  }

  private async lockRow(
    tx: TenantTxClient,
    id: string,
  ): Promise<UnitPermit | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM unit_permits WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) return null;
    return tx.unitPermit.findUniqueOrThrow({ where: { id } });
  }
}

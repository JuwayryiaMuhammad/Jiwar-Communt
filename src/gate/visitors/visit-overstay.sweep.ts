import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type GateSubjectType } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';
import { GateSettingsService } from '../settings/gate-settings.service';
import {
  expectedMinutes,
  OVERSTAY_LOOKBACK_HOURS,
  OVERSTAY_SUBJECTS,
  overstayDue,
} from './overstay-rules';

export const VISIT_OVERSTAY_SWEEP = 'gate.visit_overstay';

interface OpenVisit {
  entry_id: string;
  subject_type: GateSubjectType;
  subject_id: string;
  gate_id: string;
  unit_id: string;
  occurred_at: Date;
}

/**
 * Visit overstay (ADR 0056), compound by compound: a visitor still inside
 * past their visit's expected length — their pass's, else the compound's —
 * alerts the guards on shift at the gate they came in by (every guard on
 * shift when none is there) and the host, once per visit. Nothing else
 * happens.
 *
 * "Inside" is the gate log's own rule: exits close entries first in,
 * first out, so a subject with `k` inside has its latest `k` `in`s open.
 * Once per visit is the alert row's key, the `in` entry: an insert that
 * finds it there (another sweep, at the same moment) alerts nobody.
 */
@Injectable()
export class VisitOverstaySweep implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly settings: GateSettingsService,
    private readonly safety: SafetyCore,
    private readonly community: CommunityGatePort,
  ) {}

  onModuleInit(): void {
    this.sweep.register(VISIT_OVERSTAY_SWEEP, () =>
      this.sweep.forEachTenant((tx, tenantId) => this.run(tx, tenantId)),
    );
  }

  private async run(tx: TenantTxClient, tenantId: string): Promise<number> {
    const { visitExpectedMinutes } = await this.settings.read(tx);
    const now = await dbNow(tx);
    const since = new Date(now.getTime() - OVERSTAY_LOOKBACK_HOURS * 3_600_000);
    const subjects = Prisma.join(
      OVERSTAY_SUBJECTS.map((s) => Prisma.sql`${s}::gate_subject_type`),
    );
    const open = await tx.$queryRaw<OpenVisit[]>`
      WITH recent AS (
        SELECT DISTINCT subject_type, subject_id FROM gate_entries
         WHERE direction = 'in' AND occurred_at > ${since}
           AND subject_type IN (${subjects})
      ), inside AS (
        SELECT e.subject_type, e.subject_id,
               (count(*) FILTER (WHERE e.direction = 'in')
                - count(*) FILTER (WHERE e.direction = 'out'))::int AS n
          FROM gate_entries e JOIN recent r USING (subject_type, subject_id)
         GROUP BY e.subject_type, e.subject_id
      ), ins AS (
        SELECT e.id, e.subject_type, e.subject_id, e.gate_id, e.unit_id, e.occurred_at,
               row_number() OVER (PARTITION BY e.subject_type, e.subject_id
                                  ORDER BY e.occurred_at DESC, e.recorded_at DESC, e.id DESC) AS rank
          FROM gate_entries e JOIN inside i USING (subject_type, subject_id)
         WHERE e.direction = 'in' AND i.n > 0
      )
      SELECT ins.id AS entry_id, ins.subject_type, ins.subject_id, ins.gate_id,
             ins.unit_id, ins.occurred_at
        FROM ins JOIN inside i USING (subject_type, subject_id)
       WHERE ins.rank <= i.n
         AND NOT EXISTS (SELECT 1 FROM visit_overstay_alerts a WHERE a.entry_id = ins.id)
       ORDER BY ins.occurred_at, ins.id`;
    let alerted = 0;
    for (const v of open) {
      const minutes = expectedMinutes(
        v.subject_type === 'visitor_pass'
          ? (
              await tx.visitorPass.findUnique({
                where: { id: v.subject_id },
                select: { expectedMinutes: true },
              })
            )?.expectedMinutes
          : null,
        visitExpectedMinutes,
      );
      if (minutes === null || overstayDue(v.occurred_at, minutes) > now)
        continue;
      const first = await tx.$queryRaw<{ entry_id: string }[]>`
        INSERT INTO visit_overstay_alerts
          (tenant_id, entry_id, subject_type, subject_id, gate_id, unit_id,
           entered_at, expected_minutes, alerted_at)
        VALUES (${tenantId}::uuid, ${v.entry_id}::uuid, ${v.subject_type}::gate_subject_type,
                ${v.subject_id}::uuid, ${v.gate_id}::uuid, ${v.unit_id}::uuid,
                ${v.occurred_at}, ${minutes}, ${now})
        ON CONFLICT (tenant_id, entry_id) DO NOTHING
        RETURNING entry_id`;
      if (!first.length) continue;
      const params = {
        unitCode: await this.community.unitCode(tx, v.unit_id),
        minutes,
      };
      const atGate = await this.safety.guardsOnShift(tx, v.gate_id);
      await this.safety.notify(
        tx,
        atGate.length ? atGate : await this.safety.guardsOnShift(tx),
        'visit.overstayed',
        v.entry_id,
        params,
      );
      await this.safety.notify(
        tx,
        await this.hosts(tx, v),
        'visit.overstayed_host',
        v.entry_id,
        params,
      );
      alerted++;
    }
    return alerted;
  }

  /**
   * Who invited them: a pass's host; the household member who let a gate
   * request in (else everyone who may invite on the unit). A field
   * exception's visitor was let in by the management: no host.
   */
  private async hosts(tx: TenantTxClient, v: OpenVisit): Promise<string[]> {
    if (v.subject_type === 'visitor_pass') {
      const pass = await tx.visitorPass.findUnique({
        where: { id: v.subject_id },
        select: { hostAccountId: true },
      });
      return pass ? [pass.hostAccountId] : [];
    }
    if (v.subject_type === 'gate_request') {
      const r = await tx.gateApprovalRequest.findUnique({
        where: { id: v.subject_id },
        select: { decidedById: true },
      });
      if (r?.decidedById) return [r.decidedById];
      return this.community.holders(tx, v.unit_id, 'visitorsInvite');
    }
    return [];
  }
}

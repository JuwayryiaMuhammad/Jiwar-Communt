import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { ExperienceSignal } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { clampLimit, keysetCursor, type Page } from '../common/cursor';
import { newId } from '../common/uuid';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { SweepRunner } from '../sweep/sweep-runner';
import { ExperienceCasesService } from './experience-cases.service';
import { ExperienceSettingsService } from './experience-settings.service';
import {
  ExperienceSources,
  type ExperienceEvent,
  type SignalCode,
  type UnitLabel,
} from './experience-sources';

export const SIGNALS_SWEEP = 'experience.signals';
/** Every 15 minutes: a signal is a day's matter, not a minute's. */
const SIGNALS_EVERY_MS = 15 * 60_000;
/** A rule's window is whole days of 24 hours back from the run. */
const DAY_MS = 86_400_000;
/** Units one rule raises a signal for per run and compound. */
const BATCH = 200;

const PAGE = keysetCursor('detectedAt');

/** A rule met for a unit, before its signal is written. */
export interface Candidate {
  unitId: string;
  code: SignalCode;
  basisId: string;
  count: number;
  days: number;
}

export interface SignalRead {
  row: ExperienceSignal;
  unit: UnitLabel | null;
}

/**
 * Rule-based dissatisfaction signals (ADR 0082), no AI: for each rule the
 * compound has on, the units with at least `count` of its events within
 * `days` (ratings of 1 or 2; tickets rejected or reopened; complaints the
 * unit made). A unit's signal is written once per its newest event (the
 * key: two runs at once write it once), joins the unit's open case or
 * opens a follow-up, and is audited as the system's. A unit that met a rule
 * once does not signal again until a new event comes.
 */
@Injectable()
export class ExperienceSignalsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly audit: AuditService,
    private readonly sweep: SweepRunner,
    private readonly settings: ExperienceSettingsService,
    private readonly sources: ExperienceSources,
    private readonly cases: ExperienceCasesService,
  ) {}

  onModuleInit(): void {
    this.sweep.register(SIGNALS_SWEEP, (now) => this.run(now), {
      intervalMs: SIGNALS_EVERY_MS,
    });
  }

  list(q: {
    unitId?: string;
    code?: SignalCode;
    cursor?: string;
    limit?: number;
  }): Promise<Page<SignalRead>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.experienceSignal.findMany({
        where: {
          AND: [
            q.unitId ? { unitId: q.unitId } : {},
            q.code ? { code: q.code } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const units = await this.sources.units(
        tx,
        page.items.map((r) => r.unitId),
      );
      return {
        nextCursor: page.nextCursor,
        items: page.items.map((row) => ({
          row,
          unit: units.get(row.unitId) ?? null,
        })),
      };
    });
  }

  /**
   * One run: per compound, the candidates are read in one transaction;
   * each is written in a transaction of its own, so a unit's case lock is
   * held for that unit alone.
   */
  run(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      (tx) => this.candidates(tx, now),
      (tx, _tenantId, c) => this.raise(tx, c, now),
    );
  }

  /** The units that meet a rule now, without a signal for their newest event. */
  async candidates(tx: TenantTxClient, now: Date): Promise<Candidate[]> {
    const out: Candidate[] = [];
    for (const rule of await this.settings.inTx(tx)) {
      if (rule.count === null) continue;
      const since = new Date(now.getTime() - rule.days * DAY_MS);
      const events = await this.sources.eventsOf(tx, rule.code, since, now);
      const met = meeting(events, rule.count);
      if (!met.length) continue;
      const seen = await tx.experienceSignal.findMany({
        where: {
          code: rule.code,
          basisId: { in: met.map((m) => m.basisId) },
        },
        select: { unitId: true, basisId: true },
      });
      const done = new Set(seen.map((s) => `${s.unitId}:${s.basisId}`));
      out.push(
        ...met
          .filter((m) => !done.has(`${m.unitId}:${m.basisId}`))
          .slice(0, BATCH)
          .map((m) => ({ ...m, code: rule.code, days: rule.days })),
      );
    }
    return out;
  }

  /**
   * Writes the signal once (its key), then joins the unit's open case or
   * opens a follow-up for it, as the system. 1 when written, 0 when another
   * run wrote it first.
   */
  async raise(tx: TenantTxClient, c: Candidate, now: Date): Promise<number> {
    const id = newId();
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO experience_signals
        (id, tenant_id, unit_id, code, basis_id, count, window_days, detected_at)
      VALUES
        (${id}::uuid, current_setting('app.tenant_id')::uuid, ${c.unitId}::uuid,
         ${c.code}, ${c.basisId}::uuid, ${c.count}, ${c.days}, ${now})
      ON CONFLICT (tenant_id, unit_id, code, basis_id) DO NOTHING
      RETURNING id`;
    if (!inserted.length) return 0;
    const { row } = await this.cases.openFor(
      tx,
      { unitId: c.unitId, kind: 'follow_up', openedById: null },
      { id, code: c.code },
    );
    await tx.experienceSignal.update({
      where: { id },
      data: { caseId: row.id },
    });
    await this.audit.record(tx, {
      action: 'experience_signal.raised',
      targetId: id,
      metadata: {
        unitId: c.unitId,
        code: c.code,
        count: c.count,
        windowDays: c.days,
        caseId: row.id,
      },
    });
    return 1;
  }
}

/**
 * The units with at least `count` events, each with how many and its
 * newest event (by time, then id): the signal's basis.
 */
export function meeting(
  events: readonly ExperienceEvent[],
  count: number,
): { unitId: string; basisId: string; count: number }[] {
  const byUnit = new Map<string, ExperienceEvent[]>();
  for (const e of events) {
    const list = byUnit.get(e.unitId) ?? [];
    list.push(e);
    byUnit.set(e.unitId, list);
  }
  const out: { unitId: string; basisId: string; count: number }[] = [];
  for (const [unitId, list] of byUnit) {
    if (list.length < count) continue;
    const newest = list.reduce((a, b) =>
      b.at > a.at || (b.at.getTime() === a.at.getTime() && b.itemId > a.itemId)
        ? b
        : a,
    );
    out.push({ unitId, basisId: newest.itemId, count: list.length });
  }
  return out.sort((a, b) => (a.unitId < b.unitId ? -1 : 1));
}

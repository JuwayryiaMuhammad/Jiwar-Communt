import { Injectable } from '@nestjs/common';
import type { AssetReading } from '@prisma/client';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

export interface NewReading {
  tenantId: string;
  assetId: string;
  metricKey: string;
  value: string;
  unit: string | null;
  source: 'run' | 'manual';
  runId: string | null;
  recordedById: string | null;
  occurredAt: Date;
  recordedAt: Date;
}

/** Who wants to hear of new readings (usage-based plans, ADR 0064). */
export type ReadingHook = (
  tx: TenantTxClient,
  readings: AssetReading[],
) => Promise<void>;

/**
 * An asset's readings (ADR 0064): append-only, from a submitted run or
 * entered by a technician. Whoever reacts to a reading (a plan due by
 * usage) is told in the same transaction, after the rows are written.
 */
@Injectable()
export class AssetReadings {
  private readonly hooks: ReadingHook[] = [];

  onRecorded(hook: ReadingHook): void {
    this.hooks.push(hook);
  }

  async record(
    tx: TenantTxClient,
    readings: readonly NewReading[],
  ): Promise<AssetReading[]> {
    if (!readings.length) return [];
    const rows = readings.map((r) => ({ id: newId(), ...r }));
    await tx.assetReading.createMany({ data: rows });
    const written = await tx.assetReading.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      orderBy: { occurredAt: 'asc' },
    });
    for (const hook of this.hooks) await hook(tx, written);
    return written;
  }

  /** The latest reading of each metric of an asset, and the one before it. */
  async latest(
    tx: TenantTxClient,
    assetId: string,
  ): Promise<
    { metricKey: string; last: AssetReading; previous: AssetReading | null }[]
  > {
    const rows = await tx.$queryRaw<{ id: string; rank: bigint }[]>`
      SELECT id, rank FROM (
        SELECT id, row_number() OVER (
                 PARTITION BY metric_key ORDER BY occurred_at DESC, id DESC) AS rank
          FROM asset_readings WHERE asset_id = ${assetId}::uuid) r
       WHERE rank <= 2`;
    const readings = await tx.assetReading.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      orderBy: [{ metricKey: 'asc' }, { occurredAt: 'desc' }, { id: 'desc' }],
    });
    const out: {
      metricKey: string;
      last: AssetReading;
      previous: AssetReading | null;
    }[] = [];
    for (const r of readings) {
      const seen = out.find((o) => o.metricKey === r.metricKey);
      if (!seen) out.push({ metricKey: r.metricKey, last: r, previous: null });
      else if (!seen.previous) seen.previous = r;
    }
    return out;
  }
}

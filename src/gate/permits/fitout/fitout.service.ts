import { Injectable } from '@nestjs/common';
import type { PermitDebrisSlot, UnitPermit } from '@prisma/client';
import {
  TenantTx,
  type TenantTxClient,
} from '../../../core/database/tenant-tx.service';
import type { PresignedRead } from '../../../core/files/object-storage';
import { FilesService } from '../../../core/files/files.service';
import { WorksDeposits } from '../../../core/works/works-deposits';
import { dbNow } from '../../db-clock';
import { permitReference } from '../permit-core';
import { viewStatus, type PermitViewStatus } from '../permit-records';
import { timeOf } from '../permit-rules';
import { PermitSettingsService } from '../permit-settings.service';
import { AreaRecordsService } from './area-records.service';
import { DebrisSlotsService } from './debris-slots.service';
import { FitOutAccess, type FitOutSide } from './fitout-access';
import { PermitDrawingsService } from './permit-drawings.service';

/** A works permit's fit-out (ADR 0074), as its views show it. */
export interface FitOutRead {
  permitId: string;
  reference: string;
  status: PermitViewStatus;
  /** The compound approves works only once their deposit holds money. */
  depositRequired: boolean;
  /** The finishing-works deposit named on the permit, or null. */
  deposit: { number: string; amount: string; held: string } | null;
  drawings: {
    id: string;
    addedAt: Date;
    file: PresignedRead | null;
  }[];
  debrisSlots: DebrisSlotRead[];
  /** Each common area recorded, before the works and after them. */
  areas: {
    commonArea: { id: string; code: string; nameEn: string; nameAr: string };
    before: AreaStageRead | null;
    after: AreaStageRead | null;
  }[];
}

/** One stage of an area: the management's photos and note. */
export interface AreaStageRead {
  id: string;
  recordedAt: Date;
  note: string | null;
  photos: (PresignedRead | null)[];
}

/** A debris removal, as the views show it: sides and codes, never a person. */
export interface DebrisSlotRead {
  id: string;
  day: string;
  window: { from: string; to: string };
  startsAt: Date;
  endsAt: Date;
  status: string;
  scheduledSide: string;
  doneAt: Date | null;
  doneSide: string | null;
  missedAt: Date | null;
  cancelledAt: Date | null;
  cancelSide: string | null;
  cancelReason: string | null;
}

export function debrisSlotRead(d: PermitDebrisSlot): DebrisSlotRead {
  return {
    id: d.id,
    day: d.day.toISOString().slice(0, 10),
    window: { from: timeOf(d.fromMinute), to: timeOf(d.toMinute) },
    startsAt: d.startsAt,
    endsAt: d.endsAt,
    status: d.status,
    scheduledSide: d.scheduledSide,
    doneAt: d.doneAt,
    doneSide: d.doneSide,
    missedAt: d.missedAt,
    cancelledAt: d.cancelledAt,
    cancelSide: d.cancelSide,
    cancelReason: d.cancelReason,
  };
}

/**
 * What a works permit's fit-out holds (ADR 0074), for its household and
 * for the management, read in one transaction: the deposit named on it
 * (through core's WorksDeposits port: the gate never reads finance), the
 * drawings with a read of each, the debris removals, and the common areas
 * before and after the works.
 */
@Injectable()
export class FitOutService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly access: FitOutAccess,
    private readonly files: FilesService,
    private readonly deposits: WorksDeposits,
    private readonly settings: PermitSettingsService,
    private readonly drawings: PermitDrawingsService,
    private readonly debris: DebrisSlotsService,
    private readonly areas: AreaRecordsService,
  ) {}

  get(permitId: string, side: FitOutSide): Promise<FitOutRead> {
    return this.tenantTx.withTenantTx(async (tx) =>
      this.load(tx, await this.access.read(tx, permitId, side)),
    );
  }

  /** The fit-out of a permit already read in `tx`. */
  async load(tx: TenantTxClient, p: UnitPermit): Promise<FitOutRead> {
    const now = await dbNow(tx);
    const deposit = await this.deposits.ofPermit(tx, p.id);
    const drawings: FitOutRead['drawings'] = [];
    for (const d of await this.drawings.of(tx, p.id))
      drawings.push({
        id: d.id,
        addedAt: d.addedAt,
        file: await this.files.readUrl(tx, d.fileId),
      });
    return {
      permitId: p.id,
      reference: permitReference(p.kind, p.number),
      status: viewStatus(p, now),
      depositRequired: await this.settings.worksDepositRequired(tx, p.tenantId),
      deposit: deposit
        ? {
            number: deposit.number,
            amount: deposit.amount.toFixed(2),
            held: deposit.held.toFixed(2),
          }
        : null,
      drawings,
      debrisSlots: (await this.debris.of(tx, p.id)).map(debrisSlotRead),
      areas: await this.areaReads(tx, p.id),
    };
  }

  private async areaReads(
    tx: TenantTxClient,
    permitId: string,
  ): Promise<FitOutRead['areas']> {
    const records = await this.areas.of(tx, permitId);
    if (!records.length) return [];
    const ids = [...new Set(records.map((r) => r.record.commonAreaId))];
    const areas = await tx.commonArea.findMany({
      where: { id: { in: ids } },
      select: { id: true, code: true, nameEn: true, nameAr: true },
    });
    const out: FitOutRead['areas'] = [];
    for (const id of ids) {
      const stage = async (
        phase: 'before' | 'after',
      ): Promise<AreaStageRead | null> => {
        const r = records.find(
          (x) => x.record.commonAreaId === id && x.record.phase === phase,
        );
        if (!r) return null;
        const photos: (PresignedRead | null)[] = [];
        for (const ph of r.photos)
          photos.push(await this.files.readUrl(tx, ph.fileId));
        return {
          id: r.record.id,
          recordedAt: r.record.recordedAt,
          note: r.record.note,
          photos,
        };
      };
      out.push({
        commonArea: areas.find((a) => a.id === id)!,
        before: await stage('before'),
        after: await stage('after'),
      });
    }
    return out;
  }
}

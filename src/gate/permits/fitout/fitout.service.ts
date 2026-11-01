import { Injectable } from '@nestjs/common';
import type { UnitPermit } from '@prisma/client';
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
import { PermitSettingsService } from '../permit-settings.service';
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
}

/**
 * What a works permit's fit-out holds (ADR 0074), for its household and
 * for the management, read in one transaction: the deposit named on it
 * (through core's WorksDeposits port: the gate never reads finance), and
 * the drawings with a read of each.
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
    };
  }
}

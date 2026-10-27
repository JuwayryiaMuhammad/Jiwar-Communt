import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../core/common/cls/request-context';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';
import { compoundDay, type LocalDate } from './local-dates';

export interface CompoundNow {
  /** The database's clock. */
  now: Date;
  /** The compound's day at `now`, in its time zone. */
  today: LocalDate;
  timeZone: string;
}

/**
 * The compound's calendar, read in the caller's transaction (ADR 0064):
 * the database's clock and the compound's own time zone, so a due date, a
 * warranty's end and an age are the compound's days whatever the server.
 */
@Injectable()
export class CompoundCalendar {
  constructor(
    private readonly ctx: RequestContext,
    private readonly settings: TenantSettingsService,
  ) {}

  async now(
    tx: TenantTxClient,
    tenantId = this.ctx.tenantId,
  ): Promise<CompoundNow> {
    const { timezone } = await this.settings.inTx(tx, tenantId);
    const now = await dbNow(tx);
    return { now, today: compoundDay(now, timezone), timeZone: timezone };
  }
}

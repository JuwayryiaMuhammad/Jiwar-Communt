import { Injectable } from '@nestjs/common';
import { CommunityFinancePort } from '../../community';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, type FieldError } from '../../core/common/errors';
import type { LocalDate } from '../../core/common/slots/day-slots';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { localToday } from '../db-clock';
import type { StaffRefView } from './views/treasury.views';

export const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

/** What every treasury service needs: the compound's day and staff names. */
@Injectable()
export class TreasuryCommon {
  constructor(
    private readonly ctx: RequestContext,
    private readonly settings: TenantSettingsService,
    private readonly community: CommunityFinancePort,
  ) {}

  async today(
    tx: TenantTxClient,
    tenantId = this.ctx.txTenantId,
  ): Promise<LocalDate> {
    const { timezone } = await this.settings.inTx(tx, tenantId);
    return localToday(tx, timezone);
  }

  /** Each id's StaffRefView, erased accounts without a name. */
  async refs(
    tx: TenantTxClient,
    ids: readonly (string | null)[],
  ): Promise<(id: string) => StaffRefView> {
    const names = await this.community.staffNames(
      tx,
      ids.filter((i): i is string => i !== null),
    );
    return (id) => ({ id, fullName: names.get(id) ?? null });
  }

  /** Whether the account is a staff or manager account of the compound. */
  async isStaff(tx: TenantTxClient, id: string): Promise<boolean> {
    return (await this.community.staffNames(tx, [id])).has(id);
  }
}

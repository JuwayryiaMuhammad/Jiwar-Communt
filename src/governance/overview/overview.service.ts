import { Injectable } from '@nestjs/common';
import { BoardMatters } from '../../core/board-matters/board-matters';
import { RequestContext } from '../../core/common/cls/request-context';
import { FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { addDays, localDate } from '../../core/common/slots/day-slots';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';

/** The longest period the overview covers, in days (the incidents report's). */
export const OVERVIEW_MAX_DAYS = 31;
const DEFAULT_DAYS = 30;

export interface BoardOverview {
  from: string;
  to: string;
  sections: Record<string, Record<string, unknown>>;
}

/**
 * The board's overview (ADR 0055): read-only, for a sitting member, put
 * together from what the domains registered with core's BoardMatters,
 * each from its existing reports (finance's money, security's incidents
 * and violations), totals only. Governance computes no number of its own.
 */
@Injectable()
export class BoardOverviewService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly matters: BoardMatters,
    private readonly settings: TenantSettingsService,
  ) {}

  async overview(q: { from?: string; to?: string }): Promise<BoardOverview> {
    const today = await this.tenantTx.withTenantTx(async (tx) => {
      const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
      return localDate(await dbNow(tx), timezone);
    });
    const to = q.to ?? today;
    const from = q.from ?? addDays(to, -(DEFAULT_DAYS - 1));
    if (to < from)
      throw invalid([{ field: 'to', code: FieldErrorCode.ENDS_BEFORE_START }]);
    if (to > addDays(from, OVERVIEW_MAX_DAYS - 1))
      throw invalid([
        {
          field: 'to',
          code: FieldErrorCode.PERIOD_TOO_LONG,
          params: { maxDays: OVERVIEW_MAX_DAYS },
        },
      ]);
    const sections: BoardOverview['sections'] = {};
    for (const [name, section] of this.matters.overview())
      sections[name] = await section({ from, to });
    return { from, to, sections };
  }
}

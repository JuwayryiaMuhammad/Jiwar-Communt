import { Injectable, type OnModuleInit } from '@nestjs/common';
import { BoardMatters } from '../../core/board-matters/board-matters';
import { SecurityReportsService } from './security-reports.service';

/**
 * Security's part of the board's overview (ADR 0055): the incidents and
 * violations reports' totals over the period (ADR 0053), counts and
 * amounts only, never a name, a unit or a word.
 */
@Injectable()
export class SecurityOverview implements OnModuleInit {
  constructor(
    private readonly matters: BoardMatters,
    private readonly reports: SecurityReportsService,
  ) {}

  onModuleInit(): void {
    this.matters.registerOverview('security', async (period) => {
      const incidents = await this.reports.incidents(period);
      const violations = await this.reports.violations(period);
      return {
        incidents: incidents.totals,
        violations: violations.totals,
        currency: violations.currency,
      };
    });
  }
}

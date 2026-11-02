import { Injectable, type OnModuleInit } from '@nestjs/common';
import { BoardMatters } from '../../core/board-matters/board-matters';
import { ComplianceService } from './compliance.service';

/**
 * Compliance's part of the board's overview (ADR 0055's registry, ADR
 * 0087): where the compound's obligations stand today — valid, due soon,
 * overdue, done once — and its vendors' papers, from the status report.
 * Counts only, as of today: an obligation's state is not a period's.
 */
@Injectable()
export class ComplianceOverview implements OnModuleInit {
  constructor(
    private readonly matters: BoardMatters,
    private readonly compliance: ComplianceService,
  ) {}

  onModuleInit(): void {
    this.matters.registerOverview('compliance', async () => {
      const r = await this.compliance.report();
      return {
        asOf: r.asOf,
        totals: r.totals,
        vendorPapers: r.vendorPapers,
      };
    });
  }
}

import { Controller, Get, Query, StreamableFile } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces } from '@nestjs/swagger';
import { RequireAnyPermission } from '../../core/access/require-permissions.decorator';
import { csvFile } from '../../core/common/csv';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { UsageQueryDto } from './dto/usage.dto';
import { FacilityUsageService } from './usage.service';
import { FacilityUsageReportView } from './views/usage.views';

const CSV =
  'One row per bookable facility: its bookings by status, open and booked minutes, use, no-shows and peak share.';

/** How the facilities are used (ADR 0067). */
@ApiArea('bookings')
@RequireAnyPermission('facilities.manage', 'bookings.handle')
@Controller('staff/facility-usage')
export class FacilityUsageController {
  constructor(private readonly usage: FacilityUsageService) {}

  @Get()
  @ApiOperation({
    summary:
      'Each bookable facility’s bookings, slot use, no-shows and peak share over a period',
  })
  @ApiOkResponse({ type: FacilityUsageReportView })
  async report(@Query() q: UsageQueryDto): Promise<FacilityUsageReportView> {
    return FacilityUsageReportView.from(await this.usage.report(q));
  }

  @Get('export')
  @NoStore()
  @ApiProduces('text/csv')
  @ApiOperation({ summary: 'The same as CSV', description: CSV })
  @ApiOkResponse({ schema: { type: 'string' } })
  async export(@Query() q: UsageQueryDto): Promise<StreamableFile> {
    return csvFile(
      `facility-usage-${q.from ?? 'from'}-${q.to ?? 'today'}.csv`,
      await this.usage.csv(q),
    );
  }
}

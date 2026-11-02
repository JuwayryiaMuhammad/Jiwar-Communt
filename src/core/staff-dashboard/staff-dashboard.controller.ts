import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../access/require-permissions.decorator';
import { ApiArea } from '../common/http/decorators';
import { ListOf, toList, type ListResponse } from '../common/http/list';
import { parseId } from '../common/validation/parse-id.pipe';
import {
  BriefsQueryDto,
  UpdateDashboardSettingsDto,
} from './dto/staff-dashboard.dto';
import { StaffBriefsService } from './staff-briefs.service';
import { StaffDashboardService } from './staff-dashboard.service';
import {
  BriefListItemView,
  BriefView,
  BuildingsStatusView,
  DashboardSettingsView,
  DashboardSummaryView,
  NeedsYouView,
} from './staff-dashboard.views';

/**
 * The operations dashboard (ADR 0079), `dashboard.read`: each section shows
 * to the holders of its own domain's permission, null otherwise. Counts,
 * shares and amounts of the compound only.
 */
@ApiArea('staff')
@RequirePermissions('dashboard.read')
@Controller('staff/dashboard')
export class StaffDashboardController {
  constructor(private readonly dashboard: StaffDashboardService) {}

  @Get()
  @ApiOperation({
    summary: 'Read the dashboard’s cards',
    description:
      'Every section the caller reads, as of now, on the compound’s day: tickets, the SLA and service pressure, outages, security, the gate, collections and what is owed, the units; the inbox’s badge. One call; each section a fixed number of aggregate queries.',
  })
  @ApiOkResponse({ type: DashboardSummaryView })
  async summary(): Promise<DashboardSummaryView> {
    return DashboardSummaryView.from(await this.dashboard.summary());
  }

  @Get('needs-you')
  @ApiOperation({
    summary: 'Read what needs me now',
    description:
      'The alerts of the sections the caller reads, the critical first, then the inbox’s overdue items and its oldest (ADR 0073), 10 at most. Each opens on its own page.',
  })
  @ApiOkResponse({ type: NeedsYouView })
  async needsYou(): Promise<NeedsYouView> {
    return NeedsYouView.from(await this.dashboard.needsYou());
  }

  @Get('buildings')
  @ApiOperation({
    summary: 'Read every building’s status',
    description:
      'Each building of the register (ADR 0072) with its units, tickets and outages as the caller may read them, and a band: critical, attention or ok.',
  })
  @ApiOkResponse({ type: BuildingsStatusView })
  async buildings(): Promise<BuildingsStatusView> {
    return BuildingsStatusView.from(await this.dashboard.buildings());
  }

  @Get('settings')
  @ApiOperation({ summary: 'Read when the brief and the review are written' })
  @ApiOkResponse({ type: DashboardSettingsView })
  async settings(): Promise<DashboardSettingsView> {
    return DashboardSettingsView.from(await this.dashboard.settings());
  }

  @Patch('settings')
  @RequirePermissions('settings.manage')
  @ApiOperation({
    summary: 'Change when the brief and the review are written',
    description:
      'In the compound’s time zone; null turns one off. A change applies from the next day for a kind already written today.',
  })
  @ApiOkResponse({ type: DashboardSettingsView })
  async updateSettings(
    @Body() dto: UpdateDashboardSettingsDto,
  ): Promise<DashboardSettingsView> {
    return DashboardSettingsView.from(
      await this.dashboard.updateSettings({
        briefAt: dto.briefAt,
        reviewAt: dto.reviewAt,
      }),
    );
  }
}

/** The briefs and reviews written (ADR 0079), newest first. */
@ApiArea('staff')
@RequirePermissions('dashboard.read')
@Controller('staff/briefs')
export class StaffBriefsController {
  constructor(private readonly briefs: StaffBriefsService) {}

  @Get()
  @ApiOperation({ summary: 'List the daily briefs and end-of-day reviews' })
  @ApiOkResponse({ type: ListOf(BriefListItemView) })
  async list(
    @Query() q: BriefsQueryDto,
  ): Promise<ListResponse<BriefListItemView>> {
    return toList(
      await this.briefs.list({
        kind: q.kind,
        cursor: q.cursor,
        limit: q.limit,
      }),
      (b) => BriefListItemView.from(b),
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Read a brief or a review',
    description:
      'As written; the sections and inbox types the caller may read, the rest null.',
  })
  @ApiOkResponse({ type: BriefView })
  async get(@Param('id', parseId()) id: string): Promise<BriefView> {
    return BriefView.fromRead(await this.briefs.get(id));
  }
}

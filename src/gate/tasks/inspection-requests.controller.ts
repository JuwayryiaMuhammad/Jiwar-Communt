import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ReasonCodeOnlyDto } from '../../core/common/http/reason.dto';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  InspectionRequestsQueryDto,
  NewInspectionRequestDto,
} from './dto/inspection-requests.dto';
import { InspectionRequestsService } from './inspection-requests.service';
import {
  UnitInspectionReportView,
  InspectionRequestView,
  StaffInspectionRequestView,
} from './views/inspection.views';

/** A closed unit's inspections, its owners' and its proxy's (ADR 0063). */
@ApiArea('units')
@RequirePermissions('units.read')
@Controller('units/:unitId')
export class InspectionRequestsController {
  constructor(private readonly inspections: InspectionRequestsService) {}

  @Post('inspection-requests')
  @ApiOperation({ summary: 'Ask for an inspection of the closed unit' })
  @ApiCreatedResponse({ type: InspectionRequestView })
  async ask(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: NewInspectionRequestDto,
  ): Promise<InspectionRequestView> {
    return InspectionRequestView.from(await this.inspections.ask(unitId, dto));
  }

  @Get('inspection-requests')
  @ApiOperation({ summary: 'The unit’s inspection requests' })
  @ApiOkResponse({ type: [InspectionRequestView] })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<InspectionRequestView[]> {
    return (await this.inspections.list(unitId)).map((r) =>
      InspectionRequestView.from(r),
    );
  }

  @Post('inspection-requests/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an open inspection request' })
  @ApiOkResponse({ type: InspectionRequestView })
  async cancel(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<InspectionRequestView> {
    return InspectionRequestView.from(
      await this.inspections.cancelMine(unitId, id, dto.reasonCode),
    );
  }

  /** The photos are presigned: never cached. */
  @Get('inspections')
  @NoStore()
  @ApiOperation({ summary: 'The closed unit’s inspections, done' })
  @ApiOkResponse({ type: [UnitInspectionReportView] })
  async reports(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<UnitInspectionReportView[]> {
    return (await this.inspections.reports(unitId)).map((r) =>
      UnitInspectionReportView.from(r),
    );
  }
}

/** The requests to schedule (ADR 0063): a task with `requestId` answers one. */
@ApiArea('guard-duty')
@RequirePermissions('guard_tasks.manage')
@Controller('staff/security/inspection-requests')
export class StaffInspectionRequestsController {
  constructor(private readonly inspections: InspectionRequestsService) {}

  @Get()
  @ApiOperation({ summary: 'Inspection requests, open by default' })
  @ApiOkResponse({ type: [StaffInspectionRequestView] })
  async list(
    @Query() q: InspectionRequestsQueryDto,
  ): Promise<StaffInspectionRequestView[]> {
    return (await this.inspections.staffList(q.status)).map((r) =>
      StaffInspectionRequestView.fromStaff(r),
    );
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an open inspection request' })
  @ApiOkResponse({ type: InspectionRequestView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<InspectionRequestView> {
    return InspectionRequestView.from(
      await this.inspections.cancelStaff(id, dto.reasonCode),
    );
  }
}

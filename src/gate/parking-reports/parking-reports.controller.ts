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
import { PermissionsService } from '../../core/access/permissions.service';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { IssueFineDto } from '../fines/dto/fines.dto';
import {
  CloseParkingReportDto,
  CreateParkingReportDto,
  StaffParkingReportsQueryDto,
} from './dto/parking-reports.dto';
import { ParkingReportsService } from './parking-reports.service';
import {
  MyParkingReportView,
  StaffParkingReportView,
} from './views/parking-report.views';

/** A resident's parking reports (ADR 0045). */
@ApiArea('parking-reports')
@RequirePermissions('parking.report')
@Controller('parking-reports')
export class MyParkingReportsController {
  constructor(private readonly reports: ParkingReportsService) {}

  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Report a wrongly parked vehicle to security',
    description:
      'About a plate, never a unit: the answer says nothing of whom it matches. At most 10 open per resident (PARKING_REPORT_LIMIT_REACHED).',
  })
  @ApiCreatedResponse({ type: MyParkingReportView })
  async create(
    @Body() dto: CreateParkingReportDto,
  ): Promise<MyParkingReportView> {
    return MyParkingReportView.from(await this.reports.create(dto));
  }

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List my parking reports',
    description: 'Open or closed, never the outcome.',
  })
  @ApiOkResponse({ type: ListOf(MyParkingReportView) })
  async mine(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<MyParkingReportView>> {
    return toList(await this.reports.mine(q), (r) =>
      MyParkingReportView.from(r),
    );
  }
}

/** The parking reports queue, for security (ADR 0045). */
@ApiArea('parking-reports')
@RequirePermissions('parking_reports.handle')
@Controller('staff/parking-reports')
export class StaffParkingReportsController {
  constructor(
    private readonly reports: ParkingReportsService,
    private readonly permissions: PermissionsService,
  ) {}

  /** A guard sees the reporter by first name (ADR 0050). */
  private async asGuard(): Promise<boolean> {
    return this.permissions.has('gate.operate');
  }

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the parking reports',
    description: '`status=open` is the queue, oldest first.',
  })
  @ApiOkResponse({ type: ListOf(StaffParkingReportView) })
  async list(
    @Query() q: StaffParkingReportsQueryDto,
  ): Promise<ListResponse<StaffParkingReportView>> {
    const asGuard = await this.asGuard();
    return toList(await this.reports.list(q), (r) =>
      StaffParkingReportView.from(r, asGuard),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({
    summary: 'Get a parking report with its reporter and the plate’s matches',
  })
  @ApiOkResponse({ type: StaffParkingReportView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<StaffParkingReportView> {
    return StaffParkingReportView.from(
      await this.reports.get(id),
      await this.asGuard(),
    );
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({ summary: 'Close an open report, with a reason code' })
  @ApiOkResponse({ type: StaffParkingReportView })
  async close(
    @Param('id', parseId()) id: string,
    @Body() dto: CloseParkingReportDto,
  ): Promise<StaffParkingReportView> {
    return StaffParkingReportView.from(
      await this.reports.close(id, dto.reasonCode),
      await this.asGuard(),
    );
  }

  @Post(':id/convert')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @RequirePermissions('parking_reports.handle', 'fines.issue')
  @ApiOperation({
    summary: 'Turn an open report into a fine',
    description:
      'Issued as any fine (the body is the fine’s): nothing of the report goes on it, not the reporter and not its photo.',
  })
  @ApiOkResponse({ type: StaffParkingReportView })
  async convert(
    @Param('id', parseId()) id: string,
    @Body() dto: IssueFineDto,
  ): Promise<StaffParkingReportView> {
    return StaffParkingReportView.from(
      await this.reports.convert(id, dto),
      await this.asGuard(),
    );
  }
}

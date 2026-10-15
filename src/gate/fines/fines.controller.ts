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
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  AppealFineDto,
  CancelFineDto,
  DecideAppealDto,
  IssueFineDto,
  StaffFinesQueryDto,
  UnitFinesQueryDto,
} from './dto/fines.dto';
import { FinesService } from './fines.service';
import { ResidentFineView, StaffFineView } from './views/fine.views';

/** A unit's fines, for its people (ADR 0045). */
@ApiArea('fines')
@Controller()
export class UnitFinesController {
  constructor(private readonly fines: FinesService) {}

  @Get('units/:unitId/vehicle-fines')
  @NoStore()
  @RequirePermissions('units.read')
  @ApiOperation({
    summary: 'List the unit’s fines',
    description:
      'For its vehicle keepers and whoever sees its money (FINES_NOT_ALLOWED). Newest first.',
  })
  @ApiOkResponse({ type: ListOf(ResidentFineView) })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Query() q: UnitFinesQueryDto,
  ): Promise<ListResponse<ResidentFineView>> {
    return toList(await this.fines.forUnit(unitId, q), (f) =>
      ResidentFineView.from(f),
    );
  }

  @Get('vehicle-fines/:id')
  @NoStore()
  @RequirePermissions('units.read')
  @ApiOperation({ summary: 'Get one of the unit’s fines' })
  @ApiOkResponse({ type: ResidentFineView })
  async get(@Param('id', parseId()) id: string): Promise<ResidentFineView> {
    return ResidentFineView.from(await this.fines.residentFile(id));
  }

  @Post('vehicle-fines/:id/appeal')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @RequirePermissions('vehicles.register')
  @ApiOperation({
    summary: 'Appeal a fine, once',
    description:
      'A vehicle keeper of the unit or its primary (FINE_APPEAL_NOT_ALLOWED): unpaid, never appealed (FINE_APPEAL_CLOSED), within 30 days of being issued (FINE_APPEAL_WINDOW_PASSED).',
  })
  @ApiOkResponse({ type: ResidentFineView })
  async appeal(
    @Param('id', parseId()) id: string,
    @Body() dto: AppealFineDto,
  ): Promise<ResidentFineView> {
    return ResidentFineView.from(await this.fines.appeal(id, dto));
  }
}

/** Fines for the staff (ADR 0045). */
@ApiArea('fines')
@Controller('staff/vehicle-fines')
export class StaffFinesController {
  constructor(private readonly fines: FinesService) {}

  @Post()
  @NoStore()
  @Idempotent()
  @RequirePermissions('fines.issue')
  @ApiOperation({ summary: 'Issue a fine to a unit' })
  @ApiCreatedResponse({ type: StaffFineView })
  async issue(@Body() dto: IssueFineDto): Promise<StaffFineView> {
    return StaffFineView.from(await this.fines.issue(dto));
  }

  @Get()
  @NoStore()
  @RequireAnyPermission('fines.issue', 'fines.billing')
  @ApiOperation({
    summary: 'List the compound’s fines',
    description: '`status=under_appeal` is the appeals queue, oldest first.',
  })
  @ApiOkResponse({ type: ListOf(StaffFineView) })
  async list(
    @Query() q: StaffFinesQueryDto,
  ): Promise<ListResponse<StaffFineView>> {
    return toList(await this.fines.list(q), (f) => StaffFineView.from(f));
  }

  @Get(':id')
  @NoStore()
  @RequireAnyPermission('fines.issue', 'fines.billing')
  @ApiOperation({ summary: 'Get a fine with its appeal and payments' })
  @ApiOkResponse({ type: StaffFineView })
  async get(@Param('id', parseId()) id: string): Promise<StaffFineView> {
    return StaffFineView.from(await this.fines.staffFile(id));
  }

  @Post(':id/decide-appeal')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @RequirePermissions('fines.issue')
  @ApiOperation({ summary: 'Decide a fine’s appeal: upheld or cancelled' })
  @ApiOkResponse({ type: StaffFineView })
  async decide(
    @Param('id', parseId()) id: string,
    @Body() dto: DecideAppealDto,
  ): Promise<StaffFineView> {
    return StaffFineView.from(await this.fines.decide(id, dto));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @RequirePermissions('fines.issue')
  @ApiOperation({
    summary: 'Cancel an unpaid fine not under appeal, with a reason code',
  })
  @ApiOkResponse({ type: StaffFineView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: CancelFineDto,
  ): Promise<StaffFineView> {
    return StaffFineView.from(await this.fines.cancel(id, dto.reasonCode));
  }
}

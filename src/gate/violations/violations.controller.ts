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
  AppealViolationDto,
  CancelViolationDto,
  DecideViolationAppealDto,
  IssueViolationDto,
  StaffViolationsQueryDto,
  UnitViolationsQueryDto,
} from './dto/violations.dto';
import {
  GuardViolationView,
  ResidentViolationView,
  StaffViolationView,
} from './views/violation.views';
import { ViolationsService, type NewViolation } from './violations.service';

const toNew = (dto: IssueViolationDto): NewViolation => ({
  ...dto,
  occurredOn: dto.occurredOn,
});

/** A unit's violations, for its people (ADR 0053). */
@ApiArea('violations')
@Controller()
export class UnitViolationsController {
  constructor(private readonly violations: ViolationsService) {}

  @Get('units/:unitId/violations')
  @NoStore()
  @RequirePermissions('units.read')
  @ApiOperation({
    summary: 'List the unit’s violations',
    description:
      'For its keepers and whoever sees its money (VIOLATIONS_NOT_ALLOWED). Newest first.',
  })
  @ApiOkResponse({ type: ListOf(ResidentViolationView) })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Query() q: UnitViolationsQueryDto,
  ): Promise<ListResponse<ResidentViolationView>> {
    return toList(await this.violations.forUnit(unitId, q), (f) =>
      ResidentViolationView.from(f),
    );
  }

  @Get('violations/:id')
  @NoStore()
  @RequirePermissions('units.read')
  @ApiOperation({ summary: 'Get one of the unit’s violations' })
  @ApiOkResponse({ type: ResidentViolationView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<ResidentViolationView> {
    return ResidentViolationView.from(await this.violations.residentFile(id));
  }

  @Post('violations/:id/appeal')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @RequirePermissions('units.read')
  @ApiOperation({
    summary: 'Appeal a violation, once',
    description:
      'A keeper of the unit or its primary (VIOLATION_APPEAL_NOT_ALLOWED): open, never appealed (VIOLATION_APPEAL_CLOSED), within 30 days of its issue (VIOLATION_APPEAL_WINDOW_PASSED).',
  })
  @ApiOkResponse({ type: ResidentViolationView })
  async appeal(
    @Param('id', parseId()) id: string,
    @Body() dto: AppealViolationDto,
  ): Promise<ResidentViolationView> {
    return ResidentViolationView.from(await this.violations.appeal(id, dto));
  }
}

/** Violations for the office (ADR 0053). */
@ApiArea('violations')
@Controller('staff/violations')
export class StaffViolationsController {
  constructor(private readonly violations: ViolationsService) {}

  @Post()
  @NoStore()
  @Idempotent()
  @RequirePermissions('violations.issue')
  @ApiOperation({
    summary: 'Issue a violation to a unit',
    description:
      'A kind, the unit (or a works permit for contractor hours), where, the day, a note and a photo, and an amount, or none: a warning. The unit’s keepers and its primary are told.',
  })
  @ApiCreatedResponse({ type: StaffViolationView })
  async issue(@Body() dto: IssueViolationDto): Promise<StaffViolationView> {
    return StaffViolationView.from(
      await this.violations.issue(toNew(dto), 'staff'),
    );
  }

  @Get()
  @NoStore()
  @RequireAnyPermission(
    'violations.manage',
    'violations.issue',
    'fines.billing',
  )
  @ApiOperation({
    summary: 'List the violations',
    description: '`status=under_appeal` is the appeals queue, oldest first.',
  })
  @ApiOkResponse({ type: ListOf(StaffViolationView) })
  async list(
    @Query() q: StaffViolationsQueryDto,
  ): Promise<ListResponse<StaffViolationView>> {
    return toList(await this.violations.list(q), (f) =>
      StaffViolationView.from(f),
    );
  }

  @Get(':id')
  @NoStore()
  @RequireAnyPermission(
    'violations.manage',
    'violations.issue',
    'fines.billing',
  )
  @ApiOperation({ summary: 'Get a violation' })
  @ApiOkResponse({ type: StaffViolationView })
  async get(@Param('id', parseId()) id: string): Promise<StaffViolationView> {
    return StaffViolationView.from(await this.violations.staffFile(id));
  }

  @Post(':id/decide-appeal')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @RequirePermissions('violations.manage')
  @ApiOperation({
    summary: 'Decide a violation’s appeal',
    description:
      '`upheld`: open again; `cancelled`: cancelled with a reason code. The appellant is told. Not under appeal: VIOLATION_NOT_UNDER_APPEAL.',
  })
  @ApiOkResponse({ type: StaffViolationView })
  async decide(
    @Param('id', parseId()) id: string,
    @Body() dto: DecideViolationAppealDto,
  ): Promise<StaffViolationView> {
    return StaffViolationView.from(await this.violations.decide(id, dto));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @RequirePermissions('violations.manage')
  @ApiOperation({
    summary: 'Cancel a violation',
    description:
      'An open one, not under appeal (VIOLATION_NOT_CANCELLABLE), with a reason code. Final.',
  })
  @ApiOkResponse({ type: StaffViolationView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: CancelViolationDto,
  ): Promise<StaffViolationView> {
    return StaffViolationView.from(
      await this.violations.cancel(id, dto.reasonCode),
    );
  }
}

/** A guard issues a violation inside a shift (ADR 0053). */
@ApiArea('violations')
@RequirePermissions('gate.operate')
@Controller('gate/violations')
export class GateViolationsController {
  constructor(private readonly violations: ViolationsService) {}

  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Issue a violation to a unit',
    description:
      'Inside a shift, at a gate or in a zone; as the office issues one. The unit’s keepers and its primary are told.',
  })
  @ApiCreatedResponse({ type: GuardViolationView })
  async issue(@Body() dto: IssueViolationDto): Promise<GuardViolationView> {
    return GuardViolationView.from(
      await this.violations.issue(toNew(dto), 'guard'),
    );
  }
}

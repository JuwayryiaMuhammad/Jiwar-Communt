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
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  DecideFieldExceptionDto,
  FieldExceptionsQueryDto,
  RaiseFieldExceptionDto,
} from './dto/field-exceptions.dto';
import { FieldExceptionsService } from './field-exceptions.service';
import {
  GuardFieldExceptionResponse,
  StaffFieldExceptionResponse,
} from './views/field-exception.views';

/** The guard asks the on-duty management (ADR 0056). */
@ApiArea('gate')
@RequirePermissions('gate.operate')
@Controller('gate/field-exceptions')
export class GuardFieldExceptionsController {
  constructor(private readonly exceptions: FieldExceptionsService) {}

  @Post()
  @NoStore()
  @Idempotent({ omit: ['idNumber'] })
  @ApiOperation({
    summary: 'Ask the management to let someone the gate refused in, once',
    description:
      'Inside a shift at a gate. Never past a lockdown (LOCKDOWN_ACTIVE) or a ban (ENTRY_BLOCKED). Every holder of `gate_exceptions.decide` is told; nobody answering by `answerBy` expires it.',
  })
  @ApiCreatedResponse({ type: GuardFieldExceptionResponse })
  async raise(
    @Body() dto: RaiseFieldExceptionDto,
  ): Promise<GuardFieldExceptionResponse> {
    return GuardFieldExceptionResponse.from(await this.exceptions.raise(dto));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({
    summary: 'Get a field exception of my gate (poll while waiting)',
  })
  @ApiOkResponse({ type: GuardFieldExceptionResponse })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<GuardFieldExceptionResponse> {
    return GuardFieldExceptionResponse.from(await this.exceptions.forGuard(id));
  }

  @Post(':id/withdraw')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({ summary: 'Withdraw a pending field exception' })
  @ApiOkResponse({ type: GuardFieldExceptionResponse })
  async withdraw(
    @Param('id', parseId()) id: string,
  ): Promise<GuardFieldExceptionResponse> {
    return GuardFieldExceptionResponse.from(await this.exceptions.withdraw(id));
  }
}

/** The on-duty management answers (ADR 0056). */
@ApiArea('gate')
@RequirePermissions('gate_exceptions.decide')
@Controller('staff/gate/field-exceptions')
export class StaffFieldExceptionsController {
  constructor(private readonly exceptions: FieldExceptionsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the field exceptions, newest first' })
  @ApiOkResponse({ type: ListOf(StaffFieldExceptionResponse) })
  async list(
    @Query() q: FieldExceptionsQueryDto,
  ): Promise<ListResponse<StaffFieldExceptionResponse>> {
    return toList(await this.exceptions.list(q), (v) =>
      StaffFieldExceptionResponse.fromStaff(v),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a field exception' })
  @ApiOkResponse({ type: StaffFieldExceptionResponse })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<StaffFieldExceptionResponse> {
    return StaffFieldExceptionResponse.fromStaff(await this.exceptions.get(id));
  }

  @Post(':id/decide')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({
    summary: 'Approve or reject a field exception',
    description:
      'The first answer wins (GATE_EXCEPTION_DECIDED with params.status otherwise; `expired` when its deadline passed first). An approval lets one entry in at its gate for `gate_settings.exceptionEntryMinutes`.',
  })
  @ApiOkResponse({ type: StaffFieldExceptionResponse })
  async decide(
    @Param('id', parseId()) id: string,
    @Body() dto: DecideFieldExceptionDto,
  ): Promise<StaffFieldExceptionResponse> {
    return StaffFieldExceptionResponse.fromStaff(
      await this.exceptions.decide(id, dto.decision, dto.reasonCode),
    );
  }
}

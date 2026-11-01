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
  MyGuardInstructionsQueryDto,
  SendTechnicianInstructionDto,
  StaffGuardInstructionsQueryDto,
} from './dto/guard-instructions.dto';
import { GuardInstructionsService } from './guard-instructions.service';
import {
  MyGuardInstructionView,
  StaffGuardInstructionDetailView,
  StaffGuardInstructionView,
} from './views/guard-instruction.views';

/**
 * Instructions to the technicians, as the field team sends them (ADR
 * 0078): the guards' instructions (ADR 0050, 0056) with the `technicians`
 * audience. The guards' routes never see these, nor these the guards'.
 */
@ApiArea('field-team')
@RequirePermissions('field_team.manage')
@Controller('staff/field-team/instructions')
export class StaffTechnicianInstructionsController {
  constructor(private readonly instructions: GuardInstructionsService) {}

  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Send the technicians an instruction',
    description:
      'It reaches every active field technician then, and anyone who goes on duty while it is live. Urgent: a critical push. With `validFrom`/`validUntil` (compound days, inclusive) technicians see and acknowledge it only on those days, and are pushed at sending only when it holds today — otherwise when they go on duty on a day it holds.',
  })
  @ApiCreatedResponse({ type: StaffGuardInstructionView })
  send(
    @Body() dto: SendTechnicianInstructionDto,
  ): Promise<StaffGuardInstructionView> {
    return this.instructions.send({ ...dto, audience: 'technicians' });
  }

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the technicians’ instructions',
    description: 'Newest first, with how many acknowledged.',
  })
  @ApiOkResponse({ type: ListOf(StaffGuardInstructionView) })
  async list(
    @Query() q: StaffGuardInstructionsQueryDto,
  ): Promise<ListResponse<StaffGuardInstructionView>> {
    return toList(await this.instructions.list(q, 'technicians'), (i) => i);
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({
    summary: 'Get a technicians’ instruction',
    description:
      'With every technician it reaches and whether they acknowledged.',
  })
  @ApiOkResponse({ type: StaffGuardInstructionDetailView })
  get(
    @Param('id', parseId()) id: string,
  ): Promise<StaffGuardInstructionDetailView> {
    return this.instructions.get(id, 'technicians');
  }

  @Post(':id/archive')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Archive a technicians’ instruction',
    description: 'It reaches nobody new; acknowledgements stay.',
  })
  @ApiOkResponse({ type: StaffGuardInstructionView })
  archive(
    @Param('id', parseId()) id: string,
  ): Promise<StaffGuardInstructionView> {
    return this.instructions.archive(id, 'technicians');
  }
}

/** The instructions that reach a technician (ADR 0078): `tickets.work`. */
@ApiArea('field-team')
@RequirePermissions('tickets.work')
@Controller('maintenance/instructions')
export class TechnicianInstructionsController {
  constructor(private readonly instructions: GuardInstructionsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the instructions that reach me',
    description:
      'Newest first; `status=pending` for those waiting for me, `q` to search the archive.',
  })
  @ApiOkResponse({ type: ListOf(MyGuardInstructionView) })
  async mine(
    @Query() q: MyGuardInstructionsQueryDto,
  ): Promise<ListResponse<MyGuardInstructionView>> {
    return toList(await this.instructions.mine(q), (i) => i);
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get an instruction that reaches me' })
  @ApiOkResponse({ type: MyGuardInstructionView })
  get(@Param('id', parseId()) id: string): Promise<MyGuardInstructionView> {
    return this.instructions.getMine(id);
  }

  @Post(':id/acknowledge')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Acknowledge an instruction',
    description: 'Once; again answers the same.',
  })
  @ApiOkResponse({ type: MyGuardInstructionView })
  acknowledge(
    @Param('id', parseId()) id: string,
  ): Promise<MyGuardInstructionView> {
    return this.instructions.acknowledge(id);
  }
}

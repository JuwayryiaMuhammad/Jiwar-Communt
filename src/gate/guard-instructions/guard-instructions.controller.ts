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
  SendGuardInstructionDto,
  StaffGuardInstructionsQueryDto,
} from './dto/guard-instructions.dto';
import { GuardInstructionsService } from './guard-instructions.service';
import {
  MyGuardInstructionView,
  StaffGuardInstructionDetailView,
  StaffGuardInstructionView,
} from './views/guard-instruction.views';

/** Instructions to guards, as the management sends them (ADR 0050). */
@ApiArea('guard-duty')
@RequirePermissions('guard_instructions.manage')
@Controller('staff/security/instructions')
export class StaffGuardInstructionsController {
  constructor(private readonly instructions: GuardInstructionsService) {}

  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Send guards an instruction',
    description:
      'To all guards, a gate or a zone. It reaches the active guards then — at a gate or a zone, those on shift there and those scheduled there in the next seven days — and anyone who opens a shift where it applies while it is live. Urgent: a critical push. With `validFrom`/`validUntil` (compound days, inclusive; ADR 0056) guards see and acknowledge it only on those days, and are pushed at sending only when it holds today — otherwise at their first shift start on a day it holds.',
  })
  @ApiCreatedResponse({ type: StaffGuardInstructionView })
  send(
    @Body() dto: SendGuardInstructionDto,
  ): Promise<StaffGuardInstructionView> {
    return this.instructions.send(dto);
  }

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the instructions',
    description: 'Newest first, with how many acknowledged.',
  })
  @ApiOkResponse({ type: ListOf(StaffGuardInstructionView) })
  async list(
    @Query() q: StaffGuardInstructionsQueryDto,
  ): Promise<ListResponse<StaffGuardInstructionView>> {
    return toList(await this.instructions.list(q), (i) => i);
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({
    summary: 'Get an instruction',
    description: 'With every guard it reaches and whether they acknowledged.',
  })
  @ApiOkResponse({ type: StaffGuardInstructionDetailView })
  get(
    @Param('id', parseId()) id: string,
  ): Promise<StaffGuardInstructionDetailView> {
    return this.instructions.get(id);
  }

  @Post(':id/archive')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Archive an instruction',
    description: 'It reaches nobody new; acknowledgements stay.',
  })
  @ApiOkResponse({ type: StaffGuardInstructionView })
  archive(
    @Param('id', parseId()) id: string,
  ): Promise<StaffGuardInstructionView> {
    return this.instructions.archive(id);
  }
}

/** The instructions that reach a guard (ADR 0050): `gate.operate`. */
@ApiArea('guard-duty')
@RequirePermissions('gate.operate')
@Controller('gate/guard-instructions')
export class GuardInstructionsController {
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

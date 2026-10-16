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
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  RejectSwapDto,
  RequestSwapDto,
  StaffSwapsQueryDto,
} from './dto/swaps.dto';
import { SwapsService } from './swaps.service';
import { GuardSwapView, StaffGuardSwapView } from './views/swap.views';

/** Shift swaps, the guards' side (ADR 0050): `gate.operate`. */
@ApiArea('guard-duty')
@RequirePermissions('gate.operate')
@Controller('gate/swaps')
export class GuardSwapsController {
  constructor(private readonly swaps: SwapsService) {}

  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Ask a colleague to take one of my slots',
    description:
      'In exchange for one of theirs, or as a cover. A slot is in one live swap at most (409 SWAP_SLOT_BUSY); nobody may be left with overlapping slots (409 ROSTER_OVERLAP). The colleague is told.',
  })
  @ApiCreatedResponse({ type: GuardSwapView })
  request(@Body() dto: RequestSwapDto): Promise<GuardSwapView> {
    return this.swaps.request(dto);
  }

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List my swaps', description: 'Newest first.' })
  @ApiOkResponse({ type: ListOf(GuardSwapView) })
  async mine(@Query() q: PageQueryDto): Promise<ListResponse<GuardSwapView>> {
    return toList(await this.swaps.mine(q), (s) => s);
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a swap of mine' })
  @ApiOkResponse({ type: GuardSwapView })
  get(@Param('id', parseId()) id: string): Promise<GuardSwapView> {
    return this.swaps.getMine(id);
  }

  @Post(':id/accept')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept a swap I was asked',
    description: 'The roster’s keepers are told, to decide.',
  })
  @ApiOkResponse({ type: GuardSwapView })
  accept(@Param('id', parseId()) id: string): Promise<GuardSwapView> {
    return this.swaps.accept(id);
  }

  @Post(':id/decline')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline a swap I was asked' })
  @ApiOkResponse({ type: GuardSwapView })
  decline(@Param('id', parseId()) id: string): Promise<GuardSwapView> {
    return this.swaps.decline(id);
  }

  @Post(':id/withdraw')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw a swap I asked for, while undecided' })
  @ApiOkResponse({ type: GuardSwapView })
  withdraw(@Param('id', parseId()) id: string): Promise<GuardSwapView> {
    return this.swaps.withdraw(id);
  }
}

/** Shift swaps, as the roster's keepers decide them (ADR 0050). */
@ApiArea('guard-duty')
@RequirePermissions('guard_roster.manage')
@Controller('staff/security/swaps')
export class StaffSwapsController {
  constructor(private readonly swaps: SwapsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the swaps', description: 'Newest first.' })
  @ApiOkResponse({ type: ListOf(StaffGuardSwapView) })
  async list(
    @Query() q: StaffSwapsQueryDto,
  ): Promise<ListResponse<StaffGuardSwapView>> {
    return toList(await this.swaps.list(q), (s) => s);
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a swap' })
  @ApiOkResponse({ type: StaffGuardSwapView })
  get(@Param('id', parseId()) id: string): Promise<StaffGuardSwapView> {
    return this.swaps.get(id);
  }

  @Post(':id/approve')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve a swap the colleague accepted',
    description:
      'The slots get their new guards. Checked again: 409 SWAP_NOT_POSSIBLE (params.reason) when the slots changed, started or a guard left; 409 ROSTER_OVERLAP. Never one of my own (403).',
  })
  @ApiOkResponse({ type: StaffGuardSwapView })
  approve(@Param('id', parseId()) id: string): Promise<StaffGuardSwapView> {
    return this.swaps.approve(id);
  }

  @Post(':id/reject')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a swap the colleague accepted' })
  @ApiOkResponse({ type: StaffGuardSwapView })
  reject(
    @Param('id', parseId()) id: string,
    @Body() dto: RejectSwapDto,
  ): Promise<StaffGuardSwapView> {
    return this.swaps.reject(id, dto.reasonCode);
  }
}

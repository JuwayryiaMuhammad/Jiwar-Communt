import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  CreateHandoverItemDto,
  StaffHandoversQueryDto,
  UpdateHandoverItemDto,
} from './dto/handover.dto';
import { HandoverService } from './handover.service';
import {
  GuardHandoverItemView,
  GuardHandoverView,
  ManagedGuardHandoverItemView,
  StaffGuardHandoverView,
} from './views/handover.views';

/** The handover, the guard's side (ADR 0050): `gate.operate`. */
@ApiArea('guard-duty')
@RequirePermissions('gate.operate')
@Controller('gate')
export class GuardHandoverController {
  constructor(private readonly handover: HandoverService) {}

  @Get('handover-items')
  @NoStore()
  @ApiOperation({
    summary: 'List the checklist to tick when ending my shift',
    description: 'The active items, in order: every one is ticked to end.',
  })
  @ApiOkResponse({ type: ListOf(GuardHandoverItemView) })
  async items(): Promise<ListResponse<GuardHandoverItemView>> {
    return bounded(await this.handover.activeItems(), (i) => i);
  }

  @Get('handovers/pending')
  @NoStore()
  @ApiOperation({
    summary: 'List the handovers waiting at my post',
    description:
      'Of the last day, nobody acknowledged, not mine. Needs an open shift (403 NO_OPEN_SHIFT).',
  })
  @ApiOkResponse({ type: ListOf(GuardHandoverView) })
  async pending(): Promise<ListResponse<GuardHandoverView>> {
    return bounded(await this.handover.pending(), (h) => h);
  }

  @Post('handovers/:id/acknowledge')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Acknowledge a handover at my post',
    description:
      'Once: 409 HANDOVER_ALREADY_ACKNOWLEDGED for the next. Never my own (403 HANDOVER_OWN). It blocks nothing: gate work goes on without it.',
  })
  @ApiOkResponse({ type: GuardHandoverView })
  acknowledge(@Param('id', parseId()) id: string): Promise<GuardHandoverView> {
    return this.handover.acknowledge(id);
  }
}

/** The handover, as the management keeps it (ADR 0050). */
@ApiArea('guard-duty')
@RequirePermissions('guard_roster.manage')
@Controller('staff/security')
export class StaffHandoverController {
  constructor(private readonly handover: HandoverService) {}

  @Get('handovers')
  @NoStore()
  @ApiOperation({
    summary: 'List the handovers',
    description:
      'Made on the compound’s days `from` … `to` (default the last seven), 31 at most.',
  })
  @ApiOkResponse({ type: ListOf(StaffGuardHandoverView) })
  async list(
    @Query() q: StaffHandoversQueryDto,
  ): Promise<ListResponse<StaffGuardHandoverView>> {
    return bounded(await this.handover.list(q), (h) => h);
  }

  @Get('handovers/:id')
  @NoStore()
  @ApiOperation({ summary: 'Get a handover' })
  @ApiOkResponse({ type: StaffGuardHandoverView })
  get(@Param('id', parseId()) id: string): Promise<StaffGuardHandoverView> {
    return this.handover.get(id);
  }

  @Get('handover-items')
  @NoStore()
  @ApiOperation({ summary: 'List the checklist, retired items too' })
  @ApiOkResponse({ type: ListOf(ManagedGuardHandoverItemView) })
  async items(): Promise<ListResponse<ManagedGuardHandoverItemView>> {
    return bounded(await this.handover.items(), (i) => i);
  }

  @Post('handover-items')
  @NoStore()
  @ApiOperation({
    summary: 'Add a checklist item',
    description: 'At most 30 active (409 HANDOVER_CHECKLIST_FULL).',
  })
  @ApiCreatedResponse({ type: ManagedGuardHandoverItemView })
  create(
    @Body() dto: CreateHandoverItemDto,
  ): Promise<ManagedGuardHandoverItemView> {
    return this.handover.createItem(dto);
  }

  @Patch('handover-items/:id')
  @NoStore()
  @ApiOperation({
    summary: 'Rename, reorder, retire or restore a checklist item',
    description: 'An item is never deleted: handovers keep it.',
  })
  @ApiOkResponse({ type: ManagedGuardHandoverItemView })
  update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateHandoverItemDto,
  ): Promise<ManagedGuardHandoverItemView> {
    return this.handover.updateItem(id, dto);
  }
}

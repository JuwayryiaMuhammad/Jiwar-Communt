import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
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
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ChecklistsService } from './checklists.service';
import {
  ChecklistAnswerDto,
  CreateChecklistDto,
  ReplaceChecklistItemsDto,
  UpdateChecklistDto,
} from './dto/checklists.dto';
import { TicketChecklists } from './ticket-checklists.service';
import {
  ChecklistRunView,
  ChecklistSummaryView,
  ChecklistView,
} from './views/checklist.views';

/** The compound's checklists (ADR 0064). */
@ApiArea('maintenance')
@Controller('maintenance/checklists')
export class ChecklistsController {
  constructor(private readonly checklists: ChecklistsService) {}

  @Get()
  @RequireAnyPermission(
    'assets.read',
    'inspections.perform',
    'inspections.manage',
  )
  @ApiOperation({ summary: 'List checklists' })
  @ApiOkResponse({ type: ListOf(ChecklistSummaryView) })
  async list(): Promise<ListResponse<ChecklistSummaryView>> {
    return bounded(await this.checklists.list(), (t) =>
      ChecklistSummaryView.from(t),
    );
  }

  @Post()
  @RequireAnyPermission('assets.manage', 'inspections.manage')
  @Idempotent()
  @ApiOperation({ summary: 'Add a checklist' })
  @ApiCreatedResponse({ type: ChecklistView })
  async create(@Body() dto: CreateChecklistDto): Promise<ChecklistView> {
    return ChecklistView.fromRead(await this.checklists.create(dto));
  }

  @Get(':id')
  @RequireAnyPermission(
    'assets.read',
    'inspections.perform',
    'inspections.manage',
  )
  @ApiOperation({ summary: 'Get a checklist with its current items' })
  @ApiOkResponse({ type: ChecklistView })
  async get(@Param('id', parseId()) id: string): Promise<ChecklistView> {
    return ChecklistView.fromRead(await this.checklists.get(id));
  }

  @Patch(':id')
  @RequireAnyPermission('assets.manage', 'inspections.manage')
  @ApiOperation({ summary: 'Rename, require a scan, or retire a checklist' })
  @ApiOkResponse({ type: ChecklistView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateChecklistDto,
  ): Promise<ChecklistView> {
    return ChecklistView.fromRead(await this.checklists.update(id, dto));
  }

  @Put(':id/items')
  @RequireAnyPermission('assets.manage', 'inspections.manage')
  @ApiOperation({
    summary: 'Replace the items: a new version; open runs keep theirs',
  })
  @ApiOkResponse({ type: ChecklistView })
  async replaceItems(
    @Param('id', parseId()) id: string,
    @Body() dto: ReplaceChecklistItemsDto,
  ): Promise<ChecklistView> {
    return ChecklistView.fromRead(
      await this.checklists.replaceItems(id, dto.items),
    );
  }
}

/** A ticket's checklist, as its technician fills it (ADR 0064). */
@ApiArea('maintenance')
@RequirePermissions('tickets.work')
@Controller('technician/tickets/:id/checklist')
export class TechnicianChecklistController {
  constructor(private readonly checklists: TicketChecklists) {}

  /** No-store: the photos are presigned URLs. */
  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Read my ticket’s checklist' })
  @ApiOkResponse({ type: ChecklistRunView })
  async read(@Param('id', parseId()) id: string): Promise<ChecklistRunView> {
    return ChecklistRunView.from(await this.checklists.read(id, 'technician'));
  }

  @Put('items/:itemId')
  @NoStore()
  @ApiOperation({
    summary: 'Answer an item (again, until submitted); photos are added',
  })
  @ApiOkResponse({ type: ChecklistRunView })
  async answer(
    @Param('id', parseId()) id: string,
    @Param('itemId', parseId('itemId')) itemId: string,
    @Body() dto: ChecklistAnswerDto,
  ): Promise<ChecklistRunView> {
    return ChecklistRunView.from(await this.checklists.answer(id, itemId, dto));
  }

  @Post('submit')
  @NoStore()
  @ApiOperation({
    summary: 'Submit the checklist: every required item answered; never again',
  })
  @ApiCreatedResponse({ type: ChecklistRunView })
  async submit(@Param('id', parseId()) id: string): Promise<ChecklistRunView> {
    return ChecklistRunView.from(await this.checklists.submit(id));
  }
}

/** A ticket's checklist, for dispatch (ADR 0064). */
@ApiArea('maintenance')
@RequirePermissions('tickets.dispatch')
@Controller('maintenance/tickets/:id/checklist')
export class DispatchChecklistController {
  constructor(private readonly checklists: TicketChecklists) {}

  /** No-store: the photos are presigned URLs. */
  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Read a ticket’s checklist' })
  @ApiOkResponse({ type: ChecklistRunView })
  async read(@Param('id', parseId()) id: string): Promise<ChecklistRunView> {
    return ChecklistRunView.from(await this.checklists.read(id, 'dispatch'));
  }
}

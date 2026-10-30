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
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ReasonCodeDto } from '../tickets/dto/tickets.dto';
import {
  CopyProgramDto,
  CreateItemDto,
  CreateProgramDto,
  ItemDoneDto,
  ProgramsQueryDto,
  SpawnCampaignDto,
  UpdateItemDto,
  UpdateProgramDto,
} from './dto/readiness.dto';
import { CampaignsService } from './campaigns.service';
import { ReadinessService } from './readiness.service';
import {
  CampaignView,
  ContractDueView,
  ReadinessCopyView,
  ReadinessItemView,
  ReadinessProgramView,
} from './views/readiness.views';

/** The compound's readiness programs (ADR 0067). */
@ApiArea('maintenance')
@Controller('maintenance/readiness/programs')
@RequirePermissions('readiness.manage')
export class ReadinessProgramsController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get()
  @ApiOperation({ summary: 'List the readiness programs, latest start first' })
  @ApiOkResponse({ type: ListOf(ReadinessProgramView) })
  async list(
    @Query() q: ProgramsQueryDto,
  ): Promise<ListResponse<ReadinessProgramView>> {
    return toList(await this.readiness.list(q), (p) =>
      ReadinessProgramView.from(p),
    );
  }

  @Post()
  @Idempotent()
  @ApiOperation({ summary: 'Start a readiness program' })
  @ApiCreatedResponse({ type: ReadinessProgramView })
  async create(@Body() dto: CreateProgramDto): Promise<ReadinessProgramView> {
    return ReadinessProgramView.from(await this.readiness.create(dto));
  }

  @Get(':id')
  @ApiOperation({ summary: 'A readiness program, with its readiness' })
  @ApiOkResponse({ type: ReadinessProgramView })
  async get(@Param('id', parseId()) id: string): Promise<ReadinessProgramView> {
    return ReadinessProgramView.from(await this.readiness.get(id));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change an open program’s title or days' })
  @ApiOkResponse({ type: ReadinessProgramView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateProgramDto,
  ): Promise<ReadinessProgramView> {
    return ReadinessProgramView.from(await this.readiness.update(id, dto));
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close a program for good' })
  @ApiOkResponse({ type: ReadinessProgramView })
  async close(
    @Param('id', parseId()) id: string,
  ): Promise<ReadinessProgramView> {
    return ReadinessProgramView.from(await this.readiness.close(id));
  }

  @Post(':id/copy')
  @Idempotent()
  @ApiOperation({
    summary: 'Copy a program to a new start, every day moved alike',
  })
  @ApiCreatedResponse({ type: ReadinessCopyView })
  async copy(
    @Param('id', parseId()) id: string,
    @Body() dto: CopyProgramDto,
  ): Promise<ReadinessCopyView> {
    return ReadinessCopyView.fromCopy(
      await this.readiness.copy(id, dto.startsOn),
    );
  }

  @Get(':id/items')
  @ApiOperation({ summary: 'A program’s items, by due day' })
  @ApiOkResponse({ type: ListOf(ReadinessItemView) })
  async items(
    @Param('id', parseId()) id: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<ReadinessItemView>> {
    return toList(await this.readiness.items(id, q), (i) =>
      ReadinessItemView.from(i),
    );
  }

  @Post(':id/items')
  @Idempotent()
  @ApiOperation({ summary: 'Add an item to an open program' })
  @ApiCreatedResponse({ type: ReadinessItemView })
  async createItem(
    @Param('id', parseId()) id: string,
    @Body() dto: CreateItemDto,
  ): Promise<ReadinessItemView> {
    return ReadinessItemView.from(await this.readiness.createItem(id, dto));
  }

  @Get(':id/contracts-due')
  @ApiOperation({
    summary:
      'The maintenance contracts that end by the program’s last day, with their reviews',
  })
  @ApiOkResponse({ type: ListOf(ContractDueView) })
  async contractsDue(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<ContractDueView>> {
    return bounded(await this.readiness.contractsDue(id), (c) =>
      ContractDueView.from(c),
    );
  }
}

/** A readiness program's items (ADR 0067). */
@ApiArea('maintenance')
@Controller('maintenance/readiness/items')
@RequirePermissions('readiness.manage')
export class ReadinessItemsController {
  constructor(
    private readonly readiness: ReadinessService,
    private readonly campaigns: CampaignsService,
  ) {}

  @Patch(':itemId')
  @ApiOperation({
    summary: 'Change an open item’s title, owner, day or estimate',
  })
  @ApiOkResponse({ type: ReadinessItemView })
  async update(
    @Param('itemId', parseId('itemId')) id: string,
    @Body() dto: UpdateItemDto,
  ): Promise<ReadinessItemView> {
    return ReadinessItemView.from(await this.readiness.updateItem(id, dto));
  }

  @Post(':itemId/done')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark an item done; a contract review with its decision',
  })
  @ApiOkResponse({ type: ReadinessItemView })
  async done(
    @Param('itemId', parseId('itemId')) id: string,
    @Body() dto: ItemDoneDto,
  ): Promise<ReadinessItemView> {
    return ReadinessItemView.from(await this.readiness.done(id, dto, 'manage'));
  }

  /** `reasonCode` from the closed list `readinessItemCancel`. */
  @Post(':itemId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Call an item off' })
  @ApiOkResponse({ type: ReadinessItemView })
  async cancel(
    @Param('itemId', parseId('itemId')) id: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<ReadinessItemView> {
    return ReadinessItemView.from(
      await this.readiness.cancel(id, dto.reasonCode),
    );
  }

  @Get(':itemId/campaign')
  @ApiOperation({ summary: 'A campaign’s inspections, with their status' })
  @ApiOkResponse({ type: CampaignView })
  async campaign(
    @Param('itemId', parseId('itemId')) id: string,
  ): Promise<CampaignView> {
    return CampaignView.from(await this.campaigns.get(id));
  }

  /** One inspection per target the campaign does not hold yet. */
  @Post(':itemId/campaign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Schedule a campaign’s inspections, one per target, due on its day',
  })
  @ApiOkResponse({ type: CampaignView })
  async spawn(
    @Param('itemId', parseId('itemId')) id: string,
    @Body() dto: SpawnCampaignDto,
  ): Promise<CampaignView> {
    return CampaignView.from(await this.campaigns.spawn(id, dto));
  }
}

/**
 * An owner's own readiness items (ADR 0067): any staff member or the
 * manager given one, with no permission; another's item is not found.
 */
@ApiArea('maintenance')
@Controller('staff/readiness-items')
export class OwnReadinessItemsController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get()
  @ApiOperation({ summary: 'My open readiness items, by due day' })
  @ApiOkResponse({ type: ListOf(ReadinessItemView) })
  async mine(): Promise<ListResponse<ReadinessItemView>> {
    return bounded(await this.readiness.mine(), (i) =>
      ReadinessItemView.from(i),
    );
  }

  @Post(':itemId/done')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark my item done; a contract review with its decision',
  })
  @ApiOkResponse({ type: ReadinessItemView })
  async done(
    @Param('itemId', parseId('itemId')) id: string,
    @Body() dto: ItemDoneDto,
  ): Promise<ReadinessItemView> {
    return ReadinessItemView.from(await this.readiness.done(id, dto, 'owner'));
  }
}

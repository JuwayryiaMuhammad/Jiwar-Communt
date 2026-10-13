import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { BlocksService } from './blocks.service';
import { ConversationsService } from './conversations.service';
import {
  ConversationMessageDto,
  ReportConversationDto,
} from './dto/conversations.dto';
import { ReportsService } from './reports.service';
import {
  BlockView,
  ConversationCreatedView,
  ConversationMessageView,
  ConversationView,
  ReportCreatedView,
} from './views/conversation.views';

/** Writing to whoever posted, about their post (ADR 0042). */
@ApiArea('neighbours')
@RequirePermissions('neighbours.board')
@Controller('neighbour-posts')
export class PostContactController {
  constructor(private readonly conversations: ConversationsService) {}

  @Post(':id/conversations')
  @NoStore()
  @ApiOperation({ summary: 'Write to whoever posted, without either name' })
  @Idempotent()
  @ApiCreatedResponse({ type: ConversationCreatedView })
  async start(
    @Param('id', parseId()) id: string,
    @Body() dto: ConversationMessageDto,
  ): Promise<ConversationCreatedView> {
    return ConversationCreatedView.from(
      await this.conversations.start(id, dto),
    );
  }
}

/**
 * A resident's masked conversations (ADR 0042): only the two sides of one
 * ever read it here. Every answer is no-store.
 */
@ApiArea('neighbours')
@RequirePermissions('neighbours.board')
@Controller('neighbour-conversations')
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly blocks: BlocksService,
    private readonly reports: ReportsService,
  ) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List my conversations with neighbours' })
  @ApiOkResponse({ type: ListOf(ConversationView) })
  async list(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<ConversationView>> {
    return toList(await this.conversations.listMine(q), (c) =>
      ConversationView.from(c),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get one of my conversations' })
  @ApiOkResponse({ type: ConversationView })
  async get(@Param('id', parseId()) id: string): Promise<ConversationView> {
    return ConversationView.from(await this.conversations.get(id));
  }

  @Get(':id/messages')
  @NoStore()
  @ApiOperation({ summary: 'Read one of my conversations' })
  @ApiOkResponse({ type: ListOf(ConversationMessageView) })
  async thread(
    @Param('id', parseId()) id: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<ConversationMessageView>> {
    return toList(await this.conversations.thread(id, q), (m) =>
      ConversationMessageView.from(m),
    );
  }

  @Post(':id/messages')
  @NoStore()
  @ApiOperation({ summary: 'Write in one of my conversations' })
  @Idempotent()
  @ApiCreatedResponse({ type: ConversationCreatedView })
  async post(
    @Param('id', parseId()) id: string,
    @Body() dto: ConversationMessageDto,
  ): Promise<ConversationCreatedView> {
    return ConversationCreatedView.from(await this.conversations.post(id, dto));
  }

  /** Names show only once the other side agrees too. */
  @Post(':id/reveal')
  @HttpCode(200)
  @NoStore()
  @ApiOperation({ summary: 'Agree to show names in a conversation' })
  @ApiOkResponse({ type: ConversationView })
  async reveal(@Param('id', parseId()) id: string): Promise<ConversationView> {
    return ConversationView.from(await this.conversations.reveal(id));
  }

  /** Only while the other side has not agreed (NEIGHBOUR_NAMES_ALREADY_REVEALED after). */
  @Delete(':id/reveal')
  @NoStore()
  @ApiOperation({ summary: 'Take back my agreement to show names' })
  @ApiOkResponse({ type: ConversationView })
  async unreveal(
    @Param('id', parseId()) id: string,
  ): Promise<ConversationView> {
    return ConversationView.from(await this.conversations.unreveal(id));
  }

  /** The other side is told nothing. */
  @Post(':id/block')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Block the other side of a conversation' })
  @ApiNoContentResponse()
  async block(@Param('id', parseId()) id: string): Promise<void> {
    await this.blocks.block(id);
  }

  /** Closes the conversation and shows it, alone, to the staff. */
  @Post(':id/report')
  @NoStore()
  @ApiOperation({ summary: 'Report a conversation to management' })
  @ApiCreatedResponse({ type: ReportCreatedView })
  async report(
    @Param('id', parseId()) id: string,
    @Body() dto: ReportConversationDto,
  ): Promise<ReportCreatedView> {
    return ReportCreatedView.from(await this.reports.report(id, dto));
  }
}

/** The residents the caller blocked, each as a building and a date (ADR 0042). */
@ApiArea('neighbours')
@RequirePermissions('neighbours.board')
@Controller('neighbour-blocks')
export class BlocksController {
  constructor(private readonly blocks: BlocksService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the neighbours I blocked' })
  @ApiOkResponse({ type: ListOf(BlockView) })
  async list(): Promise<ListResponse<BlockView>> {
    return bounded(await this.blocks.listMine(), (b) => BlockView.from(b));
  }

  @Delete(':id')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Unblock a neighbour' })
  @ApiNoContentResponse()
  async unblock(@Param('id', parseId()) id: string): Promise<void> {
    await this.blocks.unblock(id);
  }
}

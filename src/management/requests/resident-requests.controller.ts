import {
  Body,
  Controller,
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
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  CreateRequestDto,
  PostRequestMessageDto,
  ResidentRequestsQueryDto,
} from './dto/requests.dto';
import { RequestLifecycle } from './lifecycle.service';
import { MessagesService } from './messages.service';
import { RequestsService } from './requests.service';
import {
  MessageCreatedView,
  ResidentRequestMessageView,
} from './views/message.views';
import { RequestCreatedView, ResidentRequestView } from './views/request.views';

/**
 * A resident's requests to the management (ADR 0039): their own, and only
 * their own. Every answer here is no-store.
 */
@ApiArea('management-requests')
@RequirePermissions('requests.create')
@Controller('management-requests')
export class ResidentRequestsController {
  constructor(
    private readonly requests: RequestsService,
    private readonly messages: MessagesService,
    private readonly lifecycle: RequestLifecycle,
  ) {}

  @Post()
  @NoStore()
  @ApiOperation({ summary: 'Open a request to the management' })
  @Idempotent()
  @ApiCreatedResponse({ type: RequestCreatedView })
  async create(@Body() dto: CreateRequestDto): Promise<RequestCreatedView> {
    return RequestCreatedView.from(await this.requests.create(dto));
  }

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List my requests to the management' })
  @ApiOkResponse({ type: ListOf(ResidentRequestView) })
  async list(
    @Query() q: ResidentRequestsQueryDto,
  ): Promise<ListResponse<ResidentRequestView>> {
    return toList(await this.requests.listMine(q), (r) =>
      ResidentRequestView.from(r),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get one of my requests to the management' })
  @ApiOkResponse({ type: ResidentRequestView })
  async get(@Param('id', parseId()) id: string): Promise<ResidentRequestView> {
    return ResidentRequestView.from(await this.requests.detail(id, 'resident'));
  }

  /** Never a staff note: the read filters them out and the view has no field for one. */
  @Get(':id/messages')
  @NoStore()
  @ApiOperation({ summary: 'Read the conversation of my request' })
  @ApiOkResponse({ type: ListOf(ResidentRequestMessageView) })
  async thread(
    @Param('id', parseId()) id: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<ResidentRequestMessageView>> {
    return toList(await this.messages.list(id, 'resident', q), (m) =>
      ResidentRequestMessageView.from(m),
    );
  }

  @Post(':id/messages')
  @NoStore()
  @ApiOperation({ summary: 'Write on my request' })
  @Idempotent()
  @ApiCreatedResponse({ type: MessageCreatedView })
  async post(
    @Param('id', parseId()) id: string,
    @Body() dto: PostRequestMessageDto,
  ): Promise<MessageCreatedView> {
    return MessageCreatedView.from(
      await this.messages.post(id, 'resident', dto),
    );
  }

  /** Closed by its author, with no reason to pick. */
  @Post(':id/withdraw')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({ summary: 'Withdraw my request' })
  @ApiNoContentResponse()
  async withdraw(@Param('id', parseId()) id: string): Promise<void> {
    await this.lifecycle.withdraw(id);
  }

  /** Within seven days of the close; the body says why and starts a new cycle. */
  @Post(':id/reopen')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({ summary: 'Reopen my closed request' })
  @ApiNoContentResponse()
  async reopen(
    @Param('id', parseId()) id: string,
    @Body() dto: PostRequestMessageDto,
  ): Promise<void> {
    await this.lifecycle.reopen(id, dto);
  }
}

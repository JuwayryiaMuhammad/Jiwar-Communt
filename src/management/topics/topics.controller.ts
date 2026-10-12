import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
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
import { CreateTopicDto, UpdateTopicDto } from './dto/topics.dto';
import { TopicsService } from './topics.service';
import { TopicOptionView, TopicView } from './views/topic.views';

/** The compound's request topics, for the manager (ADR 0039). */
@ApiArea('management-requests')
@RequirePermissions('requests.manage')
@Controller('management/request-topics')
export class TopicsController {
  constructor(private readonly topics: TopicsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List management request topics' })
  @ApiOkResponse({ type: ListOf(TopicView) })
  async list(): Promise<ListResponse<TopicView>> {
    return bounded(await this.topics.list(), (t) => TopicView.from(t));
  }

  @Post()
  @NoStore()
  @ApiOperation({ summary: 'Create a management request topic' })
  @ApiCreatedResponse({ type: TopicView })
  async create(@Body() dto: CreateTopicDto): Promise<TopicView> {
    return TopicView.from(await this.topics.create(dto));
  }

  @Patch(':id')
  @NoStore()
  @ApiOperation({ summary: 'Update a management request topic' })
  @ApiOkResponse({ type: TopicView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateTopicDto,
  ): Promise<TopicView> {
    return TopicView.from(await this.topics.update(id, dto));
  }
}

/** What a request may be opened under: residents and handlers. */
@ApiArea('management-requests')
@RequireAnyPermission('requests.create', 'requests.handle')
@Controller('management-request-topics')
export class TopicOptionsController {
  constructor(private readonly topics: TopicsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the topics a request may be opened under' })
  @ApiOkResponse({ type: ListOf(TopicOptionView) })
  async list(): Promise<ListResponse<TopicOptionView>> {
    return bounded(await this.topics.options(), (t) => TopicOptionView.from(t));
  }
}

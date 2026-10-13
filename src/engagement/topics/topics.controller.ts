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
import {
  CreateSuggestionTopicDto,
  UpdateSuggestionTopicDto,
} from './dto/topics.dto';
import { SuggestionTopicsService } from './topics.service';
import {
  SuggestionTopicOptionView,
  SuggestionTopicView,
} from './views/topic.views';

/** The compound's suggestion topics, for the staff (ADR 0040). */
@ApiArea('community')
@RequirePermissions('community.suggestions')
@Controller('community/suggestion-topics')
export class SuggestionTopicsController {
  constructor(private readonly topics: SuggestionTopicsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List suggestion topics' })
  @ApiOkResponse({ type: ListOf(SuggestionTopicView) })
  async list(): Promise<ListResponse<SuggestionTopicView>> {
    return bounded(await this.topics.list(), (t) =>
      SuggestionTopicView.from(t),
    );
  }

  @Post()
  @NoStore()
  @ApiOperation({ summary: 'Create a suggestion topic' })
  @ApiCreatedResponse({ type: SuggestionTopicView })
  async create(
    @Body() dto: CreateSuggestionTopicDto,
  ): Promise<SuggestionTopicView> {
    return SuggestionTopicView.from(await this.topics.create(dto));
  }

  @Patch(':id')
  @NoStore()
  @ApiOperation({ summary: 'Update a suggestion topic' })
  @ApiOkResponse({ type: SuggestionTopicView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateSuggestionTopicDto,
  ): Promise<SuggestionTopicView> {
    return SuggestionTopicView.from(await this.topics.update(id, dto));
  }
}

/** What a suggestion may be written under: residents, and the staff's filter. */
@ApiArea('community')
@RequireAnyPermission('suggestions.create', 'community.suggestions')
@Controller('suggestion-topics')
export class SuggestionTopicOptionsController {
  constructor(private readonly topics: SuggestionTopicsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the topics a suggestion may be written under',
  })
  @ApiOkResponse({ type: ListOf(SuggestionTopicOptionView) })
  async list(): Promise<ListResponse<SuggestionTopicOptionView>> {
    return bounded(await this.topics.options(), (t) =>
      SuggestionTopicOptionView.from(t),
    );
  }
}

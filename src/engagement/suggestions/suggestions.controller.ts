import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
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
  SuggestionBoardQueryDto,
  CreateSuggestionDto,
  DoneNoteDto,
  MoveSuggestionDto,
  PublishSuggestionDto,
  RespondSuggestionDto,
  StaffSuggestionsQueryDto,
} from './dto/suggestions.dto';
import { SuggestionsService } from './suggestions.service';
import {
  BoardSuggestionView,
  DoneSuggestionView,
  MySuggestionListItemView,
  MySuggestionView,
  StaffSuggestionListItemView,
  StaffSuggestionView,
  SuggestionCreatedView,
} from './views/suggestion.views';

/**
 * A resident's own suggestions (ADR 0040, `suggestions.create`): private
 * to them and to the staff.
 */
@ApiArea('community')
@RequirePermissions('suggestions.create')
@Controller('suggestions')
export class SuggestionsController {
  constructor(private readonly suggestions: SuggestionsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List my suggestions' })
  @ApiOkResponse({ type: ListOf(MySuggestionListItemView) })
  async list(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<MySuggestionListItemView>> {
    return toList(await this.suggestions.listMine(q), (s) =>
      MySuggestionListItemView.from(s),
    );
  }

  @Post()
  @NoStore()
  @ApiOperation({ summary: 'Send a suggestion to the management' })
  @Idempotent()
  @ApiCreatedResponse({ type: SuggestionCreatedView })
  async create(
    @Body() dto: CreateSuggestionDto,
  ): Promise<SuggestionCreatedView> {
    return SuggestionCreatedView.from(await this.suggestions.create(dto));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get one of my suggestions and what became of it' })
  @ApiOkResponse({ type: MySuggestionView })
  async get(@Param('id', parseId()) id: string): Promise<MySuggestionView> {
    return MySuggestionView.from(await this.suggestions.mine(id));
  }
}

/**
 * The public board and "you said, we did" (ADR 0040, `community.read`):
 * what the staff published, by their summary; never an author.
 */
@ApiArea('community')
@RequirePermissions('community.read')
@Controller('suggestion-board')
export class SuggestionBoardController {
  constructor(private readonly suggestions: SuggestionsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the suggestions on the board' })
  @ApiOkResponse({ type: ListOf(BoardSuggestionView) })
  async list(
    @Query() q: SuggestionBoardQueryDto,
  ): Promise<ListResponse<BoardSuggestionView>> {
    return toList(await this.suggestions.board(q), (s) =>
      BoardSuggestionView.from(s),
    );
  }

  @Get('done')
  @NoStore()
  @ApiOperation({ summary: 'List what was done: "you said, we did"' })
  @ApiOkResponse({ type: ListOf(DoneSuggestionView) })
  async done(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<DoneSuggestionView>> {
    return toList(await this.suggestions.done(q), (s) =>
      DoneSuggestionView.from(s),
    );
  }

  @Put(':id/support')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({ summary: 'Support a suggestion on the board' })
  @ApiNoContentResponse()
  async support(@Param('id', parseId()) id: string): Promise<void> {
    await this.suggestions.support(id);
  }

  @Delete(':id/support')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({ summary: 'Take my support back' })
  @ApiNoContentResponse()
  async unsupport(@Param('id', parseId()) id: string): Promise<void> {
    await this.suggestions.unsupport(id);
  }
}

/** The compound's suggestions, for whoever handles them (ADR 0040). */
@ApiArea('community')
@RequirePermissions('community.suggestions')
@Controller('community/suggestions')
export class StaffSuggestionsController {
  constructor(private readonly suggestions: SuggestionsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the suggestions' })
  @ApiOkResponse({ type: ListOf(StaffSuggestionListItemView) })
  async list(
    @Query() q: StaffSuggestionsQueryDto,
  ): Promise<ListResponse<StaffSuggestionListItemView>> {
    return toList(
      await this.suggestions.listForStaff({
        ...q,
        published:
          q.published === undefined ? undefined : q.published === 'true',
      }),
      (s) => StaffSuggestionListItemView.from(s),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get one suggestion' })
  @ApiOkResponse({ type: StaffSuggestionView })
  async get(@Param('id', parseId()) id: string): Promise<StaffSuggestionView> {
    return StaffSuggestionView.from(await this.suggestions.getForStaff(id));
  }

  @Post(':id/status')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Move a suggestion forward, with or without an answer',
  })
  @ApiNoContentResponse()
  async move(
    @Param('id', parseId()) id: string,
    @Body() dto: MoveSuggestionDto,
  ): Promise<void> {
    await this.suggestions.move(id, dto.status, dto.response);
  }

  @Put(':id/response')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({ summary: 'Answer a suggestion' })
  @ApiNoContentResponse()
  async respond(
    @Param('id', parseId()) id: string,
    @Body() dto: RespondSuggestionDto,
  ): Promise<void> {
    await this.suggestions.respond(id, dto.response);
  }

  @Post(':id/publish')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Put a suggestion on the board under a summary, without its author',
  })
  @ApiNoContentResponse()
  async publish(
    @Param('id', parseId()) id: string,
    @Body() dto: PublishSuggestionDto,
  ): Promise<void> {
    await this.suggestions.publish(id, dto);
  }

  @Post(':id/unpublish')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({ summary: 'Take a suggestion off the board' })
  @ApiNoContentResponse()
  async unpublish(@Param('id', parseId()) id: string): Promise<void> {
    await this.suggestions.unpublish(id);
  }

  @Put(':id/done-note')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({ summary: 'Say what was done, with photos' })
  @ApiNoContentResponse()
  async doneNote(
    @Param('id', parseId()) id: string,
    @Body() dto: DoneNoteDto,
  ): Promise<void> {
    await this.suggestions.doneNote(id, dto);
  }
}

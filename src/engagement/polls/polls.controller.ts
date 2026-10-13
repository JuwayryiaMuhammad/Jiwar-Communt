import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
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
  CastVoteDto,
  CreatePollDto,
  PollsQueryDto,
  UpdatePollDto,
} from './dto/polls.dto';
import { PollsService } from './polls.service';
import {
  PollAudienceView,
  PollCreatedView,
  PollView,
  StaffPollView,
  VoteCastView,
} from './views/poll.views';

/**
 * The compound's consultative polls, for whoever publishes them (ADR
 * 0040). Counts only: no route here, or anywhere, tells what a unit chose.
 */
@ApiArea('community')
@RequirePermissions('community.publish')
@Controller('community/polls')
export class StaffPollsController {
  constructor(private readonly polls: PollsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the polls' })
  @ApiOkResponse({ type: ListOf(StaffPollView) })
  async list(@Query() q: PollsQueryDto): Promise<ListResponse<StaffPollView>> {
    return toList(await this.polls.listForStaff(q), (p) =>
      StaffPollView.from(p),
    );
  }

  @Post()
  @NoStore()
  @ApiOperation({ summary: 'Write a poll' })
  @Idempotent()
  @ApiCreatedResponse({ type: PollCreatedView })
  async create(@Body() dto: CreatePollDto): Promise<PollCreatedView> {
    return PollCreatedView.from(await this.polls.create(dto));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get one poll and its counts' })
  @ApiOkResponse({ type: StaffPollView })
  async get(@Param('id', parseId()) id: string): Promise<StaffPollView> {
    return StaffPollView.from(await this.polls.getForStaff(id));
  }

  @Get(':id/audience')
  @NoStore()
  @ApiOperation({ summary: 'Count the units a poll is put to' })
  @ApiOkResponse({ type: PollAudienceView })
  async audience(
    @Param('id', parseId()) id: string,
  ): Promise<PollAudienceView> {
    return { units: await this.polls.audienceUnits(id) };
  }

  @Patch(':id')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Change a poll before it opens, or its closing time while open',
  })
  @ApiNoContentResponse()
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdatePollDto,
  ): Promise<void> {
    await this.polls.update(id, dto);
  }

  @Post(':id/close')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({ summary: 'Close an open poll now' })
  @ApiNoContentResponse()
  async close(@Param('id', parseId()) id: string): Promise<void> {
    await this.polls.close(id);
  }

  @Post(':id/cancel')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({ summary: 'Cancel a poll: it ends with no result' })
  @ApiNoContentResponse()
  async cancel(@Param('id', parseId()) id: string): Promise<void> {
    await this.polls.cancel(id);
  }
}

/** The polls put to the caller (ADR 0040, `community.read`). */
@ApiArea('community')
@RequirePermissions('community.read')
@Controller('polls')
export class PollsController {
  constructor(private readonly polls: PollsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the polls put to me' })
  @ApiOkResponse({ type: ListOf(PollView) })
  async list(@Query() q: PageQueryDto): Promise<ListResponse<PollView>> {
    return toList(await this.polls.list(q), (p) => PollView.from(p));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get one poll put to me' })
  @ApiOkResponse({ type: PollView })
  async get(@Param('id', parseId()) id: string): Promise<PollView> {
    return PollView.from(await this.polls.one(id));
  }

  @Post(':id/votes')
  @NoStore()
  @ApiOperation({ summary: 'Cast or change my unit’s vote' })
  // The key is remembered without the choice: see `bodyless`.
  @Idempotent({ bodyless: true })
  @ApiCreatedResponse({ type: VoteCastView })
  async vote(
    @Param('id', parseId()) id: string,
    @Body() dto: CastVoteDto,
  ): Promise<VoteCastView> {
    await this.polls.vote(id, dto);
    return { pollId: id };
  }
}

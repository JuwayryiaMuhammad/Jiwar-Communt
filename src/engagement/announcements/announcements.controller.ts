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
  bounded,
  ListOf,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { AnnouncementsService } from './announcements.service';
import {
  AnnouncementsQueryDto,
  CreateAnnouncementDto,
  PublishAnnouncementDto,
  StaffAnnouncementsQueryDto,
  UpdateAnnouncementDto,
} from './dto/announcements.dto';
import {
  AnnouncementCreatedView,
  AnnouncementDeliveryView,
  AnnouncementListItemView,
  AnnouncementReadCountsView,
  AnnouncementReminderView,
  AnnouncementVersionView,
  AnnouncementView,
  StaffAnnouncementListItemView,
  StaffAnnouncementView,
} from './views/announcement.views';

/**
 * The compound's announcements, and its works and closures, for whoever
 * publishes them (ADR 0040, `community.publish`). Every answer here is
 * no-store.
 */
@ApiArea('community')
@RequirePermissions('community.publish')
@Controller('community/announcements')
export class StaffAnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the announcements, drafts and archived included',
  })
  @ApiOkResponse({ type: ListOf(StaffAnnouncementListItemView) })
  async list(
    @Query() q: StaffAnnouncementsQueryDto,
  ): Promise<ListResponse<StaffAnnouncementListItemView>> {
    return toList(await this.announcements.listForStaff(q), (a) =>
      StaffAnnouncementListItemView.from(a),
    );
  }

  @Post()
  @NoStore()
  @ApiOperation({ summary: 'Write an announcement, as a draft' })
  @Idempotent()
  @ApiCreatedResponse({ type: AnnouncementCreatedView })
  async create(
    @Body() dto: CreateAnnouncementDto,
  ): Promise<AnnouncementCreatedView> {
    return AnnouncementCreatedView.from(await this.announcements.create(dto));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get one announcement' })
  @ApiOkResponse({ type: StaffAnnouncementView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<StaffAnnouncementView> {
    return StaffAnnouncementView.from(await this.announcements.getForStaff(id));
  }

  @Patch(':id')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Change an announcement; new words make a new version',
  })
  @ApiNoContentResponse()
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateAnnouncementDto,
  ): Promise<void> {
    await this.announcements.update(id, dto);
  }

  @Post(':id/publish')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({ summary: 'Publish an announcement now, or schedule it' })
  @ApiNoContentResponse()
  async publish(
    @Param('id', parseId()) id: string,
    @Body() dto: PublishAnnouncementDto,
  ): Promise<void> {
    await this.announcements.publish(id, dto.publishAt);
  }

  @Post(':id/archive')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({ summary: 'Archive an announcement' })
  @ApiNoContentResponse()
  async archive(@Param('id', parseId()) id: string): Promise<void> {
    await this.announcements.archive(id);
  }

  @Get(':id/versions')
  @NoStore()
  @ApiOperation({
    summary: 'Read what an announcement said, version by version',
  })
  @ApiOkResponse({ type: ListOf(AnnouncementVersionView) })
  async versions(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<AnnouncementVersionView>> {
    return bounded(await this.announcements.versions(id), (v) =>
      AnnouncementVersionView.from(v),
    );
  }

  @Get(':id/reads')
  @NoStore()
  @ApiOperation({ summary: 'Count who opened an announcement' })
  @ApiOkResponse({ type: AnnouncementReadCountsView })
  async reads(
    @Param('id', parseId()) id: string,
  ): Promise<AnnouncementReadCountsView> {
    return AnnouncementReadCountsView.from(
      await this.announcements.readCounts(id),
    );
  }

  @Get(':id/delivery')
  @NoStore()
  @ApiOperation({
    summary: 'Count how an announcement reached its audience',
  })
  @ApiOkResponse({ type: AnnouncementDeliveryView })
  async delivery(
    @Param('id', parseId()) id: string,
  ): Promise<AnnouncementDeliveryView> {
    return AnnouncementDeliveryView.from(await this.announcements.delivery(id));
  }

  /** Once ever; a second is ANNOUNCEMENT_ALREADY_REMINDED. */
  @Post(':id/remind')
  @NoStore()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Remind the people who have not opened an announcement',
  })
  @ApiOkResponse({ type: AnnouncementReminderView })
  async remind(
    @Param('id', parseId()) id: string,
  ): Promise<AnnouncementReminderView> {
    return this.announcements.remind(id);
  }
}

/**
 * What is out and put to the caller now (ADR 0040, `community.read`):
 * announcements, and works and closures among them.
 */
@ApiArea('community')
@RequirePermissions('community.read')
@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the announcements put to me' })
  @ApiOkResponse({ type: ListOf(AnnouncementListItemView) })
  async list(
    @Query() q: AnnouncementsQueryDto,
  ): Promise<ListResponse<AnnouncementListItemView>> {
    return toList(
      await this.announcements.feed({ ...q, pinned: q.pinned === 'true' }),
      (a) => AnnouncementListItemView.from(a),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get one announcement put to me' })
  @ApiOkResponse({ type: AnnouncementView })
  async get(@Param('id', parseId()) id: string): Promise<AnnouncementView> {
    return AnnouncementView.from(await this.announcements.one(id));
  }

  @Post(':id/read')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({ summary: 'Mark an announcement as opened' })
  @ApiNoContentResponse()
  async read(@Param('id', parseId()) id: string): Promise<void> {
    await this.announcements.markRead(id);
  }
}

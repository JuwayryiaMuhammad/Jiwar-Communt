import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
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
  AttendeesQueryDto,
  CancelEventDto,
  CreateEventDto,
  RsvpDto,
  StaffEventsQueryDto,
  UpdateEventDto,
} from './dto/events.dto';
import { EventsService } from './events.service';
import {
  AttendeeView,
  EventCreatedView,
  EventListItemView,
  EventView,
  StaffEventListItemView,
  StaffEventView,
} from './views/event.views';

/** The compound's events, for whoever publishes them (ADR 0040). */
@ApiArea('community')
@RequirePermissions('community.publish')
@Controller('community/events')
export class StaffEventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the events' })
  @ApiOkResponse({ type: ListOf(StaffEventListItemView) })
  async list(
    @Query() q: StaffEventsQueryDto,
  ): Promise<ListResponse<StaffEventListItemView>> {
    return toList(await this.events.listForStaff(q), (e) =>
      StaffEventListItemView.from(e),
    );
  }

  @Post()
  @NoStore()
  @ApiOperation({ summary: 'Write an event' })
  @Idempotent()
  @ApiCreatedResponse({ type: EventCreatedView })
  async create(@Body() dto: CreateEventDto): Promise<EventCreatedView> {
    return EventCreatedView.from(await this.events.create(dto));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get one event' })
  @ApiOkResponse({ type: StaffEventView })
  async get(@Param('id', parseId()) id: string): Promise<StaffEventView> {
    return StaffEventView.from(await this.events.getForStaff(id));
  }

  @Patch(':id')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({ summary: 'Change an event that has not started' })
  @ApiNoContentResponse()
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateEventDto,
  ): Promise<void> {
    await this.events.update(id, dto);
  }

  @Post(':id/cancel')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({ summary: 'Cancel an event and tell those who are going' })
  @ApiNoContentResponse()
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: CancelEventDto,
  ): Promise<void> {
    await this.events.cancel(id, dto.reasonCode);
  }

  @Get(':id/attendees')
  @NoStore()
  @ApiOperation({ summary: 'List who answered an event' })
  @ApiOkResponse({ type: ListOf(AttendeeView) })
  async attendees(
    @Param('id', parseId()) id: string,
    @Query() q: AttendeesQueryDto,
  ): Promise<ListResponse<AttendeeView>> {
    return toList(await this.events.attendees(id, q), (a) =>
      AttendeeView.from(a),
    );
  }
}

/** The events put to the caller (ADR 0040, `community.read`). */
@ApiArea('community')
@RequirePermissions('community.read')
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the events put to me that are not over' })
  @ApiOkResponse({ type: ListOf(EventListItemView) })
  async list(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<EventListItemView>> {
    return toList(await this.events.list(q), (e) => EventListItemView.from(e));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get one event put to me' })
  @ApiOkResponse({ type: EventView })
  async get(@Param('id', parseId()) id: string): Promise<EventView> {
    return EventView.from(await this.events.one(id));
  }

  @Put(':id/rsvp')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({ summary: 'Say whether I am going, and with how many guests' })
  @ApiNoContentResponse()
  async rsvp(
    @Param('id', parseId()) id: string,
    @Body() dto: RsvpDto,
  ): Promise<void> {
    await this.events.rsvp(id, dto);
  }
}

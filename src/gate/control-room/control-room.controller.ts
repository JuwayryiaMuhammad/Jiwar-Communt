import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { ControlRoomService } from './control-room.service';
import { ControlRoomQueryDto } from './dto/control-room.dto';
import {
  ControlRoomEventView,
  ControlRoomPostView,
} from './views/control-room.views';

/** The control room (ADR 0068), for `control_room.watch`. */
@ApiArea('control-room')
@RequirePermissions('control_room.watch')
@Controller('staff/control-room')
export class ControlRoomController {
  constructor(private readonly room: ControlRoomService) {}

  @Get('events')
  @ApiOperation({
    summary: 'The control room’s events, newest first',
    description:
      'A guard’s SOS or alarm, a lockdown, the blocklist met at the gate, a field exception, a geofence exit, a device out of sync, a missed gate call. Ids and codes only.',
  })
  @ApiOkResponse({ type: ListOf(ControlRoomEventView) })
  async list(
    @Query() q: ControlRoomQueryDto,
  ): Promise<ListResponse<ControlRoomEventView>> {
    return toList(await this.room.list(q), (r) => ControlRoomEventView.from(r));
  }

  @Get('events/:id')
  @ApiOperation({ summary: 'Get a control room event' })
  @ApiOkResponse({ type: ControlRoomEventView })
  async get(@Param('id', parseId()) id: string): Promise<ControlRoomEventView> {
    return ControlRoomEventView.from(await this.room.get(id));
  }

  @Post('events/:id/acknowledge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Acknowledge an event',
    description:
      'Once: the first acknowledgement wins; another is 409 CONTROL_ROOM_EVENT_ACKNOWLEDGED.',
  })
  @ApiOkResponse({ type: ControlRoomEventView })
  async acknowledge(
    @Param('id', parseId()) id: string,
  ): Promise<ControlRoomEventView> {
    return ControlRoomEventView.from(await this.room.acknowledge(id));
  }

  @Get('posts')
  @ApiOperation({
    summary: 'The posts at a glance',
    description:
      'Each active gate and each zone with a guard on duty: its open shift, whether it is locked down, its waiting field exceptions and open staff SOS.',
  })
  @ApiOkResponse({ type: ListOf(ControlRoomPostView) })
  async posts(): Promise<ListResponse<ControlRoomPostView>> {
    return bounded(await this.room.posts(), (p) => ControlRoomPostView.from(p));
  }
}

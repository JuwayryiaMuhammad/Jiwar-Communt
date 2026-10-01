import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import { ApiArea } from '../common/http/decorators';
import { ListOf, toList, type ListResponse } from '../common/http/list';
import { parseId } from '../common/validation/parse-id.pipe';
import { InboxQueryDto } from './dto/notifications.dto';
import { NotificationsService } from './notifications.service';
import {
  NotificationView,
  ReadAllView,
  UnreadCountView,
} from './views/notification.views';

/** The caller's own inbox (ADR 0027); any signed-in tenant account. */
@ApiArea('notifications')
@Controller('me/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOkResponse({ type: ListOf(NotificationView) })
  async list(
    @Query() q: InboxQueryDto,
  ): Promise<ListResponse<NotificationView>> {
    return toList(
      await this.notifications.mine({ ...q, unread: q.unread === 'true' }),
      (n) => NotificationView.from(n),
    );
  }

  @Get('unread-count')
  @ApiOkResponse({ type: UnreadCountView })
  unreadCount(): Promise<UnreadCountView> {
    return this.notifications.unreadCount();
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ReadAllView })
  async readAll(): Promise<ReadAllView> {
    return { read: await this.notifications.markAllRead() };
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async read(@Param('id', parseId()) id: string): Promise<void> {
    await this.notifications.markRead(id);
  }
}

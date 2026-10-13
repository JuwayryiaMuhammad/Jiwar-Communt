import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
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
import { PostComplaintMessageDto } from './dto/complaints.dto';
import { NoticesService } from './notices.service';
import {
  ComplaintMessageCreatedView,
  ResidentComplaintMessageView,
} from './views/message.views';
import { UnitNoticeView } from './views/notice.views';

/**
 * The notices the management sent to the caller's unit (ADR 0042), and the
 * unit's answers. Addressed by the notice's own id; nothing here names the
 * complaint behind it or who made it. Gated by `units.read`, which whoever
 * answers for a unit holds: receiving a notice does not depend on being
 * allowed to complain. Every answer is no-store.
 */
@ApiArea('neighbours')
@RequirePermissions('units.read')
@Controller('neighbour-notices')
export class UnitNoticesController {
  constructor(private readonly notices: NoticesService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the notices management sent to my unit' })
  @ApiOkResponse({ type: ListOf(UnitNoticeView) })
  async list(): Promise<ListResponse<UnitNoticeView>> {
    return bounded(await this.notices.listMine(), (n) =>
      UnitNoticeView.from(n),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a notice management sent to my unit' })
  @ApiOkResponse({ type: UnitNoticeView })
  async get(@Param('id', parseId()) id: string): Promise<UnitNoticeView> {
    return UnitNoticeView.from(await this.notices.get(id));
  }

  @Get(':id/messages')
  @NoStore()
  @ApiOperation({
    summary: 'Read my unit’s conversation with management on a notice',
  })
  @ApiOkResponse({ type: ListOf(ResidentComplaintMessageView) })
  async thread(
    @Param('id', parseId()) id: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<ResidentComplaintMessageView>> {
    return toList(await this.notices.thread(id, q), (m) =>
      ResidentComplaintMessageView.from(m),
    );
  }

  @Post(':id/messages')
  @NoStore()
  @ApiOperation({ summary: 'Answer management on a notice' })
  @Idempotent()
  @ApiCreatedResponse({ type: ComplaintMessageCreatedView })
  async reply(
    @Param('id', parseId()) id: string,
    @Body() dto: PostComplaintMessageDto,
  ): Promise<ComplaintMessageCreatedView> {
    return ComplaintMessageCreatedView.from(await this.notices.reply(id, dto));
  }
}

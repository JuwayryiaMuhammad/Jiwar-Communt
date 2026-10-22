import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { ApiArea } from '../common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../common/http/list';
import { parseId } from '../common/validation/parse-id.pipe';
import { MyNoticeView } from './formal-notice.views';
import { FormalNotices } from './formal-notices.service';

/** The caller's formal notices (ADR 0058); any signed-in tenant account. */
@ApiArea('me')
@Controller('me/notices')
export class FormalNoticesController {
  constructor(private readonly notices: FormalNotices) {}

  @Get()
  @ApiOperation({ summary: 'List my formal notices' })
  @ApiOkResponse({ type: ListOf(MyNoticeView) })
  async list(@Query() q: PageQueryDto): Promise<ListResponse<MyNoticeView>> {
    return toList(await this.notices.mine(q), (m) => MyNoticeView.from(m));
  }

  /** The first opening is recorded: the notice's read proof. */
  @Get(':id')
  @ApiOperation({ summary: 'Open one of my formal notices' })
  @ApiOkResponse({ type: MyNoticeView })
  async open(@Param('id', parseId()) id: string): Promise<MyNoticeView> {
    return MyNoticeView.from(await this.notices.open(id));
  }
}

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../access/require-permissions.decorator';
import { ApiArea, NoStore } from '../common/http/decorators';
import {
  bounded,
  ListOf,
  toList,
  type ListResponse,
} from '../common/http/list';
import {
  BulkApproveDto,
  StaffInboxQueryDto,
  UpdateInboxSettingsDto,
} from './dto/staff-inbox.dto';
import { StaffInboxService } from './staff-inbox.service';
import {
  BulkOutcomeView,
  InboxCountView,
  InboxItemView,
  InboxSettingView,
} from './staff-inbox.views';

/**
 * The staff inbox (ADR 0073): every item waiting for a decision the caller
 * may take, across the domains. Each type shows to its own permission's
 * holders; the decisions are each domain's own routes.
 */
@ApiArea('staff')
@RequirePermissions('inbox.read')
@Controller('staff/inbox')
export class StaffInboxController {
  constructor(private readonly inbox: StaffInboxService) {}

  @Get()
  @ApiOperation({
    summary: 'List what waits for my decision, oldest first',
    description:
      'Only the types whose permission the caller holds. `authority.decider` is `board` above the type’s threshold (ADR 0055).',
  })
  @NoStore()
  @ApiOkResponse({ type: ListOf(InboxItemView) })
  async list(
    @Query() q: StaffInboxQueryDto,
  ): Promise<ListResponse<InboxItemView>> {
    return toList(
      await this.inbox.list({
        type: q.type,
        overdue: q.overdue === 'true',
        cursor: q.cursor,
        limit: q.limit,
      }),
      (e) => InboxItemView.from(e),
    );
  }

  @Get('count')
  @ApiOperation({ summary: 'Count what waits for me, and what is overdue' })
  @NoStore()
  @ApiOkResponse({ type: InboxCountView })
  async count(): Promise<InboxCountView> {
    return InboxCountView.from(await this.inbox.count());
  }

  @Post('bulk-approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve several items whose approval takes no input',
    description:
      'Each through its own domain’s approval, one at a time; one refused leaves the others (`outcome: failed` with its code). A type that takes input is INVALID_VALUE on `items[i].type`.',
  })
  @NoStore()
  @ApiOkResponse({ type: ListOf(BulkOutcomeView) })
  async bulkApprove(
    @Body() dto: BulkApproveDto,
  ): Promise<ListResponse<BulkOutcomeView>> {
    return bounded(
      await this.inbox.bulkApprove(
        dto.items.map((i) => ({ type: i.type, id: i.id })),
      ),
      (o) => BulkOutcomeView.from(o),
    );
  }

  @Get('settings')
  @ApiOperation({ summary: 'Read every type’s due time' })
  @NoStore()
  @ApiOkResponse({ type: ListOf(InboxSettingView) })
  async settings(): Promise<ListResponse<InboxSettingView>> {
    return bounded(await this.inbox.settings(), (s) =>
      InboxSettingView.from(s),
    );
  }

  @Patch('settings')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Change some types’ due times' })
  @NoStore()
  @ApiOkResponse({ type: ListOf(InboxSettingView) })
  async updateSettings(
    @Body() dto: UpdateInboxSettingsDto,
  ): Promise<ListResponse<InboxSettingView>> {
    return bounded(
      await this.inbox.updateSettings(
        dto.items.map((i) => ({ type: i.type, dueHours: i.dueHours })),
      ),
      (s) => InboxSettingView.from(s),
    );
  }
}

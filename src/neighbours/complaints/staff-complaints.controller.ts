import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
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
import { ComplaintMessagesService } from './complaint-messages.service';
import { ComplaintStatusService } from './complaint-status.service';
import { ComplaintsService } from './complaints.service';
import {
  ComplaintReasonDto,
  PostComplaintMessageDto,
  StaffComplaintsQueryDto,
} from './dto/complaints.dto';
import {
  StaffComplaintDetailView,
  StaffComplaintView,
  UnitComplaintHistoryView,
} from './views/complaint.views';
import {
  ComplaintMessageCreatedView,
  StaffComplaintMessageView,
} from './views/message.views';

/**
 * The staff side of complaints between units (ADR 0042): the inbox, a
 * complaint with the complainant's name, its three threads one at a time,
 * its status, and what there has been against a unit before. Every answer
 * is no-store.
 */
@ApiArea('neighbours')
@RequirePermissions('neighbours.handle')
@Controller('neighbours')
export class StaffComplaintsController {
  constructor(
    private readonly complaints: ComplaintsService,
    private readonly messages: ComplaintMessagesService,
    private readonly status: ComplaintStatusService,
  ) {}

  @Get('complaints')
  @NoStore()
  @ApiOperation({ summary: 'List complaints between units' })
  @ApiOkResponse({ type: ListOf(StaffComplaintView) })
  async list(
    @Query() q: StaffComplaintsQueryDto,
  ): Promise<ListResponse<StaffComplaintView>> {
    return toList(await this.complaints.listForStaff(q), (c) =>
      StaffComplaintView.from(c),
    );
  }

  @Get('complaints/:id')
  @NoStore()
  @ApiOperation({ summary: 'Get a complaint with its history and its notice' })
  @ApiOkResponse({ type: StaffComplaintDetailView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<StaffComplaintDetailView> {
    return StaffComplaintDetailView.fromDetail(
      await this.complaints.detailForStaff(id),
    );
  }

  /** With the author: the complaint's words and its evidence. */
  @Get('complaints/:id/messages')
  @NoStore()
  @ApiOperation({ summary: 'Read the conversation with a complaint’s author' })
  @ApiOkResponse({ type: ListOf(StaffComplaintMessageView) })
  async readAuthor(
    @Param('id', parseId()) id: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<StaffComplaintMessageView>> {
    return toList(
      await this.messages.list(id, 'staff', 'complainant', q),
      (m) => StaffComplaintMessageView.from(m),
    );
  }

  @Post('complaints/:id/messages')
  @NoStore()
  @ApiOperation({ summary: 'Write to a complaint’s author' })
  @Idempotent()
  @ApiCreatedResponse({ type: ComplaintMessageCreatedView })
  async writeAuthor(
    @Param('id', parseId()) id: string,
    @Body() dto: PostComplaintMessageDto,
  ): Promise<ComplaintMessageCreatedView> {
    return ComplaintMessageCreatedView.from(
      await this.messages.post(id, 'staff', 'complainant', dto),
    );
  }

  /** With the unit complained about, once it has its notice (NEIGHBOUR_NOTICE_NOT_SENT before). */
  @Get('complaints/:id/unit-messages')
  @NoStore()
  @ApiOperation({
    summary: 'Read the conversation with the unit complained about',
  })
  @ApiOkResponse({ type: ListOf(StaffComplaintMessageView) })
  async readUnit(
    @Param('id', parseId()) id: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<StaffComplaintMessageView>> {
    return toList(await this.messages.list(id, 'staff', 'target', q), (m) =>
      StaffComplaintMessageView.from(m),
    );
  }

  @Post('complaints/:id/unit-messages')
  @NoStore()
  @ApiOperation({ summary: 'Write to the unit complained about' })
  @Idempotent()
  @ApiCreatedResponse({ type: ComplaintMessageCreatedView })
  async writeUnit(
    @Param('id', parseId()) id: string,
    @Body() dto: PostComplaintMessageDto,
  ): Promise<ComplaintMessageCreatedView> {
    return ComplaintMessageCreatedView.from(
      await this.messages.post(id, 'staff', 'target', dto),
    );
  }

  /** The staff's own: no resident route returns a note or its files. */
  @Get('complaints/:id/notes')
  @NoStore()
  @ApiOperation({ summary: 'Read the staff notes on a complaint' })
  @ApiOkResponse({ type: ListOf(StaffComplaintMessageView) })
  async readNotes(
    @Param('id', parseId()) id: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<StaffComplaintMessageView>> {
    return toList(await this.messages.list(id, 'staff', 'internal', q), (m) =>
      StaffComplaintMessageView.from(m),
    );
  }

  @Post('complaints/:id/notes')
  @NoStore()
  @ApiOperation({ summary: 'Add a staff note to a complaint' })
  @Idempotent()
  @ApiCreatedResponse({ type: ComplaintMessageCreatedView })
  async writeNotes(
    @Param('id', parseId()) id: string,
    @Body() dto: PostComplaintMessageDto,
  ): Promise<ComplaintMessageCreatedView> {
    return ComplaintMessageCreatedView.from(
      await this.messages.post(id, 'staff', 'internal', dto),
    );
  }

  @Post('complaints/:id/review')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Take a complaint under review' })
  @ApiNoContentResponse()
  async review(@Param('id', parseId()) id: string): Promise<void> {
    await this.status.review(id);
  }

  @Post('complaints/:id/mediation')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Put a complaint in mediation' })
  @ApiNoContentResponse()
  async mediate(@Param('id', parseId()) id: string): Promise<void> {
    await this.status.mediate(id);
  }

  @Post('complaints/:id/resolve')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Resolve a complaint' })
  @ApiNoContentResponse()
  async resolve(
    @Param('id', parseId()) id: string,
    @Body() dto: ComplaintReasonDto,
  ): Promise<void> {
    await this.status.resolve(id, dto.reasonCode);
  }

  @Post('complaints/:id/dismiss')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Dismiss a complaint, as unfounded or otherwise' })
  @ApiNoContentResponse()
  async dismiss(
    @Param('id', parseId()) id: string,
    @Body() dto: ComplaintReasonDto,
  ): Promise<void> {
    await this.status.dismiss(id, dto.reasonCode);
  }

  @Get('units/:unitId/complaint-history')
  @NoStore()
  @ApiOperation({
    summary: 'Count the complaints there have been against a unit',
  })
  @ApiOkResponse({ type: UnitComplaintHistoryView })
  async unitHistory(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<UnitComplaintHistoryView> {
    return UnitComplaintHistoryView.from(
      await this.complaints.unitHistory(unitId),
    );
  }
}

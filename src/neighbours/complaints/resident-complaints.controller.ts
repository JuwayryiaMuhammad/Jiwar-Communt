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
  ComplaintsQueryDto,
  CreateComplaintDto,
  PostComplaintMessageDto,
} from './dto/complaints.dto';
import {
  ComplaintCreatedView,
  ResidentComplaintDetailView,
  ResidentComplaintView,
} from './views/complaint.views';
import {
  ComplaintMessageCreatedView,
  ResidentComplaintMessageView,
} from './views/message.views';

/**
 * A resident's complaints against other units (ADR 0042): their own, and
 * only their own. Nothing here names who lives in the unit complained
 * about, and nothing says what it answered. Every answer is no-store.
 */
@ApiArea('neighbours')
@RequirePermissions('neighbours.complain')
@Controller('neighbour-complaints')
export class ResidentComplaintsController {
  constructor(
    private readonly complaints: ComplaintsService,
    private readonly messages: ComplaintMessagesService,
    private readonly status: ComplaintStatusService,
  ) {}

  @Post()
  @NoStore()
  @ApiOperation({ summary: 'Complain about another unit' })
  @Idempotent()
  @ApiCreatedResponse({ type: ComplaintCreatedView })
  async create(@Body() dto: CreateComplaintDto): Promise<ComplaintCreatedView> {
    return ComplaintCreatedView.from(await this.complaints.create(dto));
  }

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List my complaints' })
  @ApiOkResponse({ type: ListOf(ResidentComplaintView) })
  async list(
    @Query() q: ComplaintsQueryDto,
  ): Promise<ListResponse<ResidentComplaintView>> {
    return toList(await this.complaints.listMine(q), (c) =>
      ResidentComplaintView.from(c),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get one of my complaints' })
  @ApiOkResponse({ type: ResidentComplaintDetailView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<ResidentComplaintDetailView> {
    return ResidentComplaintDetailView.fromDetail(
      await this.complaints.detail(id),
    );
  }

  /** The author's own thread: never a staff note, never the unit's thread. */
  @Get(':id/messages')
  @NoStore()
  @ApiOperation({
    summary: 'Read my conversation with management on my complaint',
  })
  @ApiOkResponse({ type: ListOf(ResidentComplaintMessageView) })
  async thread(
    @Param('id', parseId()) id: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<ResidentComplaintMessageView>> {
    return toList(
      await this.messages.list(id, 'author', 'complainant', q),
      (m) => ResidentComplaintMessageView.from(m),
    );
  }

  @Post(':id/messages')
  @NoStore()
  @ApiOperation({ summary: 'Write to management on my complaint' })
  @Idempotent()
  @ApiCreatedResponse({ type: ComplaintMessageCreatedView })
  async post(
    @Param('id', parseId()) id: string,
    @Body() dto: PostComplaintMessageDto,
  ): Promise<ComplaintMessageCreatedView> {
    return ComplaintMessageCreatedView.from(
      await this.messages.post(id, 'author', 'complainant', dto),
    );
  }

  /** Only before the unit complained about has been told anything. */
  @Post(':id/withdraw')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Withdraw my complaint' })
  @ApiNoContentResponse()
  async withdraw(@Param('id', parseId()) id: string): Promise<void> {
    await this.status.withdraw(id);
  }
}

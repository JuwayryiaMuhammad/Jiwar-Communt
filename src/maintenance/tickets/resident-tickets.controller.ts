import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { RequestContext } from '../../core/common/cls/request-context';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { ReasonDto, reasonOf } from '../../core/common/http/reason.dto';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { AttachmentsService } from './attachments.service';
import { ConfirmationService } from './confirmation.service';
import {
  ConfirmDto,
  CreateTicketDto,
  ReasonCodeDto,
  ResidentTicketsQueryDto,
  TicketPhotoDto,
} from './dto/tickets.dto';
import { TicketsService } from './tickets.service';
import {
  PhotoAddedView,
  ResidentTicketDetailView,
  ResidentTicketView,
  TicketCreatedView,
} from './views/ticket.views';

/**
 * A resident's tickets (ADR 0032): `tickets.create`, and the `tickets`
 * capability on the unit decides the rest.
 */
@ApiArea('tickets')
@RequirePermissions('tickets.create')
@Controller('tickets')
export class ResidentTicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly attachments: AttachmentsService,
    private readonly confirmation: ConfirmationService,
    private readonly ctx: RequestContext,
  ) {}

  @Post()
  @Idempotent()
  @ApiCreatedResponse({ type: TicketCreatedView })
  async create(@Body() dto: CreateTicketDto): Promise<TicketCreatedView> {
    return TicketCreatedView.from(await this.tickets.create(dto));
  }

  @Get()
  @ApiOkResponse({ type: ListOf(ResidentTicketView) })
  async list(
    @Query() q: ResidentTicketsQueryDto,
  ): Promise<ListResponse<ResidentTicketView>> {
    const me = this.ctx.accountId;
    return toList(await this.tickets.listForResident(q), (r) =>
      ResidentTicketView.from(r, me),
    );
  }

  /** No-store: the photos are presigned URLs. */
  @Get(':id')
  @NoStore()
  @ApiOkResponse({ type: ResidentTicketDetailView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<ResidentTicketDetailView> {
    return ResidentTicketDetailView.fromDetail(
      await this.tickets.detail(id, 'resident'),
      this.ctx.accountId,
    );
  }

  @Post(':id/photos')
  @ApiCreatedResponse({ type: PhotoAddedView })
  async addPhoto(
    @Param('id', parseId()) id: string,
    @Body() dto: TicketPhotoDto,
  ): Promise<PhotoAddedView> {
    return PhotoAddedView.from(
      await this.attachments.addReport(id, dto.fileId),
    );
  }

  /** Before the work starts; `reasonCode` from `ticketCancel`. */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<void> {
    return this.confirmation.cancelByReporter(id, dto.reasonCode);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  confirm(
    @Param('id', parseId()) id: string,
    @Body() dto: ConfirmDto,
  ): Promise<void> {
    return this.confirmation.confirm(id, dto.rating, dto.comment);
  }

  /**
   * `reasonCode` from `ticketReject`; `reason` is the note, posted to the
   * ticket's thread for the technician.
   */
  @Post(':id/reject')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  reject(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<void> {
    return this.confirmation.reject(id, reasonOf(dto));
  }

  /** Within the compound's `reopenDays`; as a rejection. */
  @Post(':id/reopen')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  reopen(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<void> {
    return this.confirmation.reopen(id, reasonOf(dto));
  }
}

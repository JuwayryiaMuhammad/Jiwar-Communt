import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { RequestContext } from '../../core/common/cls/request-context';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { AttachmentsService } from './attachments.service';
import {
  CreateTicketDto,
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
}

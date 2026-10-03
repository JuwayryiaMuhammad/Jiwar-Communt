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
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { AttachmentsService } from './attachments.service';
import {
  HoldDto,
  ReasonCodeDto,
  TechnicianTicketsQueryDto,
  WorkPhotoDto,
} from './dto/tickets.dto';
import { TicketsService } from './tickets.service';
import {
  PhotoAddedView,
  TechnicianTicketDetailView,
  TechnicianTicketView,
} from './views/ticket.views';
import { WorkService } from './work.service';

/**
 * The technician's own tickets (ADR 0032): only those assigned to them now.
 * Anything else, including one they declined or lost to a reassignment, is
 * TICKET_NOT_FOUND.
 */
@ApiArea('technician')
@RequirePermissions('tickets.work')
@Controller('technician/tickets')
export class TechnicianTicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly work: WorkService,
    private readonly attachments: AttachmentsService,
  ) {}

  @Get()
  @ApiOkResponse({ type: ListOf(TechnicianTicketView) })
  async list(
    @Query() q: TechnicianTicketsQueryDto,
  ): Promise<ListResponse<TechnicianTicketView>> {
    return toList(await this.tickets.listForTechnician(q), (r) =>
      TechnicianTicketView.from(r),
    );
  }

  /** No-store: the photos are presigned URLs. */
  @Get(':id')
  @NoStore()
  @ApiOkResponse({ type: TechnicianTicketDetailView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<TechnicianTicketDetailView> {
    return TechnicianTicketDetailView.fromDetail(
      await this.tickets.detail(id, 'technician'),
    );
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  start(@Param('id', parseId()) id: string): Promise<void> {
    return this.work.start(id);
  }

  @Post(':id/hold')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  hold(
    @Param('id', parseId()) id: string,
    @Body() dto: HoldDto,
  ): Promise<void> {
    return this.work.hold(id, dto.holdReason);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  resume(@Param('id', parseId()) id: string): Promise<void> {
    return this.work.resume(id);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  complete(@Param('id', parseId()) id: string): Promise<void> {
    return this.work.complete(id);
  }

  /** `reasonCode` from the closed list `ticketDecline`. */
  @Post(':id/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  decline(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<void> {
    return this.work.decline(id, dto.reasonCode);
  }

  @Post(':id/photos')
  @ApiCreatedResponse({ type: PhotoAddedView })
  async addPhoto(
    @Param('id', parseId()) id: string,
    @Body() dto: WorkPhotoDto,
  ): Promise<PhotoAddedView> {
    return PhotoAddedView.from(
      await this.attachments.addWork(id, dto.fileId, dto.kind),
    );
  }
}

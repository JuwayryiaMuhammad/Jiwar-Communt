import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
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
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { ReasonCodeDto } from '../tickets/dto/tickets.dto';
import {
  VisitReceiverDto,
  VisitRescheduleDto,
  VisitSlotsQueryDto,
  VisitWindowDto,
} from './dto/visits.dto';
import { VisitConsentService } from './visit-consent.service';
import {
  DispatchVisitView,
  ResidentVisitView,
  TechnicianVisitView,
  UnitVisitView,
  VisitCreatedView,
  VisitEventView,
  VisitSlotView,
} from './views/visit.views';
import { VisitsService } from './visits.service';

// ============================================================================
// Visits (ADR 0034). Every read is no-store: a window says when a home may
// be empty. Common-area tickets have none (409 VISIT_NOT_FOR_COMMON_AREA).
// ============================================================================

/**
 * The residents' side: those who see the ticket and may still act on it,
 * or any adult who lives in its unit (`visitConsent`).
 */
@ApiArea('tickets')
@RequirePermissions('tickets.create')
@Controller('tickets')
export class ResidentVisitsController {
  constructor(
    private readonly visits: VisitsService,
    private readonly consent: VisitConsentService,
    private readonly ctx: RequestContext,
  ) {}

  @Get(':id/visits')
  @NoStore()
  @ApiOkResponse({ type: ListOf(ResidentVisitView) })
  async list(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<ResidentVisitView>> {
    const me = this.ctx.accountId;
    return bounded(await this.visits.list(id, 'resident'), (r) =>
      ResidentVisitView.from(r, me),
    );
  }

  /**
   * Free windows to counter or reschedule with (ADR 0038): the compound's
   * visiting hours minus the technician's other visits, oldest first.
   * No-store like every visit read.
   */
  @Get(':id/visit-slots')
  @NoStore()
  @ApiOkResponse({ type: ListOf(VisitSlotView) })
  async slots(
    @Param('id', parseId()) id: string,
    @Query() q: VisitSlotsQueryDto,
  ): Promise<ListResponse<VisitSlotView>> {
    return bounded(await this.visits.slots(id, q), (s) =>
      VisitSlotView.from(s),
    );
  }

  /** The technician's proposal, agreed. */
  @Post(':id/visits/:visitId/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  confirm(
    @Param('id', parseId()) id: string,
    @Param('visitId', parseId('visitId')) visitId: string,
  ): Promise<void> {
    return this.visits.confirm(id, visitId, 'resident');
  }

  /** Another window instead of the technician's proposal. */
  @Post(':id/visits/:visitId/counter')
  @ApiCreatedResponse({ type: VisitCreatedView })
  async counter(
    @Param('id', parseId()) id: string,
    @Param('visitId', parseId('visitId')) visitId: string,
    @Body() dto: VisitWindowDto,
  ): Promise<VisitCreatedView> {
    return VisitCreatedView.from(
      await this.visits.counter(id, visitId, dto, 'resident'),
    );
  }

  /** A confirmed window moves; `reasonCode` from `visitChange`. */
  @Post(':id/visits/:visitId/reschedule')
  @ApiCreatedResponse({ type: VisitCreatedView })
  async reschedule(
    @Param('id', parseId()) id: string,
    @Param('visitId', parseId('visitId')) visitId: string,
    @Body() dto: VisitRescheduleDto,
  ): Promise<VisitCreatedView> {
    return VisitCreatedView.from(
      await this.visits.reschedule(
        id,
        visitId,
        dto,
        dto.reasonCode,
        'resident',
      ),
    );
  }

  /** `reasonCode` from `visitChange`. */
  @Post(':id/visits/:visitId/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  cancel(
    @Param('id', parseId()) id: string,
    @Param('visitId', parseId('visitId')) visitId: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<void> {
    return this.visits.cancel(id, visitId, dto.reasonCode, 'resident');
  }

  /**
   * The technician is really at the door (ADR 0038): once, on an arrived
   * visit; the technician is told.
   */
  @Post(':id/visits/:visitId/confirm-arrival')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  confirmArrival(
    @Param('id', parseId()) id: string,
    @Param('visitId', parseId('visitId')) visitId: string,
  ): Promise<void> {
    return this.visits.confirmArrival(id, visitId);
  }

  /**
   * The technician may enter while nobody is home, for this visit only: an
   * adult who lives there, on a confirmed visit. Not implied by confirming.
   */
  @Post(':id/visits/:visitId/absence-consent')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  grantConsent(
    @Param('id', parseId()) id: string,
    @Param('visitId', parseId('visitId')) visitId: string,
  ): Promise<void> {
    return this.consent.grant(id, visitId);
  }

  /** Until the technician arrives. */
  @Delete(':id/visits/:visitId/absence-consent')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  revokeConsent(
    @Param('id', parseId()) id: string,
    @Param('visitId', parseId('visitId')) visitId: string,
  ): Promise<void> {
    return this.consent.revoke(id, visitId);
  }

  /** Who lets the technician in, on a confirmed visit. */
  @Put(':id/visits/:visitId/receiver')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  setReceiver(
    @Param('id', parseId()) id: string,
    @Param('visitId', parseId('visitId')) visitId: string,
    @Body() dto: VisitReceiverDto,
  ): Promise<void> {
    return this.consent.setReceiver(
      id,
      visitId,
      dto.accountId !== undefined
        ? { accountId: dto.accountId }
        : { engagementId: dto.engagementId! },
    );
  }

  @Delete(':id/visits/:visitId/receiver')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  clearReceiver(
    @Param('id', parseId()) id: string,
    @Param('visitId', parseId('visitId')) visitId: string,
  ): Promise<void> {
    return this.consent.clearReceiver(id, visitId);
  }
}

/** The technician's own visits, on the tickets assigned to them now. */
@ApiArea('technician')
@RequirePermissions('tickets.work')
@Controller('technician/tickets')
export class TechnicianVisitsController {
  constructor(private readonly visits: VisitsService) {}

  @Get(':id/visits')
  @NoStore()
  @ApiOkResponse({ type: ListOf(TechnicianVisitView) })
  async list(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<TechnicianVisitView>> {
    return bounded(await this.visits.list(id, 'technician'), (r) =>
      TechnicianVisitView.from(r),
    );
  }

  /** A window for the residents to confirm; none may be active. */
  @Post(':id/visits')
  @ApiCreatedResponse({ type: VisitCreatedView })
  async propose(
    @Param('id', parseId()) id: string,
    @Body() dto: VisitWindowDto,
  ): Promise<VisitCreatedView> {
    return VisitCreatedView.from(
      await this.visits.propose(id, dto, 'technician'),
    );
  }

  /** The residents' counter-proposal, agreed. */
  @Post(':id/visits/:visitId/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  confirm(
    @Param('id', parseId()) id: string,
    @Param('visitId', parseId('visitId')) visitId: string,
  ): Promise<void> {
    return this.visits.confirm(id, visitId, 'technician');
  }

  @Post(':id/visits/:visitId/counter')
  @ApiCreatedResponse({ type: VisitCreatedView })
  async counter(
    @Param('id', parseId()) id: string,
    @Param('visitId', parseId('visitId')) visitId: string,
    @Body() dto: VisitWindowDto,
  ): Promise<VisitCreatedView> {
    return VisitCreatedView.from(
      await this.visits.counter(id, visitId, dto, 'technician'),
    );
  }

  @Post(':id/visits/:visitId/reschedule')
  @ApiCreatedResponse({ type: VisitCreatedView })
  async reschedule(
    @Param('id', parseId()) id: string,
    @Param('visitId', parseId('visitId')) visitId: string,
    @Body() dto: VisitRescheduleDto,
  ): Promise<VisitCreatedView> {
    return VisitCreatedView.from(
      await this.visits.reschedule(
        id,
        visitId,
        dto,
        dto.reasonCode,
        'technician',
      ),
    );
  }

  @Post(':id/visits/:visitId/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  cancel(
    @Param('id', parseId()) id: string,
    @Param('visitId', parseId('visitId')) visitId: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<void> {
    return this.visits.cancel(id, visitId, dto.reasonCode, 'technician');
  }

  /**
   * At the door, within the window. The answer says whether entry while
   * nobody is home was allowed, as of this moment.
   */
  @Post(':id/visits/:visitId/arrive')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOkResponse({ type: TechnicianVisitView })
  async arrive(
    @Param('id', parseId()) id: string,
    @Param('visitId', parseId('visitId')) visitId: string,
  ): Promise<TechnicianVisitView> {
    return TechnicianVisitView.from(await this.visits.arrive(id, visitId));
  }

  @Post(':id/visits/:visitId/done')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  done(
    @Param('id', parseId()) id: string,
    @Param('visitId', parseId('visitId')) visitId: string,
  ): Promise<void> {
    return this.visits.done(id, visitId);
  }

  /** Nobody let them in: the ticket waits for the residents. */
  @Post(':id/visits/:visitId/no-access')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  noAccess(
    @Param('id', parseId()) id: string,
    @Param('visitId', parseId('visitId')) visitId: string,
  ): Promise<void> {
    return this.visits.noAccess(id, visitId);
  }
}

/** Dispatch: every visit, and the technician's side on their behalf. */
@ApiArea('maintenance')
@RequirePermissions('tickets.dispatch')
@Controller('maintenance/tickets')
export class DispatchVisitsController {
  constructor(private readonly visits: VisitsService) {}

  @Get(':id/visits')
  @NoStore()
  @ApiOkResponse({ type: ListOf(DispatchVisitView) })
  async list(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<DispatchVisitView>> {
    return bounded(await this.visits.list(id, 'dispatch'), (r) =>
      DispatchVisitView.from(r),
    );
  }

  /** What happened to the ticket's visits and who did it; never a window. */
  @Get(':id/visit-events')
  @ApiOkResponse({ type: ListOf(VisitEventView) })
  async events(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<VisitEventView>> {
    return bounded(VisitEventView.list(await this.visits.events(id)), (e) => e);
  }

  /** For the ticket's technician. */
  @Post(':id/visits')
  @ApiCreatedResponse({ type: VisitCreatedView })
  async propose(
    @Param('id', parseId()) id: string,
    @Body() dto: VisitWindowDto,
  ): Promise<VisitCreatedView> {
    return VisitCreatedView.from(
      await this.visits.propose(id, dto, 'dispatch'),
    );
  }

  @Post(':id/visits/:visitId/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  confirm(
    @Param('id', parseId()) id: string,
    @Param('visitId', parseId('visitId')) visitId: string,
  ): Promise<void> {
    return this.visits.confirm(id, visitId, 'dispatch');
  }

  @Post(':id/visits/:visitId/counter')
  @ApiCreatedResponse({ type: VisitCreatedView })
  async counter(
    @Param('id', parseId()) id: string,
    @Param('visitId', parseId('visitId')) visitId: string,
    @Body() dto: VisitWindowDto,
  ): Promise<VisitCreatedView> {
    return VisitCreatedView.from(
      await this.visits.counter(id, visitId, dto, 'dispatch'),
    );
  }

  @Post(':id/visits/:visitId/reschedule')
  @ApiCreatedResponse({ type: VisitCreatedView })
  async reschedule(
    @Param('id', parseId()) id: string,
    @Param('visitId', parseId('visitId')) visitId: string,
    @Body() dto: VisitRescheduleDto,
  ): Promise<VisitCreatedView> {
    return VisitCreatedView.from(
      await this.visits.reschedule(
        id,
        visitId,
        dto,
        dto.reasonCode,
        'dispatch',
      ),
    );
  }

  @Post(':id/visits/:visitId/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  cancel(
    @Param('id', parseId()) id: string,
    @Param('visitId', parseId('visitId')) visitId: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<void> {
    return this.visits.cancel(id, visitId, dto.reasonCode, 'dispatch');
  }
}

/**
 * The visits coming to one of the caller's units: for an adult who lives
 * there (`visitConsent`), without the tickets themselves.
 */
@ApiArea('me')
@RequirePermissions('tickets.create')
@Controller('me/units')
export class UnitVisitsController {
  constructor(
    private readonly visits: VisitsService,
    private readonly ctx: RequestContext,
  ) {}

  @Get(':unitId/visits')
  @NoStore()
  @ApiOkResponse({ type: ListOf(UnitVisitView) })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<ListResponse<UnitVisitView>> {
    const me = this.ctx.accountId;
    return bounded(await this.visits.forUnit(unitId), (r) =>
      UnitVisitView.from(r, me),
    );
  }
}

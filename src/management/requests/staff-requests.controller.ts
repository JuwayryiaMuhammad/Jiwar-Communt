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
  bounded,
  ListOf,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  AssignRequestDto,
  CreateRequestOnBehalfDto,
  StaffRequestsQueryDto,
} from './dto/requests.dto';
import { RequestsService } from './requests.service';
import {
  RequestCreatedView,
  RequestPersonView,
  StaffRequestListItemView,
  StaffRequestView,
} from './views/request.views';

/**
 * The compound's requests, for whoever handles them (ADR 0039,
 * `requests.handle`). Every answer here is no-store.
 */
@ApiArea('management-requests')
@RequirePermissions('requests.handle')
@Controller('management/requests')
export class StaffRequestsController {
  constructor(private readonly requests: RequestsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the requests to the management' })
  @ApiOkResponse({ type: ListOf(StaffRequestListItemView) })
  async list(
    @Query() q: StaffRequestsQueryDto,
  ): Promise<ListResponse<StaffRequestListItemView>> {
    return toList(
      await this.requests.listForStaff({
        ...q,
        overdue: q.overdue === 'true',
        escalated: q.escalated === 'true',
      }),
      (r) => StaffRequestListItemView.fromInbox(r),
    );
  }

  /**
   * A request opened for a resident: audited with its reason code, and the
   * resident is its author. It names a resident, so `requests.handle` alone
   * is not enough: the caller also holds `residents.read`.
   */
  @Post()
  @NoStore()
  @RequirePermissions('requests.handle', 'residents.read')
  @ApiOperation({ summary: 'Open a request for a resident' })
  @Idempotent()
  @ApiCreatedResponse({ type: RequestCreatedView })
  async create(
    @Body() dto: CreateRequestOnBehalfDto,
  ): Promise<RequestCreatedView> {
    return RequestCreatedView.from(await this.requests.createOnBehalf(dto));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get one request to the management' })
  @ApiOkResponse({ type: StaffRequestView })
  async get(@Param('id', parseId()) id: string): Promise<StaffRequestView> {
    return StaffRequestView.from(await this.requests.detail(id, 'staff'));
  }

  @Post(':id/assign')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({ summary: 'Assign a request, or return it to the queue' })
  @ApiNoContentResponse()
  async assign(
    @Param('id', parseId()) id: string,
    @Body() dto: AssignRequestDto,
  ): Promise<void> {
    await this.requests.assign(id, dto.assigneeId);
  }
}

/** Who a request may be given to: the handlers of the compound. */
@ApiArea('management-requests')
@RequirePermissions('requests.handle')
@Controller('management/request-assignees')
export class RequestAssigneesController {
  constructor(private readonly requests: RequestsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List who a request may be assigned to' })
  @ApiOkResponse({ type: ListOf(RequestPersonView) })
  async list(): Promise<ListResponse<RequestPersonView>> {
    return bounded(await this.requests.assignees(), (p) => ({
      id: p.id,
      fullName: p.fullName,
    }));
  }
}

/**
 * What staff read about a unit to open a request for one of its people. It
 * names residents: `requests.handle` and `residents.read`.
 */
@ApiArea('management-requests')
@RequirePermissions('requests.handle', 'residents.read')
@Controller('management/units')
export class RequestUnitsController {
  constructor(private readonly requests: RequestsService) {}

  /**
   * The unit's active resident and family accounts: exactly whom
   * `POST /management/requests` accepts as `authorAccountId` with this
   * unit.
   */
  @Get(':unitId/request-authors')
  @NoStore()
  @ApiOperation({ summary: 'List who a request may be opened for in a unit' })
  @ApiOkResponse({ type: ListOf(RequestPersonView) })
  async authors(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<ListResponse<RequestPersonView>> {
    return bounded(await this.requests.authorsOf(unitId), (a) => ({
      id: a.id,
      fullName: a.fullName,
    }));
  }
}

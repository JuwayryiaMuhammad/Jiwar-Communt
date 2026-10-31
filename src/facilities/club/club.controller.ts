import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
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
import { ClubRequestsService } from './club-requests.service';
import { ClubService } from './club.service';
import {
  CancelClubRequestDto,
  ClubMembershipsQueryDto,
  ClubRequestsQueryDto,
  ClubUnitQueryDto,
  CreateClubRequestDto,
  CreateClubMembershipDto,
  CreateClubPlanDto,
  RecordClubPaymentDto,
  ReplaceClubPeopleDto,
  ReverseClubPaymentDto,
  UpdateClubPlanDto,
} from './dto/club.dto';
import {
  ClubMembershipDetailView,
  ClubMembershipView,
  ClubPaymentView,
  ClubPersonView,
  ClubPlanOptionView,
  ClubPlanView,
  ClubUnitView,
  MyClubMembershipView,
  MyClubView,
} from './views/club.views';
import {
  ClubRequestView,
  StaffClubRequestView,
} from './views/club-request.views';

/** The club as residents see it (ADR 0044). */
@ApiArea('club')
@RequirePermissions('facilities.book')
@Controller()
export class ResidentClubController {
  constructor(private readonly club: ClubService) {}

  @Get('club/plans')
  @NoStore()
  @ApiOperation({ summary: 'List the club’s plans' })
  @ApiOkResponse({ type: ListOf(ClubPlanOptionView) })
  async plans(): Promise<ListResponse<ClubPlanOptionView>> {
    return bounded(await this.club.plans(true), (p) =>
      ClubPlanOptionView.from(p),
    );
  }

  @Get('units/:unitId/club-membership')
  @NoStore()
  @ApiOperation({
    summary: 'Get the unit’s club membership',
    description:
      'Whoever sees the household; its payments for whoever sees the unit’s money.',
  })
  @ApiOkResponse({ type: MyClubView })
  async mine(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<MyClubView> {
    const { file, payments, me } = await this.club.forUnit(unitId);
    return {
      membership: file && MyClubMembershipView.from(file, me, payments),
    };
  }
}

/** The club's plans, for the staff (ADR 0044). */
@ApiArea('club')
@Controller('staff/club-plans')
export class ClubPlansController {
  constructor(private readonly club: ClubService) {}

  @Get()
  @NoStore()
  @RequireAnyPermission('facilities.manage', 'club.billing')
  @ApiOperation({ summary: 'List every club plan, retired ones included' })
  @ApiOkResponse({ type: ListOf(ClubPlanView) })
  async list(): Promise<ListResponse<ClubPlanView>> {
    return bounded(await this.club.plans(false), (p) => ClubPlanView.from(p));
  }

  @Post()
  @NoStore()
  @RequirePermissions('facilities.manage')
  @ApiOperation({ summary: 'Create a club plan' })
  @Idempotent()
  @ApiCreatedResponse({ type: ClubPlanView })
  async create(@Body() dto: CreateClubPlanDto): Promise<ClubPlanView> {
    return ClubPlanView.from(await this.club.createPlan(dto));
  }

  @Patch(':id')
  @NoStore()
  @RequirePermissions('facilities.manage')
  @ApiOperation({ summary: 'Update a club plan' })
  @ApiOkResponse({ type: ClubPlanView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateClubPlanDto,
  ): Promise<ClubPlanView> {
    return ClubPlanView.from(await this.club.updatePlan(id, dto));
  }
}

/** Memberships and the payments made at the office, for the accountant (ADR 0044). */
@ApiArea('club')
@RequirePermissions('club.billing')
@Controller('staff')
export class ClubMembershipsController {
  constructor(private readonly club: ClubService) {}

  @Get('club/units')
  @NoStore()
  @ApiOperation({
    summary: 'Find a unit by its code, with its membership if any',
  })
  @ApiOkResponse({ type: ClubUnitView })
  async unit(@Query() q: ClubUnitQueryDto): Promise<ClubUnitView> {
    return this.club.findUnit(q.code);
  }

  @Get('club/units/:unitId/people')
  @NoStore()
  @ApiOperation({ summary: 'List the unit’s people a membership may cover' })
  @ApiOkResponse({ type: ListOf(ClubPersonView) })
  async people(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<ListResponse<ClubPersonView>> {
    return bounded(await this.club.unitPeople(unitId), (p) =>
      ClubPersonView.from(p),
    );
  }

  @Get('club-memberships')
  @NoStore()
  @ApiOperation({ summary: 'List the club memberships, by state' })
  @ApiOkResponse({ type: ListOf(ClubMembershipView) })
  async list(
    @Query() q: ClubMembershipsQueryDto,
  ): Promise<ListResponse<ClubMembershipView>> {
    return bounded(await this.club.list(q.state), (f) =>
      ClubMembershipView.from(f),
    );
  }

  @Get('club-memberships/:id')
  @NoStore()
  @ApiOperation({ summary: 'Get a club membership with its payments' })
  @ApiOkResponse({ type: ClubMembershipDetailView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<ClubMembershipDetailView> {
    return ClubMembershipDetailView.detail(await this.club.get(id));
  }

  @Post('club-memberships')
  @NoStore()
  @ApiOperation({ summary: 'Create a unit’s club membership' })
  @Idempotent()
  @ApiCreatedResponse({ type: ClubMembershipDetailView })
  async create(
    @Body() dto: CreateClubMembershipDto,
  ): Promise<ClubMembershipDetailView> {
    return ClubMembershipDetailView.detail(
      await this.club.create(dto.unitId, dto.people),
    );
  }

  @Put('club-memberships/:id/people')
  @NoStore()
  @ApiOperation({ summary: 'Replace whom a club membership covers' })
  @ApiOkResponse({ type: ClubMembershipDetailView })
  async replacePeople(
    @Param('id', parseId()) id: string,
    @Body() dto: ReplaceClubPeopleDto,
  ): Promise<ClubMembershipDetailView> {
    return ClubMembershipDetailView.detail(
      await this.club.replacePeople(id, dto.people),
    );
  }

  @Post('club-memberships/:id/payments')
  @NoStore()
  @ApiOperation({
    summary: 'Record a payment made at the office',
    description:
      'Pays for a period of the plan from the day it was paid, or from where the last period paid for ends.',
  })
  @Idempotent()
  @ApiCreatedResponse({ type: ClubPaymentView })
  async record(
    @Param('id', parseId()) id: string,
    @Body() dto: RecordClubPaymentDto,
  ): Promise<ClubPaymentView> {
    return ClubPaymentView.from(await this.club.record(id, dto), false);
  }

  @Post('club-payments/:id/reverse')
  @NoStore()
  @ApiOperation({ summary: 'Reverse a payment, once, with a reason code' })
  @Idempotent()
  @ApiCreatedResponse({ type: ClubPaymentView })
  async reverse(
    @Param('id', parseId()) id: string,
    @Body() dto: ReverseClubPaymentDto,
  ): Promise<ClubPaymentView> {
    return ClubPaymentView.from(
      await this.club.reverse(id, dto.reasonCode),
      false,
    );
  }
}

/**
 * Club membership requests (ADR 0070): a plan asked for, its price owed
 * through the unit's invoices, the membership started or extended once
 * paid.
 */
@ApiArea('club')
@RequirePermissions('facilities.book')
@Controller()
export class ResidentClubRequestsController {
  constructor(private readonly requests: ClubRequestsService) {}

  @Post('units/:unitId/club-membership/requests')
  @NoStore()
  @ApiOperation({
    summary: 'Ask for a club plan',
    description:
      'Whoever books for the unit: an active plan (PLAN_NOT_AVAILABLE), one request open per unit (CLUB_REQUEST_OPEN). Its price is owed at once through a `club` invoice of the unit’s, due in a week; once paid, the membership starts, or is extended from where it ends.',
  })
  @Idempotent()
  @ApiCreatedResponse({ type: ClubRequestView })
  async create(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: CreateClubRequestDto,
  ): Promise<ClubRequestView> {
    return ClubRequestView.from(
      await this.requests.request(unitId, dto.planId),
    );
  }

  @Get('units/:unitId/club-membership/requests')
  @NoStore()
  @ApiOperation({
    summary: 'List the unit’s club membership requests',
    description:
      'Newest first: every one for the unit’s primary, the caller’s own for anyone else.',
  })
  @ApiOkResponse({ type: ListOf(ClubRequestView) })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<ClubRequestView>> {
    return toList(await this.requests.forUnit(unitId, q), (r) =>
      ClubRequestView.from(r),
    );
  }

  @Post('club-membership-requests/:id/cancel')
  @NoStore()
  @ApiOperation({
    summary: 'Call off a club membership request',
    description:
      'Its requester or the unit’s primary, until it is paid (CLUB_REQUEST_CLOSED): its invoice is credited off.',
  })
  @ApiOkResponse({ type: ClubRequestView })
  @HttpCode(200)
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: CancelClubRequestDto,
  ): Promise<ClubRequestView> {
    return ClubRequestView.from(await this.requests.cancel(id, dto.reasonCode));
  }
}

/** The club's staff see every request and where it stands (ADR 0070). */
@ApiArea('club')
@RequirePermissions('club.billing')
@Controller('staff/club/requests')
export class StaffClubRequestsController {
  constructor(private readonly requests: ClubRequestsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List club membership requests, newest first' })
  @ApiOkResponse({ type: ListOf(StaffClubRequestView) })
  async list(
    @Query() q: ClubRequestsQueryDto,
  ): Promise<ListResponse<StaffClubRequestView>> {
    return toList(await this.requests.list(q), (r) =>
      StaffClubRequestView.fromStaff(r),
    );
  }
}

import {
  Body,
  Controller,
  Get,
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
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ClubService } from './club.service';
import {
  ClubMembershipsQueryDto,
  ClubUnitQueryDto,
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

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
import {
  bounded,
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { ReasonDto, reasonOf } from '../../core/common/http/reason.dto';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  MajorityInviteDto,
  NewInviteDto,
  NewMinorDto,
} from './dto/household.dto';
import { HouseholdsService } from './households.service';
import {
  CreatedInviteView,
  HouseholdMemberResponse,
  HouseholdResponse,
  PendingMemberView,
} from './views/household.views';

/** A unit's household (ADR 0016): the primary or a delegate; managers approve. */
@ApiArea('household')
@Controller()
export class HouseholdController {
  constructor(private readonly households: HouseholdsService) {}

  /** Members for everyone who sees the household; grants and invites for its managers. */
  @RequirePermissions('units.read')
  @Get('units/:unitId/household')
  @ApiOkResponse({ type: HouseholdResponse })
  async household(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<HouseholdResponse> {
    return HouseholdResponse.from(await this.households.household(unitId));
  }

  /** The token is shown once; the invitee accepts with a code sent to the email. */
  @RequirePermissions('household.manage')
  @Post('units/:unitId/household/invites')
  @NoStore()
  @ApiCreatedResponse({ type: CreatedInviteView })
  async invite(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: NewInviteDto,
  ): Promise<CreatedInviteView> {
    return CreatedInviteView.from(
      await this.households.createInvite(unitId, dto),
    );
  }

  @RequirePermissions('household.manage')
  @Post('household/invites/:id/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async revokeInvite(@Param('id', parseId()) id: string): Promise<void> {
    await this.households.revokeInvite(id);
  }

  @RequirePermissions('household.manage')
  @Post('units/:unitId/household/minors')
  @ApiCreatedResponse({ type: HouseholdMemberResponse })
  async addMinor(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: NewMinorDto,
  ): Promise<HouseholdMemberResponse> {
    return HouseholdMemberResponse.from(
      await this.households.addMinor(unitId, dto),
    );
  }

  /** Minors who are 18 today in the compound's time zone (the primary only). */
  @RequirePermissions('household.manage')
  @Get('units/:unitId/household/minors-ready')
  @ApiOkResponse({ type: ListOf(HouseholdMemberResponse) })
  async minorsReady(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<ListResponse<HouseholdMemberResponse>> {
    return bounded(await this.households.minorsReadyToConfirm(unitId), (m) =>
      HouseholdMemberResponse.from(m),
    );
  }

  /** An account of their own, linked to the same membership (the primary only). */
  @RequirePermissions('household.manage')
  @Post('household/members/:id/majority-invite')
  @NoStore()
  @ApiCreatedResponse({ type: CreatedInviteView })
  async majorityInvite(
    @Param('id', parseId()) id: string,
    @Body() dto: MajorityInviteDto,
  ): Promise<CreatedInviteView> {
    return CreatedInviteView.from(
      await this.households.inviteMemberToAdulthood(id, dto),
    );
  }

  /** The member is told, with the reason text. */
  @RequirePermissions('household.manage')
  @Post('household/members/:id/remove')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async remove(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<void> {
    await this.households.removeMember(id, reasonOf(dto));
  }

  /** Memberships waiting for approval, oldest first. */
  @RequirePermissions('household.approve')
  @Get('household/pending')
  @ApiOkResponse({ type: ListOf(PendingMemberView) })
  async pending(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<PendingMemberView>> {
    return toList(await this.households.pendingApprovals(q), (p) =>
      PendingMemberView.from(p),
    );
  }

  @RequirePermissions('household.approve')
  @Post('household/members/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: HouseholdMemberResponse })
  async approve(
    @Param('id', parseId()) id: string,
  ): Promise<HouseholdMemberResponse> {
    return HouseholdMemberResponse.from(
      await this.households.approveMember(id),
    );
  }

  @RequirePermissions('household.approve')
  @Post('household/members/:id/reject')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async reject(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<void> {
    await this.households.rejectMember(id, reasonOf(dto));
  }

  /** During a separation, removal is the manager's decision (ADR 0021). */
  @RequirePermissions('household.override')
  @Post('household/members/:id/remove-by-management')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async removeByManagement(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<void> {
    await this.households.removeMemberByManagement(id, reasonOf(dto));
  }
}

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
  ApiOperation,
} from '@nestjs/swagger';
import { PermissionsService } from '../../core/access/permissions.service';
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
import { KinshipDocuments } from './kinship-documents';
import {
  CreatedInviteView,
  HouseholdMemberResponse,
  HouseholdResponse,
  PendingMemberView,
  KinshipDocumentReadView,
} from './views/household.views';

/** A unit's household (ADR 0016): the primary or a delegate; managers approve. */
@ApiArea('household')
@Controller()
export class HouseholdController {
  constructor(
    private readonly households: HouseholdsService,
    private readonly permissions: PermissionsService,
    private readonly kinship: KinshipDocuments,
  ) {}

  /**
   * Members for everyone who sees the household; grants and invites for
   * the primary or a household delegate; the codes of what each member
   * holds for the management (a manager account holding `residents.read`).
   */
  @RequirePermissions('units.read')
  @Get('units/:unitId/household')
  @ApiOperation({ summary: "Get the unit's household" })
  @ApiOkResponse({ type: HouseholdResponse })
  async household(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<HouseholdResponse> {
    return HouseholdResponse.from(
      await this.households.household(unitId, {
        residentsRead: await this.permissions.has('residents.read'),
      }),
    );
  }

  /** The token is shown once; the invitee accepts with a code sent to the email. */
  @RequirePermissions('household.manage')
  @Post('units/:unitId/household/invites')
  @ApiOperation({ summary: 'Invite an adult to the household' })
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
  @ApiOperation({ summary: 'Revoke a household invite' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async revokeInvite(@Param('id', parseId()) id: string): Promise<void> {
    await this.households.revokeInvite(id);
  }

  @RequirePermissions('household.manage')
  @Post('units/:unitId/household/minors')
  @ApiOperation({ summary: 'Add a minor to the household' })
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
  @ApiOperation({ summary: 'List minors who turned 18' })
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
  @ApiOperation({
    summary: 'Invite a member who turned 18 to an account of their own',
  })
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
  @ApiOperation({ summary: 'Remove a household member' })
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
  @ApiOperation({ summary: 'List memberships waiting for approval' })
  @ApiOkResponse({ type: ListOf(PendingMemberView) })
  async pending(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<PendingMemberView>> {
    return toList(await this.households.pendingApprovals(q), (p) =>
      PendingMemberView.from(p),
    );
  }

  /** A pending member's proof of kinship, for the approver (no-store, ADR 0062). */
  @RequirePermissions('household.approve')
  @Get('household/members/:id/kinship-documents/:documentId')
  @ApiOperation({ summary: 'Read a pending member’s proof of kinship' })
  @NoStore()
  @ApiOkResponse({ type: KinshipDocumentReadView })
  async approverDocument(
    @Param('id', parseId()) id: string,
    @Param('documentId', parseId('documentId')) documentId: string,
  ): Promise<KinshipDocumentReadView> {
    return KinshipDocumentReadView.fromRead(
      await this.kinship.readForApprover(id, documentId),
    );
  }

  /** An invite's proof of kinship, for the inviter (no-store, ADR 0062). */
  @RequirePermissions('household.manage')
  @Get('household/invites/:id/kinship-documents/:documentId')
  @ApiOperation({ summary: 'Read an invite’s proof of kinship' })
  @NoStore()
  @ApiOkResponse({ type: KinshipDocumentReadView })
  async inviterDocument(
    @Param('id', parseId()) id: string,
    @Param('documentId', parseId('documentId')) documentId: string,
  ): Promise<KinshipDocumentReadView> {
    return KinshipDocumentReadView.fromRead(
      await this.kinship.readForInviter(id, documentId),
    );
  }

  @RequirePermissions('household.approve')
  @Post('household/members/:id/approve')
  @ApiOperation({ summary: 'Approve a household membership' })
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
  @ApiOperation({ summary: 'Reject a household membership' })
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
  @ApiOperation({ summary: 'Remove a household member (management decision)' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async removeByManagement(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<void> {
    await this.households.removeMemberByManagement(id, reasonOf(dto));
  }
}

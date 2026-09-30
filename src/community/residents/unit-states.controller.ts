import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { ReasonDto, reasonOf } from '../../core/common/http/reason.dto';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  ClearReviewFlagDto,
  MembersReviewedDto,
  TransferOwnershipDto,
} from './dto/unit-states.dto';
import { ResidentsService } from './residents.service';
import { OccupancyResponse } from './views/occupancy.views';
import {
  FlagCreatedView,
  MemberToReviewView,
  ReviewedView,
} from './views/unit-states.views';

/** Unit states (ADR 0021): death, separation, end of household, transfer. */
@ApiArea('unit-states')
@Controller()
export class UnitStatesController {
  constructor(private readonly residents: ResidentsService) {}

  /** Finance stops and permissions freeze until the capacity is settled. */
  @RequirePermissions('residents.manage')
  @Post('units/:id/deceased')
  @ApiCreatedResponse({ type: FlagCreatedView })
  deceased(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<FlagCreatedView> {
    return this.residents.markPrimaryDeceased(id, reasonOf(dto));
  }

  /** Revoking an adult's access becomes a manager decision. */
  @RequirePermissions('residents.manage')
  @Post('units/:id/separation')
  @ApiCreatedResponse({ type: FlagCreatedView })
  separation(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<FlagCreatedView> {
    return this.residents.tagSeparation(id, reasonOf(dto));
  }

  /** Death and separation flags; a primary who left needs a decision instead. */
  @RequirePermissions('residents.manage')
  @Post('review-flags/:id/clear')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async clear(
    @Param('id', parseId()) id: string,
    @Body() dto: ClearReviewFlagDto,
  ): Promise<void> {
    await this.residents.clearReviewFlag(id, dto.reasonCode ?? '');
  }

  /** Every membership, delegation and worker engagement of the unit ends. */
  @RequirePermissions('residents.manage')
  @Post('units/:id/end-household')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async endHousehold(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<void> {
    await this.residents.endHousehold(id, reasonOf(dto));
  }

  /** Every occupancy and the household end; the new owner's occupancy starts. */
  @RequirePermissions('residents.manage')
  @Post('units/:id/transfer-ownership')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: OccupancyResponse })
  async transferOwnership(
    @Param('id', parseId()) id: string,
    @Body() dto: TransferOwnershipDto,
  ): Promise<OccupancyResponse> {
    return OccupancyResponse.from(
      await this.residents.transferOwnership(
        id,
        { toAccountId: dto.toAccountId, resides: dto.resides },
        reasonOf(dto),
      ),
    );
  }

  /** For a new primary: members whose permissions predate them. */
  @RequirePermissions('household.manage')
  @Get('units/:id/household/to-review')
  @ApiOkResponse({ type: ListOf(MemberToReviewView) })
  async toReview(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<MemberToReviewView>> {
    return bounded(await this.residents.membersToReview(id), (m) =>
      MemberToReviewView.from(m),
    );
  }

  @RequirePermissions('household.manage')
  @Post('units/:id/household/reviewed')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ReviewedView })
  async reviewed(
    @Param('id', parseId()) id: string,
    @Body() dto: MembersReviewedDto,
  ): Promise<ReviewedView> {
    return {
      reviewed: await this.residents.markMembersReviewed(
        id,
        dto.all ? 'all' : dto.memberIds!,
      ),
    };
  }
}

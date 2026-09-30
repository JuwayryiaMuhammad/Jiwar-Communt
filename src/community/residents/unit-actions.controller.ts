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
import { ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { ClosedModeDto, SetPrimaryDto, UnitDetailDto } from './dto/units.dto';
import { ResidentsService } from './residents.service';
import {
  ActivationView,
  OccupancyResponse,
  UnitDetailView,
  UnitNeedingReviewView,
} from './views/occupancy.views';

/** One unit: its detail, its primary, and what the primary fills in. */
@ApiArea('units')
@Controller('units')
export class UnitActionsController {
  constructor(private readonly residents: ResidentsService) {}

  /** Open review flags, newest first; never the notes behind them. */
  @RequirePermissions('residents.read')
  @Get('needing-review')
  @ApiOkResponse({ type: ListOf(UnitNeedingReviewView) })
  async needingReview(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<UnitNeedingReviewView>> {
    return toList(await this.residents.unitsNeedingReview(q), (u) =>
      UnitNeedingReviewView.from(u),
    );
  }

  /** Managers also get the review reasons and the occupants. */
  @RequirePermissions('units.read')
  @Get(':id')
  @ApiOkResponse({ type: UnitDetailView })
  async get(@Param('id', parseId()) id: string): Promise<UnitDetailView> {
    return UnitDetailView.from(await this.residents.unitDetail(id));
  }

  @RequirePermissions('residents.manage')
  @Post(':id/primary')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: OccupancyResponse })
  async setPrimary(
    @Param('id', parseId()) id: string,
    @Body() dto: SetPrimaryDto,
  ): Promise<OccupancyResponse> {
    return OccupancyResponse.from(
      await this.residents.setPrimary(id, dto.accountId),
    );
  }

  /** The owner-resident primary only. */
  @RequirePermissions('household.manage')
  @Post(':id/closed-mode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async closedMode(
    @Param('id', parseId()) id: string,
    @Body() dto: ClosedModeDto,
  ): Promise<void> {
    await this.residents.setUnitClosed(id, dto.closed);
  }

  /** The details the primary may still fill in (the activation card). */
  @RequirePermissions('household.manage')
  @Get(':id/activation')
  @ApiOkResponse({ type: ActivationView })
  async activation(
    @Param('id', parseId()) id: string,
  ): Promise<ActivationView> {
    return { missing: await this.residents.missingActivationSteps(id) };
  }

  /** One missing detail; what the unit already knows always wins. */
  @RequirePermissions('household.manage')
  @Post(':id/details')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async details(
    @Param('id', parseId()) id: string,
    @Body() dto: UnitDetailDto,
  ): Promise<void> {
    await this.residents.submitUnitDetail(id, dto.step, dto.value);
  }
}

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { ReasonDto, reasonOf } from '../../core/common/http/reason.dto';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { ConvertToOwnerDto, HandoverDto, ResidenceDto } from './dto/units.dto';
import { ResidentsService } from './residents.service';
import { OccupancyResponse } from './views/occupancy.views';

/** A resident's place in a unit (ADR 0012, 0020), managed by the manager. */
@ApiArea('units')
@RequirePermissions('residents.manage')
@Controller('occupancies')
export class OccupanciesController {
  constructor(private readonly residents: ResidentsService) {}

  /** The occupant is told, with the reason text; the audit keeps the code. */
  @Post(':id/end')
  @ApiOperation({ summary: 'End an occupancy' })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: OccupancyResponse })
  async end(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<OccupancyResponse> {
    return OccupancyResponse.from(
      await this.residents.endOccupancy(id, reasonOf(dto)),
    );
  }

  /** Tenant → owner: a new owner row, the tenancy ended. */
  @Post(':id/convert-to-owner')
  @ApiOperation({ summary: 'Convert a tenant into an owner' })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: OccupancyResponse })
  async convertToOwner(
    @Param('id', parseId()) id: string,
    @Body() dto: ConvertToOwnerDto,
  ): Promise<OccupancyResponse> {
    return OccupancyResponse.from(
      await this.residents.convertToOwner(id, { resides: dto.resides }),
    );
  }

  /** An owner moves in (resides) or lets the unit (a landlord). */
  @Post(':id/residence')
  @ApiOperation({ summary: 'Set whether an owner lives in or lets the unit' })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: OccupancyResponse })
  async residence(
    @Param('id', parseId()) id: string,
    @Body() dto: ResidenceDto,
  ): Promise<OccupancyResponse> {
    return OccupancyResponse.from(
      await this.residents.setResidence(id, dto.resides),
    );
  }

  /**
   * The keys are back: the archive loses the emergency button, and a
   * planned move-out is done. With no clearance, a code says why
   * (MOVE_HANDOVER_REASON_REQUIRED otherwise; ADR 0063).
   */
  @Post(':id/handover')
  @ApiOperation({ summary: "Record the keys' handover" })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: OccupancyResponse })
  async handover(
    @Param('id', parseId()) id: string,
    @Body() dto: HandoverDto,
  ): Promise<OccupancyResponse> {
    return OccupancyResponse.from(
      await this.residents.recordHandover(id, dto.reasonCode),
    );
  }
}

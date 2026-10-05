import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  ManagerParcelsQueryDto,
  UpdateParcelSettingsDto,
} from './dto/parcels.dto';
import { ParcelSettingsService } from './parcel-settings.service';
import { ParcelsService } from './parcels.service';
import {
  ManagerParcelDetailView,
  ManagerParcelView,
  ParcelSettingsResponse,
} from './views/manager-parcel.views';

/**
 * The managers' parcels (ADR 0035): `parcels.manage`. Every parcel with its
 * unit and status; never the label's name, a delegate's name or a photo.
 */
@ApiArea('parcels')
@RequirePermissions('parcels.manage')
@Controller('parcels')
export class ManagerParcelsController {
  constructor(private readonly parcels: ParcelsService) {}

  @Get()
  @ApiOkResponse({ type: ListOf(ManagerParcelView) })
  async list(
    @Query() q: ManagerParcelsQueryDto,
  ): Promise<ListResponse<ManagerParcelView>> {
    return toList(await this.parcels.listForManager(q), (p) =>
      ManagerParcelView.from(p),
    );
  }

  @Get(':id')
  @ApiOkResponse({ type: ManagerParcelDetailView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<ManagerParcelDetailView> {
    return ManagerParcelDetailView.from(await this.parcels.getForManager(id));
  }
}

/** The compound's holding periods (ADR 0035). */
@ApiArea('parcels')
@RequirePermissions('parcels.manage')
@Controller('parcel-settings')
export class ParcelSettingsController {
  constructor(private readonly settings: ParcelSettingsService) {}

  @Get()
  @ApiOkResponse({ type: ParcelSettingsResponse })
  async get(): Promise<ParcelSettingsResponse> {
    return ParcelSettingsResponse.from(await this.settings.get());
  }

  @Patch()
  @ApiOkResponse({ type: ParcelSettingsResponse })
  async update(
    @Body() dto: UpdateParcelSettingsDto,
  ): Promise<ParcelSettingsResponse> {
    return ParcelSettingsResponse.from(await this.settings.update(dto));
  }
}

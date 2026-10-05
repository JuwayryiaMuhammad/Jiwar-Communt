import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { GateParcelsQueryDto, ReceiveParcelDto } from './dto/parcels.dto';
import { ParcelsService } from './parcels.service';
import { GateParcelDetailView, GateParcelView } from './views/parcel.views';

/**
 * The guard's parcels (ADR 0035): `parcels.handle`, inside an open shift
 * (`NO_OPEN_SHIFT` otherwise). The guard sees the unit, the carrier, the
 * pieces, the photo and the status: never a resident, the label or a code.
 */
@ApiArea('parcels')
@RequirePermissions('parcels.handle')
@Controller('gate/parcels')
export class GateParcelsController {
  constructor(private readonly parcels: ParcelsService) {}

  /** `Idempotency-Key`: a retry replays the same parcel. */
  @Post()
  @Idempotent()
  @ApiCreatedResponse({ type: GateParcelView })
  async receive(@Body() dto: ReceiveParcelDto): Promise<GateParcelView> {
    return GateParcelView.from(await this.parcels.receive(dto));
  }

  @Get()
  @ApiOkResponse({ type: ListOf(GateParcelView) })
  async list(
    @Query() q: GateParcelsQueryDto,
  ): Promise<ListResponse<GateParcelView>> {
    return toList(await this.parcels.listForGate(q), (p) =>
      GateParcelView.from(p),
    );
  }

  /** With the photos as short-lived URLs, so never cached. */
  @Get(':id')
  @NoStore()
  @ApiOkResponse({ type: GateParcelDetailView })
  async get(@Param('id', parseId()) id: string): Promise<GateParcelDetailView> {
    return GateParcelDetailView.from(await this.parcels.getForGate(id));
  }
}

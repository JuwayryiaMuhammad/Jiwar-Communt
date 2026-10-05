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
import { ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  GateParcelsQueryDto,
  HandOverParcelDto,
  ParcelCodeDto,
  ReceiveParcelDto,
} from './dto/parcels.dto';
import { ParcelHandover } from './parcel-handover.service';
import { ParcelsService } from './parcels.service';
import {
  GateParcelDetailView,
  GateParcelView,
  HandedOverParcelView,
  ParcelLookupView,
} from './views/parcel.views';

/**
 * The guard's parcels (ADR 0035): `parcels.handle`, inside an open shift
 * (`NO_OPEN_SHIFT` otherwise). The guard sees the unit, the carrier, the
 * pieces, the photo and the status: never a resident, the label or a code.
 */
@ApiArea('parcels')
@RequirePermissions('parcels.handle')
@Controller('gate/parcels')
export class GateParcelsController {
  constructor(
    private readonly parcels: ParcelsService,
    private readonly handover: ParcelHandover,
  ) {}

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

  /**
   * What a typed code or a scanned QR is, here and now (read-only, no
   * Idempotency-Key). Unknown, malformed, dead and foreign codes get one
   * answer; five wrong ones in ten minutes lock the guard out of codes.
   */
  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOkResponse({ type: ParcelLookupView })
  async lookup(@Body() dto: ParcelCodeDto): Promise<ParcelLookupView> {
    return ParcelLookupView.from(await this.handover.lookup(dto));
  }

  /**
   * Hands the parcel over, all pieces at once, by its code or QR, by an
   * eligible occupant's entry QR (nothing else is recorded about the scan)
   * or by a delegate's code. `Idempotency-Key`: a retry answers with the
   * parcel as it is.
   */
  @Post(':id/handover')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @Idempotent({ secret: true })
  @ApiOkResponse({ type: HandedOverParcelView })
  async handOver(
    @Param('id', parseId()) id: string,
    @Body() dto: HandOverParcelDto,
  ): Promise<HandedOverParcelView> {
    return HandedOverParcelView.from(await this.handover.handOver(id, dto));
  }

  /** To the carrier: a rejected parcel, or an unclaimed one after the holding period. */
  @Post(':id/return')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOkResponse({ type: GateParcelView })
  async markReturned(
    @Param('id', parseId()) id: string,
  ): Promise<GateParcelView> {
    return GateParcelView.from(await this.parcels.markReturned(id));
  }
}

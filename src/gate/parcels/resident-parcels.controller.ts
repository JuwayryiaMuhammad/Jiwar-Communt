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
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  AuthorizeDelegateDto,
  RejectParcelDto,
  ResidentParcelsQueryDto,
} from './dto/parcels.dto';
import { ResidentParcels } from './resident-parcels.service';
import { ResidentParcelView } from './views/resident-parcel.views';

/**
 * A resident's parcels (ADR 0035). No permission: the capability `parcels`
 * on the parcel's unit decides, and a caller who is not eligible gets
 * PARCEL_NOT_FOUND. Everything that carries a code, a name or a photo is
 * no-store; the idempotent writes store no body (it would hold them).
 */
@ApiArea('parcels')
@Controller('me/parcels')
export class ResidentParcelsController {
  constructor(private readonly parcels: ResidentParcels) {}

  @Get()
  @NoStore()
  @ApiOkResponse({ type: ListOf(ResidentParcelView) })
  async list(
    @Query() q: ResidentParcelsQueryDto,
  ): Promise<ListResponse<ResidentParcelView>> {
    return toList(await this.parcels.list(q), (p) =>
      ResidentParcelView.from(p),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOkResponse({ type: ResidentParcelView })
  async get(@Param('id', parseId()) id: string): Promise<ResidentParcelView> {
    return ResidentParcelView.from(await this.parcels.get(id));
  }

  /** "Not mine." `Idempotency-Key`: a retry answers with the parcel as it is. */
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @Idempotent({ secret: true })
  @ApiOkResponse({ type: ResidentParcelView })
  async reject(
    @Param('id', parseId()) id: string,
    @Body() dto: RejectParcelDto,
  ): Promise<ResidentParcelView> {
    return ResidentParcelView.from(
      await this.parcels.reject(id, dto.reasonCode),
    );
  }

  /** One delegate per parcel. A retry with the same key derives the same code. */
  @Post(':id/delegate')
  @NoStore()
  @Idempotent({ secret: true })
  @ApiCreatedResponse({ type: ResidentParcelView })
  async authorizeDelegate(
    @Param('id', parseId()) id: string,
    @Body() dto: AuthorizeDelegateDto,
  ): Promise<ResidentParcelView> {
    return ResidentParcelView.from(
      await this.parcels.authorizeDelegate(id, dto),
    );
  }

  @Post(':id/delegate/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async revokeDelegate(@Param('id', parseId()) id: string): Promise<void> {
    await this.parcels.revokeDelegate(id);
  }
}

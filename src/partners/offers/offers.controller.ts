import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { PublishOfferDto, StaffOffersQueryDto } from './dto/offers.dto';
import { PartnerOffersService } from './offers.service';
import { PartnerOfferView } from './views/offer.views';

/** The partners' offers, for the staff who keep the partners (ADR 0071). */
@ApiArea('partners')
@RequirePermissions('partners.manage')
@Controller('staff')
export class StaffPartnerOffersController {
  constructor(private readonly offers: PartnerOffersService) {}

  @Post('partners/:id/offers')
  @NoStore()
  @ApiOperation({ summary: 'Publish an offer of a partner' })
  @ApiCreatedResponse({ type: PartnerOfferView })
  async publish(
    @Param('id', parseId()) id: string,
    @Body() dto: PublishOfferDto,
  ): Promise<PartnerOfferView> {
    return PartnerOfferView.from(await this.offers.publish(id, dto));
  }

  @Get('partner-offers')
  @NoStore()
  @ApiOperation({ summary: 'List the partners’ offers' })
  @ApiOkResponse({ type: ListOf(PartnerOfferView) })
  async list(
    @Query() q: StaffOffersQueryDto,
  ): Promise<ListResponse<PartnerOfferView>> {
    return toList(await this.offers.staffList(q), (r) =>
      PartnerOfferView.from(r),
    );
  }

  @Post('partner-offers/:id/withdraw')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Withdraw an offer' })
  @ApiNoContentResponse()
  async withdraw(@Param('id', parseId()) id: string): Promise<void> {
    await this.offers.withdraw(id);
  }
}

/** The offers in force, on the market (ADR 0071). */
@ApiArea('market')
@RequirePermissions('market.post')
@Controller('market/offers')
export class MarketOffersController {
  constructor(private readonly offers: PartnerOffersService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the partners’ offers in force today' })
  @ApiOkResponse({ type: ListOf(PartnerOfferView) })
  async list(): Promise<ListResponse<PartnerOfferView>> {
    return bounded(await this.offers.inForce(), (r) =>
      PartnerOfferView.from(r),
    );
  }
}
